-- Use a more scan-friendly default for newly created attendance sessions.
-- Existing sessions are intentionally unchanged; update an active test session manually if needed.
alter table public.sessions
  alter column qr_period_seconds set default 10;
