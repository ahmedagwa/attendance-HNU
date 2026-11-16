-- =====================================================================
-- Business functions. Everything that mutates attendance runs server-side:
-- execute is revoked from anon/authenticated and granted to service_role only.
-- =====================================================================

-- ---------- Atomic QR attendance commit --------------------------------------
-- Consumes the per-student attempt (single use) and inserts the attendance row in
-- one transaction. Row lock on the attempt serialises replays; the UNIQUE
-- constraints serialise duplicate student/installation inserts under concurrency.
create function public.commit_qr_attendance(
  p_attempt_id     uuid,
  p_student_id     uuid,
  p_credential_id  uuid,
  p_installation_id uuid,
  p_status         text,
  p_latitude       double precision,
  p_longitude      double precision,
  p_distance       real,
  p_accuracy       real,
  p_geo_result     text
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

  if not found then
    outcome := 'attempt_not_found'; record_id := null; status := null; return next; return;
  end if;
  if v_attempt.consumed_at is not null then
    outcome := 'attempt_consumed'; record_id := null; status := null; return next; return;
  end if;
  if v_attempt.expires_at <= now() then
    outcome := 'attempt_expired'; record_id := null; status := null; return next; return;
  end if;

  select * into v_session from public.sessions where id = v_attempt.session_id for share;
  if v_session.status is distinct from 'active' then
    outcome := 'session_closed'; record_id := null; status := null; return next; return;
  end if;

  -- 'auto' lets the database clock decide present vs late (same clock as attempt expiry).
  v_status := case
    when p_status = 'auto' then
      case when now() > v_session.started_at + make_interval(mins => v_session.late_threshold_minutes)
           then 'late' else 'present' end
    else p_status end;

  -- Burn the attempt first: it stays burnt even if the insert below is rejected.
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
    outcome := case v_constraint
      when 'attendance_one_installation_session' then 'duplicate_installation'
      else 'duplicate_student'
    end;
    return next; return;
  end;
end $$;

-- ---------- Attempt bookkeeping -------------------------------------------------
create function public.record_attempt_failure(p_attempt_id uuid, p_student_id uuid, p_max integer default 3)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.attendance_attempts
     set failure_count = failure_count + 1,
         consumed_at   = case when failure_count + 1 >= p_max then coalesce(consumed_at, now()) else consumed_at end
   where id = p_attempt_id and student_id = p_student_id and consumed_at is null
   returning failure_count into v_count;
  return coalesce(v_count, p_max);
end $$;

create function public.bump_geo_retry(p_attempt_id uuid, p_student_id uuid, p_max integer default 3)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.attendance_attempts
     set geo_retries = geo_retries + 1
   where id = p_attempt_id and student_id = p_student_id and consumed_at is null
   returning geo_retries into v_count;
  return coalesce(v_count, p_max);
end $$;

-- ---------- Rate limiting (fixed window, shared across serverless instances) -------
create function public.rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  return v_hits <= p_max;
end $$;

create function public.purge_rate_limits() returns integer
language sql security definer set search_path = '' as $$
  with d as (delete from public.rate_limits where window_start < now() - interval '1 hour' returning 1)
  select count(*)::integer from d;
$$;

-- ---------- Reporting ----------------------------------------------------------------
create function public.attendance_summary(p_student_id uuid)
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
      select count(*) as held from public.sessions x
       where x.subject_id = e.subject_id and x.status = 'closed'
         and (x.group_id is null or x.group_id = e.group_id)
    ) h on true
    left join lateral (
      select count(*) as attended
        from public.attendance_records r
        join public.sessions x on x.id = r.session_id
       where r.student_id = e.student_id and x.subject_id = e.subject_id
         and x.status = 'closed' and r.status in ('present', 'late')
    ) a on true
   where e.student_id = p_student_id
   order by s.code;
$$;

create function public.session_summary(p_session_id uuid)
returns table (enrolled integer, present integer, late integer, manual integer, review integer, absent integer, open_flags integer)
language sql stable security definer set search_path = '' as $$
  with s as (select * from public.sessions where id = p_session_id),
  e as (
    select count(*)::integer as n from public.enrollments en, s
     where en.subject_id = s.subject_id and (s.group_id is null or en.group_id = s.group_id)
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

-- ---------- Privacy: purge raw coordinates after the review window ------------------------
create function public.purge_raw_gps(p_retention interval default interval '30 days')
returns integer language sql security definer set search_path = '' as $$
  with d as (
    update public.attendance_records r
       set latitude = null, longitude = null
     where r.checked_in_at < now() - p_retention
       and (r.latitude is not null or r.longitude is not null)
       and not exists (
         select 1 from public.attendance_flags f
          where f.session_id = r.session_id and f.student_id = r.student_id and f.status = 'open'
       )
    returning 1
  )
  select count(*)::integer from d;
$$;

-- ---------- Privileges: server-only functions ----------------------------------------------
revoke all on function public.commit_qr_attendance(uuid, uuid, uuid, uuid, text, double precision, double precision, real, real, text) from public, anon, authenticated;
revoke all on function public.record_attempt_failure(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.bump_geo_retry(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.purge_rate_limits() from public, anon, authenticated;
revoke all on function public.attendance_summary(uuid) from public, anon, authenticated;
revoke all on function public.session_summary(uuid) from public, anon, authenticated;
revoke all on function public.purge_raw_gps(interval) from public, anon, authenticated;

grant execute on function public.commit_qr_attendance(uuid, uuid, uuid, uuid, text, double precision, double precision, real, real, text) to service_role;
grant execute on function public.record_attempt_failure(uuid, uuid, integer) to service_role;
grant execute on function public.bump_geo_retry(uuid, uuid, integer) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.purge_rate_limits() to service_role;
grant execute on function public.attendance_summary(uuid) to service_role;
grant execute on function public.session_summary(uuid) to service_role;
grant execute on function public.purge_raw_gps(interval) to service_role;
