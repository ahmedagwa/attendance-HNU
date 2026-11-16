-- Explicitly restore the server-only function privileges required by the Next.js
-- service-role client. Safe to apply more than once. Does not grant access to anon
-- or authenticated browser roles.

GRANT USAGE ON SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_rate_limits() TO service_role;
