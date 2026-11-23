-- Private per-staff, per-subject Excel rosters. The service-role-only API reads
-- each staff member's workbook and appends attendance columns only for sessions
-- whose sessions.started_by matches that staff member.

create table public.staff_roster_workbooks (
  id                    uuid primary key default gen_random_uuid(),
  staff_user_id         uuid not null references public.profiles(id) on delete cascade,
  subject_id            uuid not null references public.subjects(id) on delete cascade,
  storage_path          text not null unique,
  original_filename     text not null,
  worksheet_name        text not null,
  worksheet_path        text not null,
  header_row            integer not null check (header_row > 0),
  id_column             integer not null check (id_column > 0),
  id_header             text not null,
  next_column_number    integer not null default 1 check (next_column_number > 0),
  sync_lock_token       uuid,
  sync_locked_until     timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (staff_user_id, subject_id),
  check ((sync_lock_token is null) = (sync_locked_until is null))
);
create index staff_roster_workbooks_subject_idx on public.staff_roster_workbooks(subject_id, staff_user_id);

create table public.staff_roster_workbook_sessions (
  workbook_id           uuid not null references public.staff_roster_workbooks(id) on delete cascade,
  session_id            uuid not null references public.sessions(id) on delete cascade,
  session_number        integer not null check (session_number > 0),
  column_number         integer not null check (column_number > 0),
  sync_status           text not null default 'pending' check (sync_status in ('pending', 'applied', 'failed')),
  matched_count         integer not null default 0 check (matched_count >= 0),
  unknown_count         integer not null default 0 check (unknown_count >= 0),
  missing_count         integer not null default 0 check (missing_count >= 0),
  last_error            text,
  updated_at            timestamptz not null default now(),
  primary key (workbook_id, session_id),
  unique (workbook_id, session_number)
);
create index staff_roster_workbook_sessions_status_idx
  on public.staff_roster_workbook_sessions(workbook_id, sync_status);

alter table public.staff_roster_workbooks enable row level security;
alter table public.staff_roster_workbook_sessions enable row level security;
revoke all on public.staff_roster_workbooks, public.staff_roster_workbook_sessions from anon, authenticated;
grant usage on schema public to service_role;
grant all on public.staff_roster_workbooks, public.staff_roster_workbook_sessions to service_role;

-- This bucket is private and has no authenticated/anon object policies.
-- Only the server-side service-role client can read or write these workbooks.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'staff-rosters',
  'staff-rosters',
  false,
  10485760,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.acquire_staff_roster_workbook_lock(
  p_workbook_id uuid,
  p_lock_token uuid
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_rows integer;
begin
  update public.staff_roster_workbooks
     set sync_lock_token = p_lock_token,
         sync_locked_until = now() + interval '5 minutes'
   where id = p_workbook_id
     and (sync_lock_token is null or sync_locked_until < now() or sync_lock_token = p_lock_token);
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end $$;

create or replace function public.release_staff_roster_workbook_lock(
  p_workbook_id uuid,
  p_lock_token uuid
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_rows integer;
begin
  update public.staff_roster_workbooks
     set sync_lock_token = null, sync_locked_until = null, updated_at = now()
   where id = p_workbook_id and sync_lock_token = p_lock_token;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end $$;

-- Reserve this staff member’s chronological session number within the subject and its workbook column.
-- If the imported file already contains "Session N", reuse that existing column.
create or replace function public.claim_staff_roster_workbook_column(
  p_workbook_id uuid,
  p_session_id uuid,
  p_lock_token uuid,
  p_session_number integer,
  p_existing_column integer default null
) returns table (session_number integer, column_number integer, sync_status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_subject uuid;
  v_next_column integer;
  v_lock uuid;
  v_session_owner uuid;
  v_session_subject uuid;
  v_existing public.staff_roster_workbook_sessions%rowtype;
  v_session_number integer;
  v_column_number integer;
begin
  select staff_user_id, subject_id, next_column_number, sync_lock_token
    into v_owner, v_subject, v_next_column, v_lock
    from public.staff_roster_workbooks
   where id = p_workbook_id
   for update;
  if not found then raise exception 'Roster workbook not found.'; end if;
  if v_lock is distinct from p_lock_token then raise exception 'Roster workbook lock was lost.'; end if;

  select started_by, subject_id into v_session_owner, v_session_subject
    from public.sessions where id = p_session_id;
  if not found or v_session_owner is distinct from v_owner or v_session_subject is distinct from v_subject then
    raise exception 'This session was not opened by the owner of this subject workbook.';
  end if;

  select * into v_existing
    from public.staff_roster_workbook_sessions
   where workbook_id = p_workbook_id and session_id = p_session_id;
  if found then
    return query select v_existing.session_number, v_existing.column_number, v_existing.sync_status;
    return;
  end if;

  if p_session_number is null or p_session_number < 1 then raise exception 'Invalid subject session number.'; end if;
  v_session_number := p_session_number;
  if p_existing_column is not null and p_existing_column > 0 then
    v_column_number := p_existing_column;
  else
    v_column_number := v_next_column;
    update public.staff_roster_workbooks set next_column_number = v_next_column + 1 where id = p_workbook_id;
  end if;
  update public.staff_roster_workbooks set updated_at = now() where id = p_workbook_id;
  insert into public.staff_roster_workbook_sessions(workbook_id, session_id, session_number, column_number, sync_status)
  values (p_workbook_id, p_session_id, v_session_number, v_column_number, 'pending');
  return query select v_session_number, v_column_number, 'pending'::text;
end $$;

revoke all on function public.acquire_staff_roster_workbook_lock(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_staff_roster_workbook_lock(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_staff_roster_workbook_column(uuid, uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.acquire_staff_roster_workbook_lock(uuid, uuid) to service_role;
grant execute on function public.release_staff_roster_workbook_lock(uuid, uuid) to service_role;
grant execute on function public.claim_staff_roster_workbook_column(uuid, uuid, uuid, integer, integer) to service_role;
