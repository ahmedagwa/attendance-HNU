import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { json, route, type IdCtx } from "@/lib/http";
import { requireSessionManager } from "@/lib/services/session-access";
import { loadRoster } from "@/lib/services/roster";

/** Authoritative state for the projector and control room (initial load + reconciliation). */
export const GET = route<IdCtx>(async (_req, { params }) => {
  const actor = await requireActor("lecturer", "admin");
  const session = await requireSessionManager(actor, (await params).id);
  const db = adminClient();

  const [{ data: summaryRows }, roster, { data: flags }, { data: challenge }] = await Promise.all([
    db.rpc("session_summary", { p_session_id: session.id }),
    loadRoster(session),
    db.from("attendance_flags").select("id, student_id, flag_type, severity, details, created_at, student:profiles(full_name, university_id)")
      .eq("session_id", session.id).eq("status", "open").order("created_at", { ascending: false }),
    db.from("reverification_challenges").select("id, prompt_payload, issued_at, expires_at").eq("session_id", session.id).order("issued_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  let spotCheck = null;
  if (challenge) {
    const { data: responses } = await db.from("reverification_responses").select("student_id, is_correct").eq("challenge_id", challenge.id);
    const answered = new Map((responses ?? []).map((r) => [r.student_id, r.is_correct]));
    const present = roster.filter((r) => r.status === "present" || r.status === "late");
    spotCheck = {
      id: challenge.id, code: challenge.prompt_payload.code as string, expiresAt: challenge.expires_at,
      active: new Date(challenge.expires_at).getTime() > Date.now(),
      responded: answered.size, correct: [...answered.values()].filter(Boolean).length,
      nonResponders: present.filter((r) => !answered.has(r.studentId)).map((r) => ({ studentId: r.studentId, fullName: r.fullName, universityId: r.universityId })),
    };
  }

  const recent = roster.filter((r) => r.checkedInAt).sort((a, b) => b.checkedInAt!.localeCompare(a.checkedInAt!)).slice(0, 25);
  return json({
    session: { id: session.id, status: session.status, startedAt: session.started_at, subject: session.subject },
    summary: Array.isArray(summaryRows) ? summaryRows[0] : summaryRows,
    roster, recent, flags: flags ?? [], spotCheck, serverTimeMs: Date.now(),
  });
});
