-- =====================================================================
-- University Attendance PWA — core schema (PostgreSQL / Supabase)
-- All timestamps are timestamptz (UTC). Render in Africa/Cairo in the UI.
-- =====================================================================

-- ---------- Identity & academic data ----------------------------------
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  university_id  text not null unique,
  full_name      text not null,
  role           text not null check (role in ('student', 'lecturer', 'admin')),
  account_status text not null default 'active' check (account_status in ('active', 'suspended')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.student_groups (
  id            uuid primary key default gen_random_uuid(),
  group_code    text not null unique,
  name          text not null,
  academic_year text not null
);

create table public.subjects (
  id                          uuid primary key default gen_random_uuid(),
  code                        text not null unique,
  name                        text not null,
  lecturer_id                 uuid references public.profiles (id) on delete set null,
  attendance_required_percent integer not null default 75 check (attendance_required_percent between 0 and 100),
  is_active                   boolean not null default true
);

create table public.enrollments (
  subject_id uuid not null references public.subjects (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  group_id   uuid not null references public.student_groups (id) on delete restrict,
  primary key (subject_id, student_id)          -- no duplicate enrollment
);
create index enrollments_student_idx on public.enrollments (student_id);
create index enrollments_group_idx   on public.enrollments (subject_id, group_id);

create table public.halls (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null unique,
  latitude                 double precision not null check (latitude between -90 and 90),
  longitude                double precision not null check (longitude between -180 and 180),
  allowed_radius_meters    integer not null default 75 check (allowed_radius_meters > 0),
  max_gps_accuracy_meters  integer not null default 100 check (max_gps_accuracy_meters > 0),
  is_active                boolean not null default true
);

create table public.class_schedules (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references public.subjects (id) on delete cascade,
  group_id    uuid not null references public.student_groups (id) on delete cascade,
  hall_id     uuid not null references public.halls (id) on delete restrict,
  weekday     smallint not null check (weekday between 0 and 6),   -- 0 = Sunday
  start_time  time not null,
  end_time    time not null check (end_time > start_time),
  valid_from  date,
  valid_to    date
);
create index class_schedules_lookup_idx on public.class_schedules (subject_id, group_id);

-- ---------- Sessions ---------------------------------------------------
create table public.sessions (
  id                    uuid primary key default gen_random_uuid(),
  subject_id            uuid not null references public.subjects (id) on delete restrict,
  group_id              uuid references public.student_groups (id) on delete restrict,   -- null = all enrolled groups
  hall_id               uuid not null references public.halls (id) on delete restrict,
  started_by            uuid not null references public.profiles (id) on delete restrict,
  status                text not null default 'active' check (status in ('active', 'paused', 'closed')),
  started_at            timestamptz not null default now(),
  ended_at              timestamptz,
  late_threshold_minutes integer not null default 15 check (late_threshold_minutes >= 0),
  qr_period_seconds     integer not null default 10 check (qr_period_seconds between 3 and 30),
  qr_secret_enc         text not null,         -- AES-256-GCM(QR_MASTER_KEY); never exposed to clients
  check ((status = 'closed') = (ended_at is not null))
);
create index sessions_subject_idx on public.sessions (subject_id, started_at desc);
create index sessions_manager_idx on public.sessions (started_by, started_at desc);

-- ---------- Passkeys & installations ------------------------------------
create table public.webauthn_credentials (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  credential_id  text not null unique,         -- no credential reuse across accounts
  public_key     bytea not null,               -- public data only; private key stays on the authenticator
  sign_count     bigint not null default 0,
  transports     text[],
  device_type    text,                         -- 'singleDevice' | 'multiDevice'
  backup_eligible boolean,
  backed_up      boolean,
  nickname       text,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);
create index webauthn_credentials_user_idx on public.webauthn_credentials (user_id) where revoked_at is null;

-- Browser-installation signal (NOT a hardware identity). One row per hash, owned by the
-- first account that registered it, so UNIQUE(session_id, device_installation_id) on
-- attendance_records really does stop one browser from checking in two accounts.
create table public.device_installations (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles (id) on delete cascade,
  installation_id_hash  text not null unique,
  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  revoked_at            timestamptz
);
create index device_installations_user_idx on public.device_installations (user_id);

-- ---------- Attendance ---------------------------------------------------
create table public.attendance_attempts (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.sessions (id) on delete cascade,
  student_id    uuid not null references public.profiles (id) on delete cascade,
  challenge     text not null unique,          -- WebAuthn challenge, unique per attempt (never per lecture)
  qr_bucket     bigint not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  failure_count integer not null default 0,
  geo_retries   integer not null default 0
);
create index attendance_attempts_student_idx on public.attendance_attempts (session_id, student_id, created_at desc);

create table public.attendance_records (
  id                     uuid primary key default gen_random_uuid(),
  session_id             uuid not null references public.sessions (id) on delete cascade,
  student_id             uuid not null references public.profiles (id) on delete cascade,
  status                 text not null check (status in ('present', 'late', 'review', 'rejected')),
  source                 text not null check (source in ('qr', 'manual')),
  attempt_id             uuid references public.attendance_attempts (id) on delete set null,
  credential_id          uuid references public.webauthn_credentials (id) on delete set null,
  device_installation_id uuid references public.device_installations (id) on delete set null,
  latitude               double precision,     -- raw coordinates: purged after retention window
  longitude              double precision,
  distance_meters        real,
  gps_accuracy_meters    real,
  geo_result             text,
  checked_in_at          timestamptz not null default now(),
  manual_reason          text,
  recorded_by            uuid references public.profiles (id) on delete set null,
  constraint attendance_one_per_student_session unique (session_id, student_id),
  constraint attendance_one_installation_session unique (session_id, device_installation_id),
  constraint attendance_manual_needs_reason check (
    source <> 'manual' or (recorded_by is not null and manual_reason is not null and char_length(btrim(manual_reason)) >= 5)
  )
);
create index attendance_records_student_idx on public.attendance_records (student_id, checked_in_at desc);

create table public.attendance_flags (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.sessions (id) on delete cascade,
  student_id      uuid not null references public.profiles (id) on delete cascade,
  attempt_id      uuid references public.attendance_attempts (id) on delete set null,
  flag_type       text not null,
  severity        text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  details         jsonb not null default '{}'::jsonb,
  status          text not null default 'open' check (status in ('open', 'approved', 'dismissed', 'rejected')),
  created_at      timestamptz not null default now(),
  resolved_by     uuid references public.profiles (id) on delete set null,
  resolved_at     timestamptz,
  resolution_note text
);
create index attendance_flags_session_idx on public.attendance_flags (session_id, status);

-- ---------- Spot checks ----------------------------------------------------
create table public.reverification_challenges (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.sessions (id) on delete cascade,
  prompt_type    text not null default 'code',
  prompt_payload jsonb not null,               -- contains the answer; hidden from browser clients
  issued_by      uuid not null references public.profiles (id) on delete restrict,
  issued_at      timestamptz not null default now(),
  expires_at     timestamptz not null
);
create index reverification_session_idx on public.reverification_challenges (session_id, issued_at desc);

create table public.reverification_responses (
  challenge_id   uuid not null references public.reverification_challenges (id) on delete cascade,
  student_id     uuid not null references public.profiles (id) on delete cascade,
  response_at    timestamptz not null default now(),
  response_value text,
  is_correct     boolean not null default false,
  primary key (challenge_id, student_id)       -- one spot-check response
);

-- ---------- Audit log (append-only) ----------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_entity_idx  on public.audit_logs (entity_type, entity_id);

create function public.audit_logs_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only' using errcode = 'insufficient_privilege';
end $$;

create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function public.audit_logs_immutable();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function public.audit_logs_immutable();

-- ---------- Database-backed rate limiting (replaces Redis in the MVP) ---------
create table public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (key, window_start)
);

-- ---------- updated_at on profiles ---------------------------------------------
create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
