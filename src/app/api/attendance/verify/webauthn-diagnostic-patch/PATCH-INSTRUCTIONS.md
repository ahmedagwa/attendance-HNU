# Temporary WebAuthn diagnostics patch

This patch replaces only `src/app/api/attendance/verify/route.ts`.

It adds logging of the WebAuthn authenticator-data flag byte only: user-present (UP), user-verified (UV), backup-eligible (BE), and backed-up (BS). It does NOT log credential IDs, challenges, signatures, client data, or raw authenticator data.

## Apply
1. Stop Next.js.
2. Extract this ZIP into the project root, preserving folders and replacing the file.
3. Run `npm run dev`.
4. Scan the projector QR again and complete the Windows Hello PIN prompt.
5. Inspect the terminal for `[webauthn] assertion diagnostics` and `[webauthn] assertion verification failed`.

Send back only those diagnostic log lines. Do not send PINs, secrets, assertion payloads, or cookies.

## Interpretation
- `userVerified: false`: the authenticator/browser returned an assertion without the WebAuthn UV flag, despite the prompt. We then investigate the authenticator/browser provider.
- `userVerified: true` but verification still fails: inspect the logged `reason`; likely a separate challenge, origin, RP ID, credential, or signature mismatch.
- `credentialFound: false`: the browser submitted a credential ID not registered to this student.

This is a temporary diagnostic patch, not a security relaxation. `requireUserVerification: true` remains unchanged. Remove the added diagnostic code after troubleshooting.
