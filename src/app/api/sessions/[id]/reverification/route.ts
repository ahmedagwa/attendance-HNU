import { randomInt } from "node:crypto";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, route, type IdCtx } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { requireSessionManager } from "@/lib/services/session-access";

const SPOT_CHECK_SECONDS = 20;

/** Starts a 20 s human-presence spot check: a random code shown on the projector. Not a cryptographic guarantee. */
export const POST = route<IdCtx>(async (_req, { params }) => {
  const actor = await requireActor("lecturer", "admin");
  await rateLimit(`spot-check:${actor.id}`, 60, 6);
  const session = await requireSessionManager(actor, (await params).id);
  if (session.status !== "active") throw new ApiError(409, "session_not_active", "Start or resume the session first.");

  const code = String(randomInt(10, 100));
  const { data, error } = await adminClient().rpc("create_reverification", { p_session_id: session.id, p_issued_by: actor.id, p_code: code, p_ttl_seconds: SPOT_CHECK_SECONDS });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) throw new Error("spot check failed: " + error?.message);
  await audit(actor.id, "spotcheck.started", "session", session.id, { challenge_id: row.challenge_id });
  return json({ id: row.challenge_id, code, expiresAt: row.expires_at }, 201);
});
