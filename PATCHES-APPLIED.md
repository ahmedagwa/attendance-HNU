# Consolidated project patches

This ZIP is based on the uploaded `attendance-pwa.zip` and incorporates the fixes prepared during the troubleshooting conversation.

## Included source changes

1. `src/components/admin/api-form.tsx`
   - Removes callback-function props from the Server Component boundary.
   - Adds serializable `valueFormat` settings (`number`, `string-list`).
   - Adds serializable success-message modes for enrollment and device recovery.

2. `src/app/admin/people/page.tsx`
   - Uses the serializable `successMessage="device-recovery"` setting.

3. `src/app/admin/academics/page.tsx`
   - Loads subjects independently of the lecturer relationship embed.
   - Loads lecturers separately and resolves lecturer display names in the page.
   - Displays Supabase query errors rather than silently showing empty lists.
   - Uses serializable form field settings for enrollment IDs and numeric weekdays.

4. `src/lib/auth.ts`
   - Reads the signed-in user's own profile through the cookie-bound Supabase client and logs profile-query errors server-side.

5. `src/components/login-form.tsx`
   - Restricts post-login `next` redirects to the application's role routes and falls back to `/` for invalid targets such as `/signup`.

6. `src/lib/rate-limit.ts`
   - Logs Postgres RPC diagnostic fields in the server terminal while keeping the browser response generic.

7. `supabase/migrations/20261116000001_service_role_function_grants.sql`
   - Explicitly grants `service_role` schema usage and execute permission on the rate-limit RPC functions.

## Environment and secrets

- No `.env.local` file, private key, or live credential is included.
- Copy `.env.local.example` to `.env.local` and fill it with credentials from the same local Supabase instance (`supabase status`).
- Never commit `.env.local` or use local development credentials in production.

## Applying the new migration

The migration is additive and idempotent. Apply pending migrations using your normal Supabase migration workflow. Alternatively, for this specific grant migration, open the **local** Supabase Studio SQL Editor and execute the contents of:

`supabase/migrations/20261116000001_service_role_function_grants.sql`

Do not run `supabase db reset` on a database containing data you need to preserve: resetting a local Supabase database rebuilds it and can delete local records.

## Important verification note

This archive is a consolidated source snapshot, not a claim that the project has passed a clean build or live integration test. After extracting it, run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`, then verify the People and Academics flows against your local Supabase instance.


## QR rotation interval adjustment (10 seconds)
- New sessions are created with `qr_period_seconds = 10` instead of 5.
- The sessions table default is updated to 10 seconds for fresh installs and by migration `20261116000002_qr_period_default_10s.sql`.
- The projector helper text now explains the approximate 10-second refresh interval.
- QR validation remains time-bucket based and continues to accept the immediately previous bucket only during the existing 2-second rollover grace.
- Existing session rows are not modified by this migration. For an already-open local test session, run the SQL update supplied in the delivery instructions and refresh the projector page.


## Level 1 student browser/PWA installation lock
- Student login now claims the persistent browser/PWA installation before redirecting into the student portal; if the claim fails, the new Supabase session is signed out.
- Every protected student page and student-only API now verifies the matching HttpOnly device-binding cookie against an active row owned by the authenticated student. Direct Supabase sign-in alone cannot bypass the app's device-claim step.
- The same installation remains assigned after sign-out and cannot be claimed by a second student account.
- A student account with an existing active installation cannot silently move to a new browser/PWA identity; an administrator must verify the student and use People > Lost phone or new device to revoke the old assignment.
- Attendance attempt creation and final attendance commit both re-check the same atomic PostgreSQL device-claim function.
- Device claims are serialized per student with a PostgreSQL advisory transaction lock; a partial unique index also enforces one active installation per student. If older data contains multiple active installations, the migration keeps the most recently used one and revokes the others with audit entries. The claim function is executable only by `service_role`.
- The browser requests persistent IndexedDB storage where supported.
- New deployments can use a separate `INSTALLATION_HASH_KEY`; the optional fallback to `QR_MASTER_KEY` preserves hashes already created by earlier versions. The Vercel environment checker validates the new key when configured.
- Admin/lecturer accounts skip the student-only device claim.
- See `DEVICE-LOCK-POLICY.md` for Android/iOS usage instructions and the important limitation: a PWA can bind a browser/app installation, not prove a universal physical-device identity across separate browsers.
- New migration: `supabase/migrations/20261116000003_device_installation_login_lock.sql`. Apply this migration before running the updated application.
