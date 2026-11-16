import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route, type IdCtx } from "@/lib/http";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/ids";
import { broadcastToSession } from "@/lib/realtime";
import { requireSessionManager } from "@/lib/services/session-access";

const schema = z.object({ decision: z.enum(["approve", "dismiss", "reject"]), note: z.string().trim().max(300).optional() });

export const POST = route<IdCtx>(async (req, { params }) => {
  const actor = await requireActor("lecturer", "admin");
  const id = (await params).id;
  const { decision, note } = await readBody(req, schema);
  if (!isUuid(id)) throw new ApiError(404, "not_found");
  const db = adminClient();

  const { data: flag } = await db.from("attendance_flags").select("*").eq("id", id).maybeSingle();
  if (!flag) throw new ApiError(404, "not_found");
  const session = await requireSessionManager(actor, flag.session_id);
  if (flag.status !== "open") throw new ApiError(409, "already_resolved", "This flag was already resolved.");

  if (decision !== "dismiss") {
    const { data: rec } = await db.from("attendance_records").select("id, status, checked_in_at").eq("session_id", flag.session_id).eq("student_id", flag.student_id).maybeSingle();
    if (rec?.status === "review") {
      const lateAfter = new Date(session.started_at).getTime() + session.late_threshold_minutes * 60_000;
      const next = decision === "reject" ? "rejected" : new Date(rec.checked_in_at).getTime() > lateAfter ? "late" : "present";
      await db.from("attendance_records").update({ status: next }).eq("id", rec.id);
      await broadcastToSession(session.id, "attendance", { recordId: rec.id, status: next, resolved: true });
    }
  }
  const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "dismissed";
  await db.from("attendance_flags").update({ status, resolved_by: actor.id, resolved_at: new Date().toISOString(), resolution_note: note ?? null }).eq("id", id);
  await audit(actor.id, "flag.resolved", "attendance_flag", id, { decision, note: note ?? null, flag_type: flag.flag_type, student_id: flag.student_id });
  return json({ ok: true, status });
});
