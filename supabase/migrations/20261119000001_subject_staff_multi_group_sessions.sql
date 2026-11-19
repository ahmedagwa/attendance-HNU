-- =====================================================================
-- Subject teaching teams + sessions covering one or many student groups.
-- Backwards-compatible: subjects.lecturer_id and sessions.group_id remain
-- as legacy mirrors; new application code uses subject_staff/session_groups.
-- =====================================================================

-- A subject has at most one professor and any number of teaching assistants.
create table public.subject_staff (
  subject_id       uuid not null references public.subjects(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  assignment_role  text not null check (assignment_role in ('professor', 'teaching_assistant')),
  assigned_by      uuid references public.profiles(id) on delete set null,
  assigned_at      timestamptz not null default now(),
  primary key (subject_id, user_id)
);
create unique index subject_staff_one_professor_idx
  on public.subject_staff(subject_id)
  where assignment_role = 'professor';
create index subject_staff_user_idx on public.subject_staff(user_id, subject_id);

-- Preserve all existing single-lecturer assignments as professor assignments.
insert into public.subject_staff(subject_id, user_id, assignment_role)
select id, lecturer_id, 'professor'
from public.subjects
where lecturer_id is not null
on conflict (subject_id, user_id) do nothing;

-- A session can target one or many groups. This is now the authoritative scope.
create table public.session_groups (
  session_id uuid not null references public.sessions(id) on delete cascade,
  group_id   uuid not null references public.student_groups(id) on delete restrict,
  primary key (session_id, group_id)
);
create index session_groups_group_idx on public.session_groups(group_id, session_id);

-- Migrate legacy single-group sessions and legacy NULL=all-enrolled-groups sessions.
insert into public.session_groups(session_id, group_id)
select s.id, s.group_id
from public.sessions s
where s.group_id is not null
on conflict do nothing;

insert into public.session_groups(session_id, group_id)
select s.id, e.group_id
from public.sessions s
join public.enrollments e on e.subject_id = s.subject_id
where s.group_id is null
on conflict do nothing;

-- New assignment helpers are server-only and are called by admin API routes.
create or replace function public.assign_subject_staff(
  p_subject_id uuid,
  p_user_id uuid,
  p_assignment_role text,
  p_assigned_by uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_existing_role text;
begin
  if not exists (select 1 from public.profiles where id = p_assigned_by and role = 'admin' and account_status = 'active') then
    return 'not_admin';
  end if;
  if p_assignment_role not in ('professor', 'teaching_assistant') then
    return 'invalid_role';
  end if;
  if not exists (select 1 from public.subjects where id = p_subject_id) then
    return 'subject_not_found';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_user_id and role = 'lecturer' and account_status = 'active'
  ) then
    return 'invalid_staff';
  end if;

  select assignment_role into v_existing_role
  from public.subject_staff
  where subject_id = p_subject_id and user_id = p_user_id;

  if v_existing_role is not null then
    if v_existing_role = p_assignment_role then return 'already_assigned'; end if;
    return 'role_conflict';
  end if;

  if p_assignment_role = 'professor' and exists (
    select 1 from public.subject_staff
    where subject_id = p_subject_id and assignment_role = 'professor'
  ) then
    return 'professor_exists';
  end if;

  insert into public.subject_staff(subject_id, user_id, assignment_role, assigned_by)
  values (p_subject_id, p_user_id, p_assignment_role, p_assigned_by);

  -- Keep the old column populated for older reports/clients during migration.
  if p_assignment_role = 'professor' then
    update public.subjects set lecturer_id = p_user_id where id = p_subject_id;
  end if;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
  values (p_assigned_by, 'subject_staff.assigned', 'subject', p_subject_id::text,
          jsonb_build_object('user_id', p_user_id, 'assignment_role', p_assignment_role));
  return 'assigned';
end $$;

create or replace function public.remove_subject_staff(
  p_subject_id uuid,
  p_user_id uuid,
  p_removed_by uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
begin
  if not exists (select 1 from public.profiles where id = p_removed_by and role = 'admin' and account_status = 'active') then
    return 'not_admin';
  end if;
  select assignment_role into v_role
  from public.subject_staff
  where subject_id = p_subject_id and user_id = p_user_id
  for update;
  if v_role is null then return 'not_found'; end if;

  delete from public.subject_staff
  where subject_id = p_subject_id and user_id = p_user_id;

  if v_role = 'professor' then
    update public.subjects set lecturer_id = null
    where id = p_subject_id and lecturer_id = p_user_id;
  end if;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
  values (p_removed_by, 'subject_staff.removed', 'subject', p_subject_id::text,
          jsonb_build_object('user_id', p_user_id, 'assignment_role', v_role));
  return 'removed';
end $$;

-- Atomic session creation: serialize by subject, validate staff/group/hall,
-- reject overlapping active sessions, then create the session and group links.
create or replace function public.create_lecture_session(
  p_subject_id uuid,
  p_group_ids uuid[],
  p_hall_id uuid,
  p_started_by uuid,
  p_late_threshold_minutes integer,
  p_qr_period_seconds integer,
  p_qr_secret_enc text
) returns table (session_id uuid, outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_valid_groups integer;
  v_clash uuid;
  v_session_id uuid;
  v_legacy_group_id uuid;
begin
  if p_group_ids is null or cardinality(p_group_ids) < 1 or cardinality(p_group_ids) > 20 then
    raise exception 'Select at least one group.' using errcode = '22023';
  end if;
  if (select count(distinct g.group_id) from unnest(p_group_ids) as g(group_id)) <> cardinality(p_group_ids) then
    raise exception 'Duplicate group selection.' using errcode = '22023';
  end if;
  if p_late_threshold_minutes < 0 or p_late_threshold_minutes > 180 then
    raise exception 'Invalid late threshold.' using errcode = '22023';
  end if;
  if p_qr_period_seconds < 3 or p_qr_period_seconds > 30 then
    raise exception 'Invalid QR period.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_subject_id::text, 0));

  if not exists (select 1 from public.subjects where id = p_subject_id and is_active) then
    raise exception 'Subject is unavailable.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_started_by and role = 'lecturer' and account_status = 'active'
  ) then
    raise exception 'An active lecturer account is required to start a session.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.subject_staff
    where subject_id = p_subject_id and user_id = p_started_by
  ) then
    raise exception 'You are not assigned to this subject.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.halls where id = p_hall_id and is_active) then
    raise exception 'Choose an active lecture hall.' using errcode = '22023';
  end if;

  select count(distinct e.group_id)::integer into v_valid_groups
  from public.enrollments e
  where e.subject_id = p_subject_id
    and e.group_id = any(p_group_ids);
  if v_valid_groups <> cardinality(p_group_ids) then
    raise exception 'Each selected group must have enrolled students in this subject.' using errcode = '22023';
  end if;

  select s.id into v_clash
  from public.sessions s
  join public.session_groups sg on sg.session_id = s.id
  where s.subject_id = p_subject_id
    and s.status in ('active', 'paused')
    and sg.group_id = any(p_group_ids)
  order by s.started_at desc
  limit 1;

  if v_clash is not null then
    return query select v_clash, 'session_already_open'::text;
    return;
  end if;

  v_legacy_group_id := case when cardinality(p_group_ids) = 1 then p_group_ids[1] else null end;
  insert into public.sessions(
    subject_id, group_id, hall_id, started_by, late_threshold_minutes,
    qr_period_seconds, qr_secret_enc
  ) values (
    p_subject_id, v_legacy_group_id, p_hall_id, p_started_by,
    p_late_threshold_minutes, p_qr_period_seconds, p_qr_secret_enc
  ) returning id into v_session_id;

  insert into public.session_groups(session_id, group_id)
  select v_session_id, g.group_id from unnest(p_group_ids) as g(group_id);

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
  values (p_started_by, 'session.started', 'session', v_session_id::text,
          jsonb_build_object('subject_id', p_subject_id, 'group_ids', to_jsonb(p_group_ids), 'hall_id', p_hall_id));

  return query select v_session_id, 'created'::text;
end $$;

-- Replace policy helper functions to use the teaching-team relation.
create or replace function public.teaches_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.subject_staff ss
    where ss.subject_id = p_subject and ss.user_id = (select auth.uid())
  )
