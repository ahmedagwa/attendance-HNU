import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route, type IdCtx } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { guid, isUuid } from "@/lib/ids";

const schema = z.object({ challengeId: guid, code: z.string().trim().regex(/^\d{2}$/) });

export const POST = route<IdCtx>(async (req, { params }) => {
  const actor = await requireActor("student");
  await rateLimit(`spot-respond:${actor.id}`, 60, 10);
  const sessionId = (await params).id;
  const body = await readBody(req, schema);
  if (!isUuid(sessionId)) throw new ApiError(404, "not_found");
  const db = adminClient();

  const { data: ch } = await db.from("reverification_challenges").select("id, session_id, prompt_payload, expires_at").eq("id", body.challengeId).eq("session_id", sessionId).maybeSingle();
  const { data: rec } = await db.from("attendance_records").select("status").eq("session_id", sessionId).eq("student_id", actor.id).in("status", ["present", "late", "review"]).maybeSingle();
  if (!ch || !rec) throw new ApiError(404, "not_found");
  if (new Date(ch.expires_at).getTime() < Date.now()) throw new ApiError(410, "challenge_expired", "That spot check has ended.");

  const correct = ch.prompt_payload.code === body.code;
  const { error } = await db.from("reverification_responses").insert({ challenge_id: ch.id, student_id: actor.id, response_value: body.code, is_correct: correct });
  if (error?.code === "23505") throw new ApiError(409, "already_responded", "You already answered this spot check.");
  if (error) throw new Error("response insert failed: " + error.message);
  return json({ correct });
});
