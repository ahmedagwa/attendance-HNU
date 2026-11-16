import "server-only";
import { createHmac } from "node:crypto";
import { serverEnv } from "./env";
import { parseMasterKey } from "./qr";

export function rp() {
  const e = serverEnv();
  return { rpID: e.WEBAUTHN_RP_ID, origin: e.WEBAUTHN_ORIGIN, name: e.WEBAUTHN_RP_NAME };
}

/** Only a keyed hash of the browser installation ID is stored; the raw value never reaches the database. */
export function hashInstallationId(installationId: string): string {
  const env = serverEnv();
  // Keep this key independent from QR encryption on new deployments. The fallback
  // preserves hashes already stored by earlier project versions. Never rotate it
  // after student installations have been registered without a planned migration.
  const key = env.INSTALLATION_HASH_KEY ?? env.QR_MASTER_KEY;
  return createHmac("sha256", parseMasterKey(key)).update("installation:" + installationId).digest("hex");
}
