import "server-only";
import { cookies } from "next/headers";
import { adminClient } from "@/lib/supabase/admin";
import { hashInstallationId } from "@/lib/webauthn";

type DeviceClaimOutcome =
  | "created"
  | "existing"
  | "owned_by_another_student"
  | "revoked"
  | "new_installation_requires_admin"
  | "installation_identity_changed";

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
  if (error || !result?.outcome || !result?.device_installation_id) {
    throw new Error("Device installation claim failed: " + (error?.message ?? "empty database response"));
  }
  return {
    outcome: result.outcome as DeviceClaimOutcome,
    deviceInstallationId: result.device_installation_id as string,
    installationHash,
  };
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
