# Apply Level 1 student device lock

This release binds each student to one browser/PWA installation and blocks other student accounts from using that same installation. It is designed for Android and iOS phones; desktop browsers are for development/testing.

## Before applying

- Keep a copy of your current project folder.
- Do not run `supabase db reset`; that can delete your local test data.
- Keep your existing `.env.local` private and copy it into the updated project folder. It is not included in the ZIP.
- If you already have student device rows, do not change `QR_MASTER_KEY` or the effective installation hash key.

## 1. Apply the database migration

The new migration is:

`supabase/migrations/20261116000003_device_installation_login_lock.sql`

For the current local setup:

1. Open `http://127.0.0.1:54323`.
2. Open **SQL Editor → New Query**.
3. Open the migration file above in your code editor.
4. Copy its entire contents into SQL Editor and run it once against the local database.

The migration:

- keeps the most recently used active installation per student if older data contains multiple active installations;
- revokes older duplicate installations and records those revocations in the audit log;
- creates a partial unique index enforcing one active installation per student;
- installs the server-only `claim_device_installation()` RPC and grants execute only to `service_role`.

Do not run this migration against a different Supabase project by mistake.

## 2. Restart Next.js

In the project terminal:

```powershell
Ctrl + C
npm run dev
```

The current `.env.local` can remain unchanged for backward compatibility. On a brand-new hosted deployment, set a separate 32-byte `INSTALLATION_HASH_KEY` before the first student device is registered. If the variable is omitted, the application falls back to `QR_MASTER_KEY` so existing local installation hashes continue to work. Never rotate the effective installation hash key after device rows exist without a planned re-enrollment process.

## 3. How to test

Use dedicated test students, not real student accounts that will later be assigned to their own phones.

1. Sign in as **Student A** in one normal browser profile. The app claims that browser/PWA installation automatically.
2. Sign out. Do not clear site data.
3. Sign in as **Student B** in the same browser profile. The app must reject the login, sign Student B out, and display a device-conflict message.
4. Sign in again as **Student A** in the same browser profile. It should work.
5. Try Student A in a different browser/profile. It should be blocked as a new installation until an administrator verifies the student and performs **People → Lost phone or new device** with both revocation options selected.
6. After the administrator reset, sign Student A in on the replacement browser/PWA installation. It should claim successfully.
7. Verify that lecturer and admin logins still work on the shared development desktop; the student-only binding policy does not apply to staff.

If reusing the same browser after an approved reset, clear that site's cookies and storage only after the administrator has revoked the old installation. A replacement phone/browser normally has its own fresh browser storage.

## 4. Android and iOS use

- Use the deployed HTTPS site for real phone testing and production. WebAuthn, camera, and geolocation require a secure context.
- Android: choose one browser profile (for example, Chrome) or its installed PWA and always use that same context.
- iPhone/iPad: choose either Safari or the Home Screen web app and always use that same context. Do not alternate between them.
- Do not use Private/Incognito mode, clear site data, reinstall the PWA, or switch browsers without an administrator-approved device reset.
- Desktop browser profiles are treated as separate installations and should be used only with dedicated test accounts.

## 5. What this does and does not guarantee

This is a browser/PWA-installation lock, not a universal physical-phone identifier. It blocks account switching in the same browser/PWA installation, including after sign-out, and blocks unapproved replacement installations for an already-bound student account. It does not prove that two separate browser apps or isolated PWA contexts on the same physical phone are the same handset; clearing all site data can also create a fresh installation identity. A strict physical-device policy across all Android/iOS apps requires a native/managed-device solution with platform attestation or device management.

## 6. Verification

After applying the migration, run the database tests in a local Supabase test environment:

```powershell
npm run test:db
```

Then run the app checks:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

The patch source was syntax-checked, but these full commands have not been executed in this environment. Verify them locally before using real student accounts.
