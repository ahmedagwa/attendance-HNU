import { timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { ApiError, json, route } from "@/lib/http";
import { audit } from "@/lib/audit";

/** Daily job (Vercel Cron): purge raw GPS past the retention window and stale rate-limit rows. */
export const GET = route(async (req) => {
  const secret = serverEnv().CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) throw new ApiError(401, "unauthenticated");

  const db = adminClient();
  const days = serverEnv().GPS_RETENTION_DAYS;
  const { data: purged, error: gpsErr } = await db.rpc("purge_raw_gps", { p_retention: `${days} days` });
  const { data: limits, error: limitErr } = await db.rpc("purge_rate_limits");
  // Fail loudly so Vercel marks the cron run as failed instead of silently skipping retention.
  if (gpsErr || limitErr) throw new Error("maintenance failed: " + (gpsErr ?? limitErr)?.message);
  await audit(null, "maintenance.ran", "system", null, { gps_rows_purged: purged, rate_limit_rows_purged: limits, retention_days: days });
  return json({ gpsRowsPurged: purged, rateLimitRowsPurged: limits });
});
