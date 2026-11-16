import { generateRegistrationOptions } from "@simplewebauthn/server";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, route } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { rp } from "@/lib/webauthn";

const MAX_PASSKEYS = 3;

export const POST = route(async () => {
  const actor = await requireActor("student");
  await rateLimit(`webauthn-reg:${actor.id}`, 300, 10);
  const db = adminClient();
  const { data: existing } = await db.from("webauthn_credentials").select("credential_id, transports").eq("user_id", actor.id).is("revoked_at", null);
  if ((existing?.length ?? 0) >= MAX_PASSKEYS) throw new ApiError(409, "too_many_passkeys", "You already have the maximum number of passkeys. Ask the administrator to reset them.");

  const { rpID, name } = rp();
  const options = await generateRegistrationOptions({
    rpName: name, rpID, userName: actor.universityId, userDisplayName: actor.fullName,
    userID: new TextEncoder().encode(actor.id), attestationType: "none", timeout: 120_000,
    excludeCredentials: (existing ?? []).map((c) => ({ id: c.credential_id, transports: (c.transports ?? undefined) as never })),
    // userVerification is REQUIRED: fingerprint, face or device PIN depending on the authenticator.
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await db.from("webauthn_registration_challenges").upsert({ user_id: actor.id, challenge: options.challenge, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() });
  return json(options);
});
