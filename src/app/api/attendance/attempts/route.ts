import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { rp } from "@/lib/webauthn";
import { serverEnv } from "@/lib/env";
import { decryptSecret, parseMasterKey, parseQrPayload, verifyQrToken } from "@/lib/qr";
import { claimDeviceInstallation } from "@/lib/device-installation";

const ATTEMPT_TTL_SECONDS = 45;
const schema = z.object({ qrPayload: z.string().min(10).max(200), installationId: z.string().min(16).max(64) });

/**
 * Step 1 of the two-step handshake. The projector QR is SHARED and reusable inside its validity
 * window; this endpoint turns it into a unique, single-use, 45 s attempt + WebAuthn challenge
 * bound to exactly one (student, session).
 */
export const POST = route(async (req) => {
  const actor = await requireActor("student");
  await rateLimit(`attempts:${actor.id}`, 60, 20);
  const { qrPayload, installationId } = await readBody(req, schema);
  const db = adminClient();

  const device = await claimDeviceInstallation(actor.id, installationId);
  if (device.outcome !== "created" && device.outcome !== "existing") {
    await audit(actor.id, "device.attendance_blocked", "device_installation", device.deviceInstallationId, { reason: device.outcome });
    const code = device.outcome === "owned_by_another_student" ? "device_conflict"
      : device.outcome === "revoked" ? "device_revoked"
        : device.outcome === "installation_identity_changed" ? "device_identity_changed" : "device_approval_required";
    const message = code === "device_conflict"
      ? "This browser or installed app is already assigned to another student account."
      : code === "device_revoked"
        ? "This browser or device registration has been revoked. Contact your administrator."
        : code === "device_identity_changed"
          ? "This browser's saved installation identity changed. Contact your administrator before clearing storage or switching accounts."
          : "This student account is already linked to another browser or device. Ask your administrator to verify you and reset the previous device.";
    throw new ApiError(403, code, message);
  }

  const parsed = parseQrPayload(qrPayload);
  if (!parsed) { await badQr(actor.id, "malformed"); throw new ApiError(400, "invalid_qr", "That is not an attendance QR code."); }

  const { data: session } = await db
    .from("sessions").select("id, subject_id, group_id, status, qr_secret_enc, qr_period_seconds, subject:subjects(code, name), hall:halls(name, max_gps_accuracy_meters)")
    .eq("id", parsed.sessionId).maybeSingle();
  if (!session) { await badQr(actor.id, "unknown_session"); throw new ApiError(400, "invalid_qr", "That is not an attendance QR code."); }

  const verdict = verifyQrToken({
    payload: qrPayload, sessionId: session.id, nowMs: Date.now(), periodSeconds: session.qr_period_seconds,
    secret: decryptSecret(session.qr_secret_enc, parseMasterKey(serverEnv().QR_MASTER_KEY)),
  });
  if (!verdict.ok) {
    await badQr(actor.id, verdict.reason, session.id);
    if (verdict.reason === "expired") throw new ApiError(400, "qr_expired", "That code has already changed. Scan the code on the screen again.");
    throw new ApiError(400, "invalid_qr", "That is not a valid attendance QR code.");
  }

  if (session.status !== "active") throw new ApiError(409, "session_not_active", "Attendance is not open for this session.");

  // Eligibility: enrolled in the subject and, for group-scoped sessions, in that group. Generic on failure.
  let enrol = db.from("enrollments").select("student_id", { head: true, count: "exact" }).eq("subject_id", session.subject_id).eq("student_id", actor.id);
  if (session.group_id) enrol = enrol.eq("group_id", session.group_id);
  const { count: eligible } = await enrol;
  if (!eligible) {
    await audit(actor.id, "attendance.not_eligible", "session", session.id);
    throw new ApiError(403, "not_eligible", "You can't check in to this session.");
  }

  const { data: existing } = await db.from("attendance_records").select("status").eq("session_id", session.id).eq("student_id", actor.id).maybeSingle();
  if (existing) throw new ApiError(409, "already_checked_in", "You are already checked in.", { status: existing.status });

  const { data: creds } = await db.from("webauthn_credentials").select("credential_id, transports").eq("user_id", actor.id).is("revoked_at", null);
  if (!creds?.length) throw new ApiError(412, "passkey_required", "Set up your passkey before checking in.");

  const { rpID } = rp();
  const options = await generateAuthenticationOptions({
    rpID, userVerification: "required", timeout: ATTEMPT_TTL_SECONDS * 1000,
    allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: (c.transports ?? undefined) as never })),
  });

  const { data: created, error } = await db.rpc("create_attendance_attempt", {
    p_session_id: session.id, p_student_id: actor.id, p_challenge: options.challenge, p_qr_bucket: verdict.bucket, p_ttl_seconds: ATTEMPT_TTL_SECONDS,
  });
  const row = Array.isArray(created) ? created[0] : created;
  if (error || !row) throw new Error("could not create attempt: " + error?.message);

  const subject = session.subject as unknown as { code: string; name: string };
  const hall = session.hall as unknown as { name: string; max_gps_accuracy_meters: number };
  return json({
    attemptId: row.attempt_id, expiresAt: row.expires_at, options,
    session: { subjectCode: subject.code, subjectName: subject.name, hallName: hall.name },
    geo: { maxAccuracyMeters: hall.max_gps_accuracy_meters },
  });
});

async function badQr(studentId: string, reason: string, sessionId?: string) {
  await audit(studentId, "attendance.qr_rejected", "session", sessionId ?? null, { reason });
  await rateLimit(`bad-qr:${studentId}`, 60, 10);
}
