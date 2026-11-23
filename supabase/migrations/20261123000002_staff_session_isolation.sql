-- Each lecturer/professor/TA may view and manage only sessions they personally opened.
-- Administrators continue to have access through the separate *_admin RLS policies.
-- Application routes also enforce the same rule in requireSessionManager().

create or replace function public.manages_session(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.sessions s
     where s.id = p_session
       and s.started_by = (select auth.uid())
  )
$$;

comment on function public.manages_session(uuid) is
  'A teaching staff member can view/manage only sessions they started; administrator access is handled by explicit admin RLS policies.';
