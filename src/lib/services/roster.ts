import "server-only";

import { adminClient } from "../supabase/admin";
import type { SessionRow } from "./session-access";

export type RosterRow = {
  studentId: string; universityId: string; fullName: string; groupCode: string;
  status: "present" | "late" | "review" | "rejected" | "absent";
  source: "qr" | "manual" | null; checkedInAt: string | null; manualReason: string | null;
};

/** Every enrolled student in any selected session group, with their attendance state. */
export async function loadRoster(session: Pick<SessionRow, "id" | "subject_id" | "groupIds">): Promise<RosterRow[]> {
  const db = adminClient();
  if (!session.groupIds.length) return [];
  const [{ data: enrolled }, { data: records }] = await Promise.all([
    db.from("enrollments")
      .select("student_id, group:student_groups(group_code), student:profiles(university_id, full_name)")
      .eq("subject_id", session.subject_id)
      .in("group_id", session.groupIds),
    db.from("attendance_records").select("student_id, status, source, checked_in_at, manual_reason").eq("session_id", session.id),
  ]);
  const byStudent = new Map((records ?? []).map((record) => [record.student_id, record]));
  return (enrolled ?? []).map((entry) => {
    const record = byStudent.get(entry.student_id);
    const student = entry.student as unknown as { university_id: string; full_name: string };
    const group = entry.group as unknown as { group_code: string };
    return {
      studentId: entry.student_id, universityId: student.university_id, fullName: student.full_name, groupCode: group.group_code,
      status: (record?.status ?? "absent") as RosterRow["status"], source: (record?.source ?? null) as RosterRow["source"],
      checkedInAt: record?.checked_in_at ?? null, manualReason: record?.manual_reason ?? null,
    };
  }).sort((a, b) => a.universityId.localeCompare(b.universityId, undefined, { numeric: true }));
}
