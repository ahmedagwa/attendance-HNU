import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { ApiError, json, readBody, route } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { claimDeviceInstallation } from "@/lib/device-installation";

const schema = z.object({ installationId: z.string().min(16).max(64) });

/**
 * Called immediately after sign-in and again after passkey enrollment.
 * Staff accounts are not enrolled in the student device-ownership policy.
 */
export const POST = route(async (req) => {
  const actor = await requireActor();
  if (actor.role !== "student") return json({ ok: true, skipped: true });

  await rateLimit(`device-reg:${actor.id}`, 300, 10);
  const { installationId } = await readBody(req, schema);
  const claim = await claimDeviceInstallation(actor.id, installationId);

  switch (claim.outcome) {
    case "created": {
      await audit(actor.id, "device.registered", "device_installation", claim.deviceInstallationId, { binding: "first_installation" });
      const response = json({ ok: true, linked: true });
      response.cookies.set("attendance_device_binding", claim.installationHash, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
      return response;
    }
    case "existing": {
      const response = json({ ok: true, linked: true });
      response.cookies.set("attendance_device_binding", claim.installationHash, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
      return response;
    }
    case "owned_by_another_student":
      await audit(actor.id, "device.login_blocked", "device_installation", claim.deviceInstallationId, { reason: "installation_owned_by_another_student" });
      throw new ApiError(409, "device_conflict", "This browser or installed app is already assigned to another student account.");
    case "revoked":
      await audit(actor.id, "device.login_blocked", "device_installation", claim.deviceInstallationId, { reason: "installation_revoked" });
      throw new ApiError(409, "device_revoked", "This browser or device registration has been revoked. Contact your administrator.");
    case "new_installation_requires_admin":
      await audit(actor.id, "device.change_requested", "user", actor.id, { reason: "new_browser_installation_requires_admin" });
      throw new ApiError(409, "device_approval_required", "This student account is already linked to another browser or device. Ask your administrator to verify you and reset the previous device before using this one.");
    case "installation_identity_changed":
      await audit(actor.id, "device.login_blocked", "user", actor.id, { reason: "browser_installation_id_changed" });
      throw new ApiError(409, "device_identity_changed", "This browser's saved installation identity changed. Contact your administrator before clearing storage or switching accounts.");
    default:
      throw new ApiError(500, "device_claim_failed", "Could not verify this device.");
  }
});
