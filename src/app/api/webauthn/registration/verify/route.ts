import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { toBytea } from "@/lib/bytea";
import { rp } from "@/lib/webauthn";

const schema = z.object({
  response: z.looseObject({ id: z.string().max(1024), rawId: z.string().max(1024), type: z.literal("public-key"), response: z.looseObject({}) }),
  nickname: z.string().trim().max(60).optional(),
});

export const POST = route(async (req) => {
  const actor = await requireActor("student");
  await rateLimit(`webauthn-reg-verify:${actor.id}`, 300, 10);
  const { response, nickname } = await readBody(req, schema);
  const db = adminClient();

  const { data: ch } = await db.from("webauthn_registration_challenges").select("challenge, expires_at").eq("user_id", actor.id).maybeSingle();
  await db.from("webauthn_registration_challenges").delete().eq("user_id", actor.id); // single use
  if (!ch || new Date(ch.expires_at).getTime() < Date.now()) throw new ApiError(400, "challenge_expired", "Registration timed out. Start again.");

  const { rpID, origin } = rp();
  let info;
  try {
    const v = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON, expectedChallenge: ch.challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    });
    if (!v.verified || !v.registrationInfo) throw new Error("not verified");
    info = v.registrationInfo;
  } catch (e) {
    await audit(actor.id, "webauthn.registration_failed", "user", actor.id, { reason: e instanceof Error ? e.message.slice(0, 160) : "error" });
    throw new ApiError(400, "registration_failed", "We couldn't verify that passkey. Try again.");
  }

  const { error } = await db.from("webauthn_credentials").insert({
    user_id: actor.id, credential_id: info.credential.id, public_key: toBytea(info.credential.publicKey),
    sign_count: info.credential.counter, transports: info.credential.transports ?? null,
    device_type: info.credentialDeviceType, backup_eligible: info.credentialDeviceType === "multiDevice",
    backed_up: info.credentialBackedUp, nickname: nickname || null,
  });
  if (error?.code === "23505") throw new ApiError(409, "credential_exists", "That passkey is already registered.");
  if (error) throw new Error("credential insert failed: " + error.message);

  await audit(actor.id, "webauthn.registered", "user", actor.id, { device_type: info.credentialDeviceType, backed_up: info.credentialBackedUp });
  return json({ ok: true, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp });
});
