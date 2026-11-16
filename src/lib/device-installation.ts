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
 */
export async function claimDeviceInstallation(userId: string, installationId: string): Promise<DeviceClaim> {
  const db = adminClient();
  const installationHash = hashInstallationId(installationId);

  // HttpOnly cookie survives ordinary IndexedDB clearing and prevents the client from
  // silently replacing its installation ID while the browser binding still exists.
  const cookieStore = await cookies();
  const cookieHash = cookieStore.get("attendance_device_binding")?.value;
  if (cookieHash && cookieHash !== installationHash) {
    return { outcome: "installation_identity_changed", deviceInstallationId: null, installationHash };
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

  // The database RPC never returns `installation_identity_changed`; that outcome is
  // produced above when the HttpOnly cookie and IndexedDB identity disagree. Keep the
  // RPC result narrowed explicitly so TypeScript cannot accidentally pair that
  // null-ID outcome with a database UUID.
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
