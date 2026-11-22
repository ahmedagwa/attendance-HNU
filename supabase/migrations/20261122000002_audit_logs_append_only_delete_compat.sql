-- Preserve append-only audit entries when deleting a profile.
-- The prior ON DELETE SET NULL foreign key attempts to UPDATE audit_logs.actor_id,
-- which is rejected by audit_logs_immutable(). Keep actor_id as an opaque UUID
-- instead of mutating historical audit rows during profile deletion.

ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_actor_id_fkey;
