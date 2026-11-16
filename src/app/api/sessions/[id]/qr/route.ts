import { requireActor } from "@/lib/auth";
import { ApiError, json, route, type IdCtx } from "@/lib/http";
import { buildQrPayload, currentBucket } from "@/lib/qr";
import { requireSessionManager, sessionSecret } from "@/lib/services/session-access";

/** The secret never leaves the server: the projector only receives the signed payload for "now". */
export const GET = route<IdCtx>(async (_req, { params }) => {
  const actor = await requireActor("lecturer", "admin");
  const session = await requireSessionManager(actor, (await params).id);
  if (session.status === "closed") throw new ApiError(409, "session_closed", "This session is closed.");
  if (session.status === "paused") return json({ status: "paused", serverTimeMs: Date.now() });

  const nowMs = Date.now();
  const period = session.qr_period_seconds;
  const bucket = currentBucket(nowMs, period);
  return json({
    status: "active", payload: buildQrPayload(sessionSecret(session), session.id, bucket), bucket,
    periodSeconds: period, serverTimeMs: nowMs, msToNext: (bucket + 1) * period * 1000 - nowMs,
  });
});