$$;

create or replace function public.manages_session(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sessions s
    where s.id = p_session
      and (
        s.started_by = (select auth.uid())
        or exists (select 1 from public.subject_staff ss where ss.subject_id = s.subject_id and ss.user_id = (select auth.uid()))
      )
  )
$$;

create or replace function public.sees_group(p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.enrollments e
    where e.group_id = p_group and e.student_id = (select auth.uid())
  ) or exists (
    select 1 from public.enrollments e
    join public.subject_staff ss on ss.subject_id = e.subject_id
    where e.group_id = p_group and ss.user_id = (select auth.uid())
  )
$$;

create or replace function public.lecturer_teaches_student(p_student uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.enrollments e
    join public.subject_staff ss on ss.subject_id = e.subject_id
    where e.student_id = p_student and ss.user_id = (select auth.uid())
  )
$$;

create or replace function public.student_in_session(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.sessions s
    join public.session_groups sg on sg.session_id = s.id
    join public.enrollments e on e.subject_id = s.subject_id and e.group_id = sg.group_id
    where s.id = p_session and e.student_id = (select auth.uid())
  )
$$;

-- Group-aware attendance percentages: each enrolled student is counted only
-- against sessions that explicitly include that student's group.
create or replace function public.attendance_summary(p_student_id uuid)
returns table (
  subject_id uuid, subject_code text, subject_name text, required_percent integer,
  sessions_held integer, attended integer, percent numeric, below_limit boolean
)
language sql stable security definer set search_path = '' as $$
  select s.id, s.code, s.name, s.attendance_required_percent,
         coalesce(h.held, 0)::integer,
         coalesce(a.attended, 0)::integer,
         case when coalesce(h.held, 0) = 0 then 100::numeric
              else round(100.0 * coalesce(a.attended, 0) / h.held, 1) end,
         (case when coalesce(h.held, 0) = 0 then 100.0
               else 100.0 * coalesce(a.attended, 0) / h.held end) < s.attendance_required_percent
    from public.enrollments e
    join public.subjects s on s.id = e.subject_id and s.is_active
    left join lateral (
      select count(*) as held
      from public.sessions x
      join public.session_groups xg on xg.session_id = x.id and xg.group_id = e.group_id
      where x.subject_id = e.subject_id and x.status = 'closed'
    ) h on true
    left join lateral (
      select count(*) as attended
      from public.attendance_records r
      join public.sessions x on x.id = r.session_id
      join public.session_groups xg on xg.session_id = x.id and xg.group_id = e.group_id
      where r.student_id = e.student_id and x.subject_id = e.subject_id
        and x.status = 'closed' and r.status in ('present', 'late')
    ) a on true
   where e.student_id = p_student_id
   order by s.code;
