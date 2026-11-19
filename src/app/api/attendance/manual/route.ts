import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { guid } from "@/lib/ids";
import { broadcastToSession } from "@/lib/realtime";
import { requireSessionManager } from "@/lib/services/session-access";

const schema = z.object({
  sessionId: guid, studentId: guid, status: z.enum(["present", "late"]),
  reason: z.string().trim().min(5, "A reason of at least 5 characters is required").max(300),
});

/** Controlled recovery path: reasoned, attributed, visibly marked source=manual, and audited. */
export const POST = route(async (req) => {
  const actor = await requireActor("lecturer", "admin");
  await rateLimit(`manual:${actor.id}`, 60, 30);
  const body = await readBody(req, schema);
  const session = await requireSessionManager(actor, body.sessionId);
  const db = adminClient();

  const { count } = session.groupIds.length
    ? await db.from("enrollments").select("student_id", { head: true, count: "exact" })
        .eq("subject_id", session.subject_id).eq("student_id", body.studentId).in("group_id", session.groupIds)
    : { count: 0 };
  if (!count) throw new ApiError(422, "not_enrolled", "That student is not enrolled in this session.");

  const { data: previous } = await db.from("attendance_records").select("status, source").eq("session_id", session.id).eq("student_id", body.studentId).maybeSingle();
  const { data: rec, error } = await db.from("attendance_records")
    .upsert({ session_id: session.id, student_id: body.studentId, status: body.status, source: "manual", manual_reason: body.reason, recorded_by: actor.id }, { onConflict: "session_id,student_id" })
    .select("id, checked_in_at").single();
  if (error || !rec) throw new Error("manual override failed: " + error?.message);

  await audit(actor.id, previous ? "attendance.manual_correction" : "attendance.manual_override", "attendance_record", rec.id, {
    session_id: session.id, student_id: body.studentId, status: body.status, reason: body.reason, previous: previous ?? null,
  });

  const { data: student } = await db.from("profiles").select("full_name, university_id").eq("id", body.studentId).single();
  await broadcastToSession(session.id, "attendance", {
    recordId: rec.id, name: student?.full_name, idSuffix: student?.university_id.slice(-4), status: body.status, at: rec.checked_in_at, manual: true,
  });
  return json({ ok: true, recordId: rec.id });
});
