# University Attendance PWA

Implementation of the *University Attendance Management PWA — Final Technical Report v1.0* (14 Nov 2026).
Student, lecturer and admin portals in one Next.js app; Supabase provides Auth, PostgreSQL (RLS) and Realtime; SimpleWebAuthn verifies passkeys. No Redis, no FastAPI (report §2.2–2.3).

## What is implemented

| Report section | Where |
|---|---|
| §5 schema, integrity rules | `supabase/migrations/…_schema.sql` |
| §5.3 RLS policy matrix, column-level secrets | `…_rls.sql` (hall coordinates, QR secret, raw GPS and spot-check answers are unreadable by browser roles) |
| §6.1 rotating HMAC QR (shared, reusable, ~7 s window) | `src/lib/qr.ts`, `api/sessions/[id]/qr` |
| §6.2 two-step handshake, unique 45 s challenge per attempt | `api/attendance/attempts`, `api/attendance/verify` |
| Atomic consume + insert, duplicate protection | `commit_qr_attendance()` in `…_functions.sql` |
| §6.3 passkeys + installation ID (hashed) | `api/webauthn/registration/*`, `api/devices/register`, `src/lib/client/installation.ts` |
| §6.4 geofence (Haversine + accuracy handling) | `src/lib/geo.ts` |
| §6.5 spot check, §6.6 manual override + audit | `api/sessions/[id]/reverification*`, `api/attendance/manual`, append-only `audit_logs` |
| §7 API contract | `src/app/api/**` |
| §8 live dashboard (private Broadcast + reconciliation) | `use-session-live.ts`, `…_realtime.sql` |
| §3.2 PWA (manifest, icons, shell-only service worker) | `app/manifest.ts`, `public/sw.js` |
| §9.4 retention (raw GPS purge after 30 days) | `purge_raw_gps()` + `api/cron/maintenance` (Vercel Cron) |
| §10 acceptance tests | `tests/unit`, `supabase/tests`, `tests/load`, `tests/e2e` |

Deliberate additions beyond the report: database-backed rate limiting (replaces Redis), `webauthn_registration_challenges`, pause/resume, CSV export with formula-injection protection, passkey-counter-regression flag.

## Run it locally (step by step)

1. **Install** Node.js 22 LTS, the Supabase CLI and Docker.
2. **Install dependencies**: `npm install`
3. **Start Supabase locally**: `supabase init` (once), then `supabase start`. In `supabase/config.toml` set `[auth] enable_signup = false`.
4. **Apply migrations**: `supabase db reset` (applies `supabase/migrations/*`).
5. **Configure env**: copy `.env.local.example` to `.env.local`; fill the keys from `supabase status`; generate `QR_MASTER_KEY` with `openssl rand -base64 32`.
6. **Seed demo data (staging only)**: `node --env-file=.env.local scripts/seed.ts`
7. **Run**: `npm run dev`, open http://localhost:3000, sign in as `lecturer1@demo.edu` or `student1@demo.edu` (password in the seed script).
8. **Try the flow**: lecturer starts a session and opens the projector; on a phone (HTTPS needed — see below) the student creates a passkey, then scans.

Phones need a secure context for camera, GPS and passkeys. For real-device tests use a Vercel preview URL or a tunnel (e.g. `cloudflared`), and set `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN` to that hostname.

## Deploy to Vercel (step by step)

The repo is Vercel-ready: `vercel.json` sets the framework, function region (`fra1`) and the daily retention cron; `package.json` pins Node 22; the build fails early with a clear message if configuration is wrong (`scripts/check-env.mjs`).

**A. Supabase (production project)**
1. Create a Supabase project. Pick the region closest to campus; `fra1` in `vercel.json` assumes **eu-central-1 (Frankfurt)**. If you choose another region, change `regions` in `vercel.json` to the nearest Vercel region, so API-to-database round trips stay short.
2. Link the CLI (`supabase link --project-ref <ref>`) and run `supabase db push`. This applies all five migrations, including RLS and the Realtime policy.
3. In **Authentication → Providers/Settings**: turn **off** "Allow new users to sign up". Set the Site URL to your production domain.
4. In **Realtime → Settings**: turn **off** "Allow public access" so only authorised users can join private channels.
5. Copy the project URL, the publishable key and the secret key (Project Settings → API).

