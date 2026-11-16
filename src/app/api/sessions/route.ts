import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { guid } from "@/lib/ids";
import { serverEnv } from "@/lib/env";
import { encryptSecret, generateSessionSecret, parseMasterKey } from "@/lib/qr";

const schema = z.object({
  subjectId: guid, groupId: guid.nullable(), hallId: guid,
  lateThresholdMinutes: z.number().int().min(0).max(180).default(15),
});

export const POST = route(async (req) => {
  const actor = await requireActor("lecturer");
  await rateLimit(`session-create:${actor.id}`, 60, 10);
  const body = await readBody(req, schema);
  const db = adminClient();

  const { data: subject } = await db.from("subjects").select("id, lecturer_id, is_active").eq("id", body.subjectId).maybeSingle();
  if (!subject || !subject.is_active || subject.lecturer_id !== actor.id) throw new ApiError(403, "forbidden", "You can only start sessions for your own subjects.");

  if (body.groupId) {
    const { count } = await db.from("enrollments").select("student_id", { head: true, count: "exact" }).eq("subject_id", body.subjectId).eq("group_id", body.groupId);
    if (!count) throw new ApiError(422, "invalid_group", "No students from that group are enrolled in this subject.");
  }
  const { data: hall } = await db.from("halls").select("id, is_active").eq("id", body.hallId).maybeSingle();
  if (!hall?.is_active) throw new ApiError(422, "invalid_hall", "Choose an active lecture hall.");

  const { data: open } = await db.from("sessions").select("id, group_id").eq("subject_id", body.subjectId).in("status", ["active", "paused"]);
  const clash = (open ?? []).find((s) => body.groupId === null || s.group_id === null || s.group_id === body.groupId);
  if (clash) throw new ApiError(409, "session_already_open", "A session is already open for this subject and group.", { sessionId: clash.id });

  const secret = generateSessionSecret();
  const { data: created, error } = await db.from("sessions").insert({
    subject_id: body.subjectId, group_id: body.groupId, hall_id: body.hallId, started_by: actor.id,
    late_threshold_minutes: body.lateThresholdMinutes, qr_period_seconds: 10,
    qr_secret_enc: encryptSecret(secret, parseMasterKey(serverEnv().QR_MASTER_KEY)),
  }).select("id").single();
  if (error || !created) throw new Error("session insert failed: " + error?.message);

  await audit(actor.id, "session.started", "session", created.id, { subject_id: body.subjectId, group_id: body.groupId, hall_id: body.hallId });
  return json({ id: created.id }, 201);
});
