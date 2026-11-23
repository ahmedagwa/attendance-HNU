import "server-only";
import { cookies } from "next/headers";
import { adminClient } from "@/lib/supabase/admin";
import { hashInstallationId } from "@/lib/webauthn";

export type DeviceClaim =
  | { outcome: "created" | "existing"; deviceInstallationId: string; installationHash: string }
  | { outcome: "owned_by_another_student" | "revoked" | "new_installation_requires_admin"; deviceInstallationId: string; installationHash: string }
  | { outcome: "installation_identity_changed"; deviceInstallationId: null; installationHash: string };

/**
 * Atomically binds one browser/PWA installation to one student account.
 * The raw installation ID is never written to PostgreSQL; only its keyed hash is stored.
 *
 * The HttpOnly cookie is the server-verified anchor for an already registered browser.
 * IndexedDB can legitimately be recreated (for example, after a browser storage issue),
 * and the installation-hash key may be migrated independently of the QR encryption key.
 * If the cookie still points to an active installation owned by this same student, keep
 * using that binding instead of treating the changed client-side ID/hash as a new device.
 *
 * A cookie belonging to another student is still rejected. A revoked cookie binding is
 * not reused: the normal database claim path must register a fresh installation after
 * an administrator has reset the previous one.
 */
export async function claimDeviceInstallation(userId: string, installationId: string): Promise<DeviceClaim> {
  const db = adminClient();
  const installationHash = hashInstallationId(installationId);

  const cookieStore = await cookies();
  const cookieHash = cookieStore.get("attendance_device_binding")?.value;

  if (cookieHash && !/^[a-f0-9]{64}$/i.test(cookieHash)) {
    console.error("[device-lock] ignoring malformed device-binding cookie");
  } else if (cookieHash && cookieHash !== installationHash) {
    // Check the cookie's database owner before falling back to the new client ID.
    // This preserves account-switch protection even when IndexedDB has been recreated.
    const { data: cookieDevice, error: cookieLookupError } = await db
      .from("device_installations")
      .select("id, user_id, revoked_at")
      .eq("installation_id_hash", cookieHash)
      .maybeSingle();

    if (cookieLookupError) {
      console.error("[device-lock] cookie binding lookup failed:", {
        code: cookieLookupError.code,
        message: cookieLookupError.message,
      });
      throw new Error("Could not verify the saved student browser installation.");
    }

    if (cookieDevice && cookieDevice.user_id !== userId) {
      return {
        outcome: "owned_by_another_student",
        deviceInstallationId: cookieDevice.id,
        installationHash: cookieHash,
      };
    }

    if (cookieDevice && cookieDevice.user_id === userId && cookieDevice.revoked_at === null) {
      const { error: touchError } = await db
        .from("device_installations")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", cookieDevice.id);

      if (touchError) {
        console.error("[device-lock] failed to update cookie-bound installation:", {
          code: touchError.code,
          message: touchError.message,
        });
        throw new Error("Could not update the student browser installation.");
      }

      // The HttpOnly cookie is still a valid active assignment for this account.
      // Keep using its hash so attendance attempts and commits reference the same row.
      return {
        outcome: "existing",
        deviceInstallationId: cookieDevice.id,
        installationHash: cookieHash,
      };
    }
    // If the cookie row is revoked or no longer exists, continue to the atomic claim.
    // That path permits a fresh ID only when no other active student assignment exists.
  }

  const { data, error } = await db.rpc("claim_device_installation", {
    p_user_id: userId,
    p_installation_id_hash: installationHash,
  });
  const result = Array.isArray(data) ? data[0] : data;
  if (error) {
    throw new Error("Device installation claim failed: " + error.message);
  }
  if (
    !result ||
    typeof result.outcome !== "string" ||
    typeof result.device_installation_id !== "string"
  ) {
    throw new Error("Device installation claim failed: empty or invalid database response");
  }

  const deviceInstallationId = result.device_installation_id;
  switch (result.outcome) {
    case "created":
    case "existing":
      return { outcome: result.outcome, deviceInstallationId, installationHash };
    case "owned_by_another_student":
    case "revoked":
    case "new_installation_requires_admin":
      return { outcome: result.outcome, deviceInstallationId, installationHash };
    default:
      throw new Error("Device installation claim failed: unknown database outcome");
  }
}

/**
 * Verify that the HttpOnly browser-binding cookie maps to an active installation
 * owned by this student. This is used by page/API guards so a direct Supabase
 * password login cannot bypass the LoginForm's device-claim step.
 */
export async function hasActiveDeviceBinding(userId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const installationHash = cookieStore.get("attendance_device_binding")?.value;
  if (!installationHash || !/^[a-f0-9]{64}$/i.test(installationHash)) return false;

  const { data, error } = await adminClient()
    .from("device_installations")
    .select("id")
    .eq("user_id", userId)
    .eq("installation_id_hash", installationHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    console.error("[device-lock] binding lookup failed:", { code: error.code, message: error.message });
    throw new Error("Could not verify the student browser installation.");
  }
  return Boolean(data);
}
