import "server-only";

import { adminClient } from "../supabase/admin";
import type { SessionRow } from "./session-access";

export type RosterRow = {
  studentId: string; universityId: string; fullName: string; groupCode: string;
  status: "present" | "late" | "review" | "rejected" | "absent";
  source: "qr" | "manual" | null; checkedInAt: string | null; manualReason: string | null;
};

/** Every enrolled student for the session, with their attendance state (absent = no record). */
export async function loadRoster(session: Pick<SessionRow, "id" | "subject_id" | "group_id">): Promise<RosterRow[]> {
  const db = adminClient();
  let q = db.from("enrollments").select("student_id, group:student_groups(group_code), student:profiles(university_id, full_name)").eq("subject_id", session.subject_id);
  if (session.group_id) q = q.eq("group_id", session.group_id);
  const [{ data: enrolled }, { data: records }] = await Promise.all([
    q,
    db.from("attendance_records").select("student_id, status, source, checked_in_at, manual_reason").eq("session_id", session.id),
  ]);
  const byStudent = new Map((records ?? []).map((r) => [r.student_id, r]));
  return (enrolled ?? []).map((e) => {
    const r = byStudent.get(e.student_id);
    const student = e.student as unknown as { university_id: string; full_name: string };
    const group = e.group as unknown as { group_code: string };
    return {
      studentId: e.student_id, universityId: student.university_id, fullName: student.full_name, groupCode: group.group_code,
      status: (r?.status ?? "absent") as RosterRow["status"], source: (r?.source ?? null) as RosterRow["source"],
      checkedInAt: r?.checked_in_at ?? null, manualReason: r?.manual_reason ?? null,
    };
  }).sort((a, b) => a.universityId.localeCompare(b.universityId, undefined, { numeric: true }));
}
