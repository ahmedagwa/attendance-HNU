import "server-only";
import { adminClient } from "../supabase/admin";
import { serverEnv } from "../env";
import { localParts } from "../time";
import type { Actor } from "../auth";

export type ScheduleItem = { id: string; subjectCode: string; subjectName: string; groupName: string; hallName: string; start: string; end: string };
export type OpenSession = { id: string; subjectCode: string; subjectName: string; hallName: string; startedAt: string; checkedIn: null | "present" | "late" | "review" | "rejected" };
export type SubjectAttendance = {
  subjectId: string; code: string; name: string; requiredPercent: number; held: number; attended: number; percent: number; belowLimit: boolean;
};

/** Everything the student home screen needs. Identity is the verified actor; no client-supplied ids. */
export async function getStudentDashboard(actor: Actor) {
  const db = adminClient();
  const tz = serverEnv().ATTENDANCE_TIMEZONE;
  const { weekday } = localParts(new Date(), tz);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

  const { data: enrolled } = await db.from("enrollments").select("subject_id, group_id").eq("student_id", actor.id);
  const subjectIds = (enrolled ?? []).map((e) => e.subject_id);
  const groupOf = new Map((enrolled ?? []).map((e) => [e.subject_id, e.group_id]));

  const [{ data: summary }, schedules, sessions, { count: passkeys }, { count: devices }] = await Promise.all([
    db.rpc("attendance_summary", { p_student_id: actor.id }),
    subjectIds.length
      ? db.from("class_schedules").select("id, subject_id, group_id, start_time, end_time, valid_from, valid_to, subject:subjects(code, name), group:student_groups(name), hall:halls(name)").in("subject_id", subjectIds).eq("weekday", weekday)
      : Promise.resolve({ data: [] as never[] }),
    subjectIds.length
      ? db.from("sessions").select("id, subject_id, group_id, started_at, subject:subjects(code, name), hall:halls(name)").in("subject_id", subjectIds).eq("status", "active")
      : Promise.resolve({ data: [] as never[] }),
    db.from("webauthn_credentials").select("id", { head: true, count: "exact" }).eq("user_id", actor.id).is("revoked_at", null),
    db.from("device_installations").select("id", { head: true, count: "exact" }).eq("user_id", actor.id).is("revoked_at", null),
  ]);

  const timetable: ScheduleItem[] = ((schedules.data ?? []) as Array<Record<string, unknown>>)
    .filter((s) => groupOf.get(s.subject_id as string) === s.group_id)
    .filter((s) => (!s.valid_from || (s.valid_from as string) <= today) && (!s.valid_to || (s.valid_to as string) >= today))
    .map((s) => ({
      id: s.id as string, subjectCode: (s.subject as { code: string }).code, subjectName: (s.subject as { name: string }).name,
      groupName: (s.group as { name: string }).name, hallName: (s.hall as { name: string }).name,
      start: String(s.start_time).slice(0, 5), end: String(s.end_time).slice(0, 5),
    }))
    .sort((a, b) => a.start.localeCompare(b.start));

  const open = ((sessions.data ?? []) as Array<Record<string, unknown>>).filter((s) => !s.group_id || groupOf.get(s.subject_id as string) === s.group_id);
  const { data: records } = open.length
    ? await db.from("attendance_records").select("session_id, status").eq("student_id", actor.id).in("session_id", open.map((s) => s.id as string))
    : { data: [] as Array<{ session_id: string; status: string }> };
  const recordOf = new Map((records ?? []).map((r) => [r.session_id, r.status]));
  const openSessions: OpenSession[] = open.map((s) => ({
    id: s.id as string, subjectCode: (s.subject as { code: string }).code, subjectName: (s.subject as { name: string }).name,
    hallName: (s.hall as { name: string }).name, startedAt: s.started_at as string, checkedIn: (recordOf.get(s.id as string) ?? null) as OpenSession["checkedIn"],
  }));

  const subjects: SubjectAttendance[] = ((summary ?? []) as Array<Record<string, unknown>>).map((r) => ({
    subjectId: r.subject_id as string, code: r.subject_code as string, name: r.subject_name as string, requiredPercent: Number(r.required_percent),
    held: Number(r.sessions_held), attended: Number(r.attended), percent: Number(r.percent), belowLimit: Boolean(r.below_limit),
  }));

  return { subjects, timetable, openSessions, hasPasskey: (passkeys ?? 0) > 0, hasDevice: (devices ?? 0) > 0 };
}
