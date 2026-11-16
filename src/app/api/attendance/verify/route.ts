import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { requireActor, type Actor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { fromBytea } from "@/lib/bytea";
import { evaluateGeofence } from "@/lib/geo";
import { guid } from "@/lib/ids";
import { broadcastToSession } from "@/lib/realtime";
import { rp } from "@/lib/webauthn";
import { claimDeviceInstallation } from "@/lib/device-installation";

const MAX_GEO_TRIES = 3;
const schema = z.object({
  attemptId: guid,
  assertion: z.looseObject({
    id: z.string().max(1024), rawId: z.string().max(1024), type: z.literal("public-key"),
    response: z.looseObject({ clientDataJSON: z.string().max(4096), authenticatorData: z.string().max(4096), signature: z.string().max(4096) }),
  }),
  location: z.object({ latitude: z.number(), longitude: z.number(), accuracy: z.number() }),
  installationId: z.string().min(16).max(64),
  submitForReview: z.boolean().default(false),
});

type Db = ReturnType<typeof adminClient>;

/**
 * Step 2 of the handshake. Order matters:
 *   1. cheap, retryable GPS check (no crypto, attempt not consumed)
 *   2. WebAuthn assertion against the attempt's own challenge
 *   3. geofence rejection / installation checks (only for authenticated presences)
 *   4. ONE atomic database call that consumes the attempt and inserts the record
 */
export const POST = route(async (req) => {
  const actor = await requireActor("student");
  await rateLimit(`verify:${actor.id}`, 60, 20);
  const body = await readBody(req, schema);
  const db = adminClient();
  const { rpID, origin } = rp();

  const { data: attempt } = await db.from("attendance_attempts").select("*").eq("id", body.attemptId).eq("student_id", actor.id).maybeSingle();
  if (!attempt || attempt.consumed_at || new Date(attempt.expires_at).getTime() <= Date.now())
    throw new ApiError(400, "attempt_invalid", "This check-in expired. Scan the code on the screen again.");

  const { data: session } = await db.from("sessions")
    .select("id, status, subject:subjects(code, name), hall:halls(name, latitude, longitude, allowed_radius_meters, max_gps_accuracy_meters)")
    .eq("id", attempt.session_id).single();
  if (!session || session.status !== "active") throw new ApiError(409, "session_not_active", "Attendance is no longer open for this session.");
  const hall = session.hall as unknown as { name: string; latitude: number; longitude: number; allowed_radius_meters: number; max_gps_accuracy_meters: number };
  const subject = session.subject as unknown as { code: string; name: string };

  // 1. GPS (retryable)
  const geo = evaluateGeofence(body.location, hall);
  if (geo.result === "invalid") throw new ApiError(400, "invalid_location", "Your location could not be read. Try again.");
  let forReview = false;
  if (geo.result === "poor_accuracy" || geo.result === "uncertain") {
    const { data: tries } = await db.rpc("bump_geo_retry", { p_attempt_id: attempt.id, p_student_id: actor.id, p_max: MAX_GEO_TRIES });
    const used = Number(tries ?? MAX_GEO_TRIES);
    const canReview = used >= 2;
    if (used < MAX_GEO_TRIES && !(body.submitForReview && canReview)) {
      return json({
        status: "retry", reason: geo.result, retriesLeft: Math.max(MAX_GEO_TRIES - used, 0), canSubmitForReview: canReview,
        accuracyMeters: Math.round(body.location.accuracy), maxAccuracyMeters: hall.max_gps_accuracy_meters,
      });
    }
    forReview = true; // retries exhausted (or student asked): route to lecturer review, never silently accept
  }

  // 2. WebAuthn
  const { data: cred } = await db.from("webauthn_credentials").select("*")
    .eq("credential_id", body.assertion.id).eq("user_id", actor.id).is("revoked_at", null).maybeSingle();

  // Safe diagnostics: authenticator flags only; never log the credential ID, challenge, signature,
  // clientDataJSON, or raw authenticator data.
  const authenticatorData = Buffer.from(body.assertion.response.authenticatorData, "base64url");
  const flagsByte = authenticatorData.length >= 33 ? authenticatorData[32] : null;
  const assertionDiagnostics = {
    authenticatorDataLength: authenticatorData.length,
    flagsHex: flagsByte === null ? null : `0x${flagsByte.toString(16).padStart(2, "0")}`,
    userPresent: flagsByte !== null && (flagsByte & 0x01) !== 0,
    userVerified: flagsByte !== null && (flagsByte & 0x04) !== 0,
    backupEligible: flagsByte !== null && (flagsByte & 0x08) !== 0,
    backedUp: flagsByte !== null && (flagsByte & 0x10) !== 0,
  };
  console.info("[webauthn] assertion diagnostics", assertionDiagnostics);

  let verified = false, newCounter = 0, deviceType: string | undefined, backedUp: boolean | undefined, failure = "unknown credential";
  if (cred) {
    try {
      const v = await verifyAuthenticationResponse({
        response: body.assertion as unknown as AuthenticationResponseJSON,
        expectedChallenge: attempt.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: cred.credential_id, publicKey: fromBytea(cred.public_key), counter: Number(cred.sign_count), transports: (cred.transports ?? undefined) as never },
      });
      verified = v.verified; newCounter = v.authenticationInfo.newCounter;
      deviceType = v.authenticationInfo.credentialDeviceType; backedUp = v.authenticationInfo.credentialBackedUp;
      if (!verified) failure = "not verified";
    } catch (e) { failure = e instanceof Error ? e.message : "verification error"; }
  }
  if (!verified) {
    await db.rpc("record_attempt_failure", { p_attempt_id: attempt.id, p_student_id: actor.id, p_max: 3 });
    console.warn("[webauthn] assertion verification failed", {
      reason: failure.slice(0, 160),
      credentialFound: Boolean(cred),
      ...assertionDiagnostics,
    });
    await audit(actor.id, "attendance.verify_failed", "attempt", attempt.id, {
      reason: failure.slice(0, 160),
      credentialFound: Boolean(cred),
      ...assertionDiagnostics,
    });
    if (/counter/i.test(failure)) await flag(db, attempt, actor, "passkey_counter_regression", "high", { credential: cred?.id });
    throw new ApiError(401, "verification_failed", "Passkey verification failed. Try again.");
  }
  await db.from("webauthn_credentials").update({ sign_count: newCounter, last_used_at: new Date().toISOString(), device_type: deviceType, backed_up: backedUp }).eq("id", cred!.id);

  // 3a. Outside the geofence even allowing for GPS error: reject + flag (burns the attempt)
  if (geo.result === "outside") {
    await db.rpc("record_attempt_failure", { p_attempt_id: attempt.id, p_student_id: actor.id, p_max: 1 });
    await flag(db, attempt, actor, "outside_geofence", "high", { distance_m: Math.round(geo.distanceMeters ?? 0), accuracy_m: Math.round(body.location.accuracy) });
    await audit(actor.id, "attendance.outside_geofence", "attempt", attempt.id);
    throw new ApiError(403, "outside_geofence", "You don't appear to be in the lecture hall. Ask your lecturer to check you in manually.");
  }

  // 3b. Enforce the same browser/PWA ownership claim again at final submission.
  // A client cannot bypass the login gate by changing its installation ID between steps.
  const inst = await claimDeviceInstallation(actor.id, body.installationId);
  if (inst.outcome !== "created" && inst.outcome !== "existing") {
    await db.rpc("record_attempt_failure", { p_attempt_id: attempt.id, p_student_id: actor.id, p_max: 1 });
    const flagType = inst.outcome === "revoked" ? "revoked_installation"
      : inst.outcome === "new_installation_requires_admin" ? "unapproved_new_installation"
        : inst.outcome === "installation_identity_changed" ? "installation_identity_changed" : "shared_installation";
    await flag(db, attempt, actor, flagType, "high", {});
    await audit(actor.id, "attendance.device_conflict", "attempt", attempt.id, { kind: inst.outcome });
    const code = inst.outcome === "owned_by_another_student" ? "device_conflict"
      : inst.outcome === "revoked" ? "device_revoked"
        : inst.outcome === "installation_identity_changed" ? "device_identity_changed" : "device_approval_required";
    throw new ApiError(403, code, code === "device_conflict"
      ? "This browser or installed app is already assigned to another student account."
      : code === "device_revoked"
        ? "This browser or device registration has been revoked. Contact your administrator."
        : code === "device_identity_changed"
          ? "This browser's saved installation identity changed. Contact your administrator before clearing storage or switching accounts."
          : "This student account is already linked to another browser or device. Ask your administrator to verify you and reset the previous device.");
  }

  // 4. Atomic commit
  const { data, error } = await db.rpc("commit_qr_attendance", {
    p_attempt_id: attempt.id, p_student_id: actor.id, p_credential_id: cred!.id, p_installation_id: inst.deviceInstallationId,
    p_status: forReview ? "review" : "auto", p_latitude: body.location.latitude, p_longitude: body.location.longitude,
    p_distance: geo.distanceMeters, p_accuracy: body.location.accuracy, p_geo_result: forReview ? geo.result : "ok",
  });
  const out = Array.isArray(data) ? data[0] : data;
  if (error || !out) throw new Error("commit failed: " + error?.message);

  switch (out.outcome) {
    case "committed": break;
    case "duplicate_student": throw new ApiError(409, "already_checked_in", "You are already checked in.");
    case "duplicate_installation":
      await flag(db, attempt, actor, "duplicate_installation", "high", {});
      throw new ApiError(403, "device_conflict", "This device has already been used to check in another account.");
    case "session_closed": throw new ApiError(409, "session_not_active", "Attendance is no longer open for this session.");
    default: throw new ApiError(400, "attempt_invalid", "This check-in expired. Scan the code on the screen again.");
  }

  if (forReview) await flag(db, attempt, actor, "geo_uncertain", "medium", { reason: geo.result, distance_m: Math.round(geo.distanceMeters ?? 0), accuracy_m: Math.round(body.location.accuracy) });

  const checkedInAt = new Date().toISOString();
  await broadcastToSession(attempt.session_id, "attendance", {
    recordId: out.record_id, name: actor.fullName, idSuffix: actor.universityId.slice(-4), status: out.status, at: checkedInAt,
  });

  return json({
    status: out.status, review: forReview, checkedInAt,
    student: { name: actor.fullName, universityId: actor.universityId }, subject,
  });
});

async function flag(db: Db, attempt: { id: string; session_id: string }, actor: Actor, type: string, severity: string, details: Record<string, unknown>) {
  await db.from("attendance_flags").insert({ session_id: attempt.session_id, student_id: actor.id, attempt_id: attempt.id, flag_type: type, severity, details });
}

