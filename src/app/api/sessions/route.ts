import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { guid } from "@/lib/ids";
import { serverEnv } from "@/lib/env";
import { encryptSecret, generateSessionSecret, parseMasterKey } from "@/lib/qr";

const schema = z.object({
  subjectId: guid,
  groupIds: z.array(guid).min(1).max(20).refine((ids) => new Set(ids).size === ids.length, "Groups must be unique"),
  hallId: guid,
  lateThresholdMinutes: z.number().int().min(0).max(180).default(15),
});

export const POST = route(async (req) => {
  const actor = await requireActor("lecturer");
  await rateLimit(`session-create:${actor.id}`, 60, 10);
  const body = await readBody(req, schema);
  const db = adminClient();
  const secret = generateSessionSecret();
  const { data, error } = await db.rpc("create_lecture_session", {
    p_subject_id: body.subjectId,
    p_group_ids: body.groupIds,
    p_hall_id: body.hallId,
    p_started_by: actor.id,
    p_late_threshold_minutes: body.lateThresholdMinutes,
    p_qr_period_seconds: 10,
    p_qr_secret_enc: encryptSecret(secret, parseMasterKey(serverEnv().QR_MASTER_KEY)),
  });
  if (error) {
    if (error.code === "42501") throw new ApiError(403, "forbidden", "You are not assigned to this subject.");
    throw new ApiError(422, "session_create_failed", error.message || "Could not create the lecture session.");
  }

  const result = Array.isArray(data) ? data[0] : data;
  const sessionId = result && typeof result === "object" ? (result as { session_id?: string }).session_id : undefined;
  const outcome = result && typeof result === "object" ? (result as { outcome?: string }).outcome : undefined;
  if (!sessionId) throw new Error("session creation RPC returned no session id");
  if (outcome === "session_already_open") {
    throw new ApiError(409, "session_already_open", "An active session already covers one or more selected groups.", { sessionId });
  }
  if (outcome !== "created") throw new ApiError(422, "session_create_failed", "Could not create the lecture session.");

  return json({ id: sessionId }, 201);
});
