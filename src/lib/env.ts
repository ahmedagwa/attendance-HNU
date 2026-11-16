import "server-only";
import { z } from "zod";
import { parseMasterKey } from "./qr";

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.url(),
  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_ORIGIN: z.url(),
  WEBAUTHN_RP_NAME: z.string().default("University Attendance"),
  QR_MASTER_KEY: z.string().refine((v) => { try { parseMasterKey(v); return true; } catch { return false; } }, "QR_MASTER_KEY must be 32 bytes (base64 or 64 hex chars)"),
  // Optional for backwards compatibility. Set before first device registration on a new deployment.
  INSTALLATION_HASH_KEY: z.string().optional().refine((v) => { if (!v) return true; try { parseMasterKey(v); return true; } catch { return false; } }, "INSTALLATION_HASH_KEY must be 32 bytes (base64 or 64 hex chars)"),
  CRON_SECRET: z.string().optional(),
  ATTENDANCE_TIMEZONE: z.string().default("Africa/Cairo"),
  GPS_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export type ServerEnv = z.infer<typeof schema>;
let cached: ServerEnv | undefined;

/** Validated lazily so `next build` does not need secrets; fails loudly on first real use. */
export function serverEnv(): ServerEnv {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error("Invalid server configuration: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    cached = parsed.data;
  }
  return cached;
}