$$;

create or replace function public.session_summary(p_session_id uuid)
returns table (enrolled integer, present integer, late integer, manual integer, review integer, absent integer, open_flags integer)
language sql stable security definer set search_path = '' as $$
  with s as (select * from public.sessions where id = p_session_id),
  e as (
    select count(*)::integer as n
    from public.enrollments en
    join s on en.subject_id = s.subject_id
    join public.session_groups sg on sg.session_id = s.id and sg.group_id = en.group_id
  ),
  r as (
    select count(*) filter (where status = 'present')::integer as present,
           count(*) filter (where status = 'late')::integer    as late,
           count(*) filter (where source = 'manual' and status in ('present', 'late'))::integer as manual,
           count(*) filter (where status = 'review')::integer  as review
      from public.attendance_records where session_id = p_session_id
  ),
  f as (select count(*)::integer as n from public.attendance_flags where session_id = p_session_id and status = 'open')
  select e.n, r.present, r.late, r.manual, r.review,
         greatest(e.n - r.present - r.late - r.review, 0), f.n
    from e, r, f;
$$;

-- Enforce group eligibility again inside the same transaction that inserts attendance.
create or replace function public.commit_qr_attendance(
  p_attempt_id uuid,
  p_student_id uuid,
  p_credential_id uuid,
  p_installation_id uuid,
  p_status text,
  p_latitude double precision,
  p_longitude double precision,
  p_distance real,
  p_accuracy real,
  p_geo_result text
) returns table (outcome text, record_id uuid, status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.attendance_attempts%rowtype;
  v_session public.sessions%rowtype;
  v_status text;
  v_constraint text;
begin
  select * into v_attempt
    from public.attendance_attempts
   where id = p_attempt_id and student_id = p_student_id
   for update;
  if not found then outcome := 'attempt_not_found'; record_id := null; status := null; return next; return; end if;
  if v_attempt.consumed_at is not null then outcome := 'attempt_consumed'; record_id := null; status := null; return next; return; end if;
  if v_attempt.expires_at <= now() then outcome := 'attempt_expired'; record_id := null; status := null; return next; return; end if;

  select * into v_session from public.sessions where id = v_attempt.session_id for share;
  if v_session.status is distinct from 'active' then outcome := 'session_closed'; record_id := null; status := null; return next; return; end if;

  if not exists (
    select 1
    from public.enrollments e
    join public.session_groups sg on sg.session_id = v_session.id and sg.group_id = e.group_id
    where e.subject_id = v_session.subject_id and e.student_id = p_student_id
  ) then
    -- Eligibility may change while the student's 45-second challenge is open.
    -- Burn this attempt so the same assertion cannot be replayed after re-enrolment.
    update public.attendance_attempts set consumed_at = now() where id = p_attempt_id;
    outcome := 'not_eligible'; record_id := null; status := null; return next; return;
  end if;

  v_status := case
    when p_status = 'auto' then
      case when now() > v_session.started_at + make_interval(mins => v_session.late_threshold_minutes)
           then 'late' else 'present' end
    else p_status end;

  update public.attendance_attempts set consumed_at = now() where id = p_attempt_id;
  begin
    insert into public.attendance_records (
      session_id, student_id, status, source, attempt_id, credential_id, device_installation_id,
      latitude, longitude, distance_meters, gps_accuracy_meters, geo_result
    ) values (
      v_attempt.session_id, p_student_id, v_status, 'qr', p_attempt_id, p_credential_id, p_installation_id,
      p_latitude, p_longitude, p_distance, p_accuracy, p_geo_result
    ) returning id into record_id;
    outcome := 'committed'; status := v_status;
    return next; return;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    record_id := null; status := null;
    outcome := case v_constraint when 'attendance_one_installation_session' then 'duplicate_installation' else 'duplicate_student' end;
    return next; return;
  end;
end $$;

-- Protect and expose the new relationship tables deliberately.
alter table public.subject_staff enable row level security;
alter table public.session_groups enable row level security;
revoke all on public.subject_staff, public.session_groups from anon, authenticated;
grant select on public.subject_staff, public.session_groups to authenticated;
grant all on public.subject_staff, public.session_groups to service_role;
create policy subject_staff_self on public.subject_staff for select to authenticated
  using (user_id = (select auth.uid()));
create policy subject_staff_admin on public.subject_staff for select to authenticated
  using (public.is_admin());
create policy session_groups_student on public.session_groups for select to authenticated
  using (exists (
    select 1 from public.sessions s
    join public.enrollments e on e.subject_id = s.subject_id and e.group_id = session_groups.group_id
    where s.id = session_groups.session_id and e.student_id = (select auth.uid())
  ));
create policy session_groups_staff on public.session_groups for select to authenticated
  using (public.manages_session(session_id));
create policy session_groups_admin on public.session_groups for select to authenticated
  using (public.is_admin());

-- Replace existing policies which used the single lecturer_id/group_id columns.
drop policy if exists subjects_lecturer on public.subjects;
create policy subjects_lecturer on public.subjects for select to authenticated
  using (public.teaches_subject(id));

drop policy if exists sessions_student on public.sessions;
create policy sessions_student on public.sessions for select to authenticated
  using (public.student_in_session(id));

-- Make all new server-side helpers/functions callable only through service_role.
revoke all on function public.assign_subject_staff(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.remove_subject_staff(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_lecture_session(uuid, uuid[], uuid, uuid, integer, integer, text) from public, anon, authenticated;
revoke all on function public.student_in_session(uuid) from public, anon;
grant execute on function public.assign_subject_staff(uuid, uuid, text, uuid) to service_role;
grant execute on function public.remove_subject_staff(uuid, uuid, uuid) to service_role;
grant execute on function public.create_lecture_session(uuid, uuid[], uuid, uuid, integer, integer, text) to service_role;
grant execute on function public.student_in_session(uuid) to authenticated, service_role;

-- Existing server-only functions were already granted to service_role by earlier migrations.
