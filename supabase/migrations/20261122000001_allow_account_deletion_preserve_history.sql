-- Allow an account to be deleted without deleting the sessions or spot-check
-- history it created. Keep the historical rows and clear only the user link.

ALTER TABLE public.sessions
  ALTER COLUMN started_by DROP NOT NULL;

ALTER TABLE public.sessions
  DROP CONSTRAINT IF EXISTS sessions_started_by_fkey;

ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_started_by_fkey
  FOREIGN KEY (started_by)
  REFERENCES public.profiles (id)
  ON DELETE SET NULL;

ALTER TABLE public.reverification_challenges
  ALTER COLUMN issued_by DROP NOT NULL;

ALTER TABLE public.reverification_challenges
  DROP CONSTRAINT IF EXISTS reverification_challenges_issued_by_fkey;

ALTER TABLE public.reverification_challenges
  ADD CONSTRAINT reverification_challenges_issued_by_fkey
  FOREIGN KEY (issued_by)
  REFERENCES public.profiles (id)
  ON DELETE SET NULL;
