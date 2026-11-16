# Student device / browser-installation policy

## What this release enforces

- Immediately after sign-in, the app claims the current browser/PWA installation for a student account.
- The same installation hash cannot be claimed by a different student account. Signing out does not release the assignment.
- A student account may have one active browser/PWA installation. A partial unique database index enforces this rule. The migration revokes older duplicate active installations, keeping the most recently used one. A new or recreated installation is blocked until an administrator verifies the student and resets the previous device assignment.
- Device ownership is checked at login, on every protected student page and student API, before a QR attendance challenge is issued, and again before the attendance record is committed. A direct Supabase password sign-in that bypasses the app's login form does not grant access to the student portal or student APIs without the matching HttpOnly installation cookie.
- The raw installation UUID is kept in browser storage and is never stored in PostgreSQL. The database stores only an HMAC-SHA256 hash.
- The admin People > Lost phone or new device workflow revokes the student's old passkeys and linked installation records. After verification, the student signs in on the replacement browser/PWA installation.
- The browser asks for persistent origin storage when supported and receives a matching HttpOnly HMAC cookie. The cookie survives normal sign-out and detects an IndexedDB identity change if cookies remain. This is best-effort and does not prevent a user or operating system from clearing all site data.
- New deployments should configure a separate `INSTALLATION_HASH_KEY` (32 bytes) before enrolling the first student device. If it is omitted, the app falls back to `QR_MASTER_KEY` to preserve existing device hashes. Never rotate the effective installation hash key after registrations exist without a planned device re-enrollment process.

## Android and iOS operating guidance

- This project is intended for Android and iOS phones. Students should use the same browser app or installed PWA every time. On Android, use the same Chrome/browser profile or its installed PWA. On iPhone/iPad, choose either Safari or the Home Screen web app and use that same context consistently; do not alternate between contexts unless the administrator resets the device assignment. Desktop browsers are for development/testing only.
- Do not use Private/Incognito browsing for attendance. Do not clear site data, browser storage, or reinstall the PWA without contacting the administrator. If re-enrolling in the same browser after an approved reset, clear the site's stored data only after the administrator has revoked the old assignment.
- Use the deployed HTTPS domain for camera, geolocation, and WebAuthn. `localhost` is only for development.
- The development desktop browser follows the same policy and is useful for testing. Each desktop browser profile is treated as a separate installation.

## Security limitation

This is a browser/PWA-installation binding, not a cryptographic physical-hardware identity. Web browsers intentionally do not expose a universal, stable hardware ID. Different browser apps, browser profiles, private contexts, or separately stored PWA contexts on the same physical phone may have different IndexedDB namespaces. A determined user may also clear or manipulate client storage. The policy detects and blocks reuse of the same installation and requires admin approval for an unknown replacement installation on an already-bound student account, but it cannot prove that two different browser installations belong to different physical phones.

A guaranteed one-physical-phone-to-one-student policy across all browsers on Android and iOS requires a native/managed-device approach with platform integrity or device-management enrollment. Do not describe this PWA control as hardware binding.

## Test cases

1. Student A signs in on Browser/PWA installation X: claim succeeds.
2. Student A signs out and signs in again on X: claim succeeds; sign-out does not release X.
3. Student B signs in on X: login is rejected and Student B is signed out.
4. Student A signs in on a new installation Y while X is still active: login is rejected pending administrator verification/reset.
5. Administrator verifies Student A and revokes the old device assignment; Student A can then sign in on a new installation Y.
6. Administrator/lecturer accounts are not subject to the student installation claim.

The installation ID is origin-scoped. Changing the production hostname/domain creates a different browser storage origin and may require an administrator reset and passkey re-enrollment. Decide on the long-term HTTPS domain before onboarding real students.
