-- =====================================================================
-- Row Level Security — implements the policy matrix from the report (§5.3).
-- Browser clients only ever SELECT. Every write goes through server route
-- handlers that derive identity from the verified Supabase session and use
-- the server-only secret key (which bypasses RLS by design).
-- =====================================================================

-- ---------- Helper predicates (SECURITY DEFINER avoids RLS recursion) --------------
create function public.app_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = (select auth.uid()) and account_status = 'active'
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.app_role() = 'admin', false)
$$;

create function public.teaches_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.subjects s
                  where s.id = p_subject and s.lecturer_id = (select auth.uid()))
$$;

create function public.manages_session(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sessions s join public.subjects sub on sub.id = s.subject_id
     where s.id = p_session
       and (s.started_by = (select auth.uid()) or sub.lecturer_id = (select auth.uid()))
  )
$$;

create function public.enrolled_in(p_subject uuid, p_group uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.enrollments e
     where e.student_id = (select auth.uid()) and e.subject_id = p_subject
       and (p_group is null or e.group_id = p_group)
  )
$$;

create function public.sees_group(p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.enrollments e
                  where e.group_id = p_group and e.student_id = (select auth.uid()))
      or exists (select 1 from public.enrollments e join public.subjects s on s.id = e.subject_id
                  where e.group_id = p_group and s.lecturer_id = (select auth.uid()))
$$;

create function public.lecturer_teaches_student(p_student uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.enrollments e join public.subjects s on s.id = e.subject_id
                  where e.student_id = p_student and s.lecturer_id = (select auth.uid()))
$$;

revoke all on function public.app_role(), public.is_admin(), public.teaches_subject(uuid),
  public.manages_session(uuid), public.enrolled_in(uuid, uuid), public.sees_group(uuid),
  public.lecturer_teaches_student(uuid) from public, anon;
grant execute on function public.app_role(), public.is_admin(), public.teaches_subject(uuid),
  public.manages_session(uuid), public.enrolled_in(uuid, uuid), public.sees_group(uuid),
  public.lecturer_teaches_student(uuid) to authenticated, service_role;

-- ---------- Deny by default, then grant SELECT on exposed tables only ---------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

alter table public.profiles                  enable row level security;
alter table public.student_groups            enable row level security;
alter table public.subjects                  enable row level security;
alter table public.enrollments               enable row level security;
alter table public.halls                     enable row level security;
alter table public.class_schedules           enable row level security;
alter table public.sessions                  enable row level security;
alter table public.webauthn_credentials      enable row level security;   -- no policies: server only
alter table public.device_installations      enable row level security;   -- no policies: server only
alter table public.attendance_attempts       enable row level security;   -- no policies: server only
alter table public.attendance_records        enable row level security;
alter table public.attendance_flags          enable row level security;
alter table public.reverification_challenges enable row level security;
alter table public.reverification_responses  enable row level security;
alter table public.audit_logs                enable row level security;
alter table public.rate_limits               enable row level security;   -- no policies: server only

-- Column-level grants keep secrets out of browser reach even where a row is visible.
grant select on public.profiles, public.student_groups, public.subjects, public.enrollments,
                public.class_schedules, public.attendance_flags, public.reverification_responses,
                public.audit_logs to authenticated;
grant select (id, name, allowed_radius_meters, is_active) on public.halls to authenticated;            -- never lat/lng
grant select (id, subject_id, group_id, hall_id, started_by, status, started_at, ended_at,
              late_threshold_minutes, qr_period_seconds) on public.sessions to authenticated;          -- never qr_secret_enc
grant select (id, session_id, student_id, status, source, geo_result, distance_meters,
              checked_in_at, manual_reason, recorded_by) on public.attendance_records to authenticated; -- never raw GPS / ids
grant select (id, session_id, prompt_type, issued_at, expires_at) on public.reverification_challenges to authenticated; -- never the answer

-- profiles
create policy profiles_self     on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_lecturer on public.profiles for select to authenticated
  using (public.app_role() = 'lecturer' and public.lecturer_teaches_student(id));
create policy profiles_admin    on public.profiles for select to authenticated using (public.is_admin());

-- subjects / enrollments
create policy subjects_student  on public.subjects for select to authenticated using (public.enrolled_in(id));
create policy subjects_lecturer on public.subjects for select to authenticated using (lecturer_id = (select auth.uid()));
create policy subjects_admin    on public.subjects for select to authenticated using (public.is_admin());

create policy enrollments_student  on public.enrollments for select to authenticated using (student_id = (select auth.uid()));
create policy enrollments_lecturer on public.enrollments for select to authenticated using (public.teaches_subject(subject_id));
create policy enrollments_admin    on public.enrollments for select to authenticated using (public.is_admin());

-- groups / halls / schedules
create policy groups_related on public.student_groups for select to authenticated using (public.sees_group(id));
create policy groups_admin   on public.student_groups for select to authenticated using (public.is_admin());

create policy halls_student on public.halls for select to authenticated using (
  exists (select 1 from public.class_schedules cs
           where cs.hall_id = halls.id and public.enrolled_in(cs.subject_id, cs.group_id)));
create policy halls_staff on public.halls for select to authenticated
  using (is_active and public.app_role() in ('lecturer', 'admin'));
create policy halls_admin on public.halls for select to authenticated using (public.is_admin());

create policy schedules_student  on public.class_schedules for select to authenticated using (public.enrolled_in(subject_id, group_id));
create policy schedules_lecturer on public.class_schedules for select to authenticated using (public.teaches_subject(subject_id));
create policy schedules_admin    on public.class_schedules for select to authenticated using (public.is_admin());

-- sessions
create policy sessions_student  on public.sessions for select to authenticated using (public.enrolled_in(subject_id, group_id));
create policy sessions_lecturer on public.sessions for select to authenticated using (public.manages_session(id));
create policy sessions_admin    on public.sessions for select to authenticated using (public.is_admin());

-- attendance records / flags
create policy records_student  on public.attendance_records for select to authenticated using (student_id = (select auth.uid()));
create policy records_lecturer on public.attendance_records for select to authenticated using (public.manages_session(session_id));
create policy records_admin    on public.attendance_records for select to authenticated using (public.is_admin());

create policy flags_lecturer on public.attendance_flags for select to authenticated using (public.manages_session(session_id));
create policy flags_admin    on public.attendance_flags for select to authenticated using (public.is_admin());

-- spot checks
create policy reverif_student on public.reverification_challenges for select to authenticated
  using (exists (select 1 from public.attendance_records r
                  where r.session_id = reverification_challenges.session_id and r.student_id = (select auth.uid())));
create policy reverif_lecturer on public.reverification_challenges for select to authenticated using (public.manages_session(session_id));
create policy reverif_admin    on public.reverification_challenges for select to authenticated using (public.is_admin());

create policy reverif_resp_student  on public.reverification_responses for select to authenticated using (student_id = (select auth.uid()));
create policy reverif_resp_lecturer on public.reverification_responses for select to authenticated
  using (exists (select 1 from public.reverification_challenges c
                  where c.id = reverification_responses.challenge_id and public.manages_session(c.session_id)));
create policy reverif_resp_admin    on public.reverification_responses for select to authenticated using (public.is_admin());

-- audit log: admins read; nobody updates or deletes (trigger enforces it even for service_role)
create policy audit_admin on public.audit_logs for select to authenticated using (public.is_admin());