**B. Vercel**
6. Push the repo to GitHub/GitLab and import it in Vercel (framework is detected as Next.js).
7. Before the first deploy, add these Environment Variables (Settings → Environment Variables), at least for **Production**:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_APP_URL`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_NAME`, `QR_MASTER_KEY`, `CRON_SECRET`.
   Mark `SUPABASE_SECRET_KEY`, `QR_MASTER_KEY` and `CRON_SECRET` as **Sensitive**. `NEXT_PUBLIC_*` values are baked into the build, so changing them needs a redeploy.
   Generate secrets with `openssl rand -base64 32` (`QR_MASTER_KEY`) and `openssl rand -hex 24` (`CRON_SECRET`).
8. Add your custom domain (Settings → Domains) and wait for HTTPS. Then set `WEBAUTHN_RP_ID` to the domain (for example `attendance.example.edu`) and `WEBAUTHN_ORIGIN` to `https://attendance.example.edu`. **Passkeys are bound to this value**; changing it later invalidates every enrolled passkey.
9. Deploy. If the env check fails, the build log lists exactly what to fix.

**C. After the first deploy**
10. Open `https://<domain>/api/health`. Expect `{"ok":true,"db":true,...}`. A 503 means the Supabase keys or migrations are wrong.
11. Create the first admin (step 6 under "Create the first admin" below), then sign in and create accounts.
12. Install the app on a real Android phone and a real iPhone (Add to Home Screen), create a passkey, and run a full check-in against the projector.
13. Open the browser console on the student and lecturer screens. The app ships with the Content-Security-Policy in **report-only** mode (`CSP_MODE=report-only`). If you see no violations, set `CSP_MODE=enforce` in Vercel and redeploy.
14. In Vercel → Settings → Cron Jobs, confirm `/api/cron/maintenance` is listed. Vercel sends `CRON_SECRET` automatically. Check the first run in the logs.
15. Add an uptime monitor on `/api/health` and enable error alerts in Vercel.

**Preview deployments.** Preview URLs have different hostnames, so passkeys created on production do not work there. Point a separate Supabase *staging* project and a staging domain at the Preview environment (set `WEBAUTHN_*` per environment) and test with those.

**Create the first admin.** Add a user in the Supabase dashboard (Authentication → Users), then run in the SQL editor:
`insert into profiles (id, university_id, full_name, role) values ('<auth user id>', 'A-0001', 'Admin', 'admin');`

**Known deploy-time unknowns (not testable in my build environment).** (a) Realtime server broadcasts use the secret key; if the lecturer's live feed never updates but counts refresh every 10 s, check the Supabase Realtime logs. Check-in itself is unaffected because broadcasts are best-effort. (b) Vercel Hobby limits cron to once per day and function duration to short defaults; Pro is recommended for the pilot.

## Tests

| Command | What it proves |
|---|---|
| `npm test` | 34 unit tests: QR window/forgery/reuse, AES-GCM secret handling, geofence table, WebAuthn challenge/origin/RP-ID/UV/counter checks with a software authenticator, CSV safety |
| `npm run test:db` | Applies every migration on a throw-away PostgreSQL and runs 44 RLS/constraint/function assertions plus a **120-way parallel commit race** (expects exactly 101 rows, no duplicates) |
| `npm run typecheck` / `npm run lint` / `npm run build` | CI gate (report M1) |
| `npm run test:e2e` | Playwright smoke tests on Pixel 7 and iPhone 14 profiles |
| `npm run load` | k6: 100 simultaneous attempt creations, stressed to 200 |

## Honest limits (read before the pilot)

- A live-relayed QR, spoofed browser GPS, synced passkeys and a cleared installation ID can all defeat individual checks. The system raises the cost of fraud and routes doubt to review; it does not prove presence.
- The "95% of students under 30 s" target is **not** claimed. Measure it on real phones and campus Wi-Fi (report §10).
- API handlers talk to Supabase over PostgREST and were verified by type-check, build, runtime smoke tests and the database suite, but **not** against a live Supabase project in this build environment. Run the Playwright and k6 suites against staging before sign-off.
- Not yet built: Arabic/RTL localisation, push notifications, per-student CSV report across sessions, and `supabase gen types` typed clients (recommended next).
- University decisions still required: absence limits, late threshold, hall radii, who may use manual override, retention period, student notice and lawful basis.


## Student browser/PWA installation lock

Students are assigned to one browser/PWA installation at sign-in. The server checks the matching HttpOnly installation cookie on every protected student page and student API; a direct Supabase login cannot bypass the app's device-claim step. Signing out does not release the installation; a second student cannot claim the same installation. A new installation for an already-bound student needs an administrator device reset. For a new deployment, set `INSTALLATION_HASH_KEY` before registering student devices; it is optional only to preserve hashes from existing deployments. See `DEVICE-LOCK-POLICY.md` for Android/iOS usage and the limits of browser-level identity. Apply all migrations before running this version.
