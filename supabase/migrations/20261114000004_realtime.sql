-- =====================================================================
-- Private Realtime Broadcast channel `session:<uuid>`.
-- Only the lecturer who manages the session (and admins) may subscribe.
-- Skipped automatically on plain Postgres that has no realtime schema.
-- =====================================================================
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'realtime') then
    execute $p$
      create policy "session broadcasts: lecturer or admin can receive"
        on realtime.messages for select to authenticated
        using (
          realtime.messages.extension = 'broadcast'
          and (
            public.is_admin()
            or case
                 when (select realtime.topic()) ~ '^session:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then public.manages_session(split_part((select realtime.topic()), ':', 2)::uuid)
                 else false
               end
          )
        )
    $p$;
  end if;
end $$;
