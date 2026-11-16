import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route } from "@/lib/http";
import { audit } from "@/lib/audit";

const schema = z.object({
  universityId: z.string().trim().min(3).max(40), revokePasskeys: z.boolean().default(true), revokeDevices: z.boolean().default(true),
  reason: z.string().trim().min(5).max(300),
});

/** Lost-phone recovery: revoke old passkeys/installations so the student can enrol again. Fully audited. */
export const POST = route(async (req) => {
  const actor = await requireActor("admin");
  const body = await readBody(req, schema);
  const db = adminClient();
  const { data: user } = await db.from("profiles").select("id, role").eq("university_id", body.universityId).maybeSingle();
  if (!user || user.role !== "student") throw new ApiError(404, "not_found", "No student with that university ID.");

  const now = new Date().toISOString();
  let passkeys = 0, devices = 0;
  if (body.revokePasskeys) {
    const { data } = await db.from("webauthn_credentials").update({ revoked_at: now }).eq("user_id", user.id).is("revoked_at", null).select("id");
    passkeys = data?.length ?? 0;
  }
  if (body.revokeDevices) {
    const { data } = await db.from("device_installations").update({ revoked_at: now }).eq("user_id", user.id).is("revoked_at", null).select("id");
    devices = data?.length ?? 0;
  }
  await audit(actor.id, "account.recovery", "user", user.id, { reason: body.reason, passkeys_revoked: passkeys, devices_revoked: devices });
  return json({ passkeysRevoked: passkeys, devicesRevoked: devices });
});
