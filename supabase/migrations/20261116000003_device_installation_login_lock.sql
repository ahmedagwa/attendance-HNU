-- One active browser/PWA installation per student account, and one student owner per
-- installation hash. The lock is intentionally scoped to student accounts; staff accounts
-- are not used to submit student attendance.
-- Raw installation IDs never enter this function or the database; the app passes a keyed hash.

-- Consolidate any pre-existing multi-browser enrollments to the most recently used
-- installation per student before enforcing the one-active-installation invariant.
with ranked_active_installations as (
  select id, user_id,
         row_number() over (partition by user_id order by last_seen_at desc, created_at desc, id desc) as position
  from public.device_installations
  where revoked_at is null
), revoked_duplicates as (
  update public.device_installations d
     set revoked_at = pg_catalog.now()
    from ranked_active_installations r
   where d.id = r.id and r.position > 1
  returning d.id, d.user_id
)
insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
select null, 'device.migration_revoked_duplicate', 'device_installation', id::text,
       pg_catalog.jsonb_build_object('reason', 'one_active_installation_per_student', 'student_id', user_id)
from revoked_duplicates;

-- Database-level backstop: even privileged application code cannot create two active
-- browser/PWA installation rows for the same student account.
create unique index if not exists device_installations_one_active_per_user_idx
  on public.device_installations (user_id)
  where revoked_at is null;

create or replace function public.claim_device_installation(
  p_user_id uuid,
  p_installation_id_hash text
)
returns table (outcome text, device_installation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.device_installations%rowtype;
  v_active public.device_installations%rowtype;
begin
  if p_user_id is null or p_installation_id_hash is null or pg_catalog.length(p_installation_id_hash) <> 64 then
    raise exception 'invalid device installation claim';
  end if;

  -- Serialize claims for the same student so two new browsers cannot both become active.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('attendance-device:' || p_user_id::text, 0)
  );

  -- A browser/PWA installation is permanently associated with its first student owner.
  select * into v_device
  from public.device_installations
  where installation_id_hash = p_installation_id_hash
  for update;

  if found then
    if v_device.user_id <> p_user_id then
      return query select 'owned_by_another_student'::text, v_device.id;
      return;
    end if;
    if v_device.revoked_at is not null then
      return query select 'revoked'::text, v_device.id;
      return;
    end if;

    update public.device_installations
       set last_seen_at = pg_catalog.now()
     where id = v_device.id;
    return query select 'existing'::text, v_device.id;
    return;
  end if;

  -- A new browser, PWA container or recreated storage identity on an already-bound
  -- student account requires an in-person administrator reset before it can be used.
  select * into v_active
  from public.device_installations
  where user_id = p_user_id and revoked_at is null
  order by created_at desc
  limit 1
  for update;

  if found then
    return query select 'new_installation_requires_admin'::text, v_active.id;
    return;
  end if;

  insert into public.device_installations (user_id, installation_id_hash)
  values (p_user_id, p_installation_id_hash)
  returning * into v_device;

  return query select 'created'::text, v_device.id;
exception
  when unique_violation then
    -- A different student may have claimed this same hash concurrently. Re-read the
    -- unique row and return a denial rather than treating the race as a server error.
    select * into v_device
    from public.device_installations
    where installation_id_hash = p_installation_id_hash;

    if not found then
      raise;
    end if;

    if v_device.user_id <> p_user_id then
      return query select 'owned_by_another_student'::text, v_device.id;
      return;
    end if;

    if v_device.revoked_at is not null then
      return query select 'revoked'::text, v_device.id;
      return;
    end if;

    update public.device_installations
       set last_seen_at = pg_catalog.now()
     where id = v_device.id;
    return query select 'existing'::text, v_device.id;
end;
$$;

revoke all on function public.claim_device_installation(uuid, text) from public, anon, authenticated;
grant usage on schema public to service_role;
grant execute on function public.claim_device_installation(uuid, text) to service_role;
