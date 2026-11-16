-- Server-clock attempt creation (QR window and attempt TTL share the database clock) and
-- short-lived storage for WebAuthn *registration* challenges.

create table public.webauthn_registration_challenges (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  challenge  text not null,
  expires_at timestamptz not null
);
alter table public.webauthn_registration_challenges enable row level security;   -- server only, no policies

create function public.create_attendance_attempt(
  p_session_id uuid, p_student_id uuid, p_challenge text, p_qr_bucket bigint, p_ttl_seconds integer default 45
) returns table (attempt_id uuid, expires_at timestamptz)
language sql security definer set search_path = '' as $$
  insert into public.attendance_attempts (session_id, student_id, challenge, qr_bucket, expires_at)
  values (p_session_id, p_student_id, p_challenge, p_qr_bucket, now() + make_interval(secs => p_ttl_seconds))
  returning id, attendance_attempts.expires_at;
$$;

create function public.create_reverification(p_session_id uuid, p_issued_by uuid, p_code text, p_ttl_seconds integer default 20)
returns table (challenge_id uuid, expires_at timestamptz)
language sql security definer set search_path = '' as $$
  insert into public.reverification_challenges (session_id, prompt_type, prompt_payload, issued_by, expires_at)
  values (p_session_id, 'code', jsonb_build_object('code', p_code), p_issued_by, now() + make_interval(secs => p_ttl_seconds))
  returning id, reverification_challenges.expires_at;
$$;

create function public.db_now() returns timestamptz language sql stable security definer set search_path = '' as $$ select now() $$;

revoke all on function public.create_attendance_attempt(uuid, uuid, text, bigint, integer) from public, anon, authenticated;
revoke all on function public.create_reverification(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.db_now() from public, anon, authenticated;
grant execute on function public.create_attendance_attempt(uuid, uuid, text, bigint, integer) to service_role;
grant execute on function public.create_reverification(uuid, uuid, text, integer) to service_role;
grant execute on function public.db_now() to service_role;
