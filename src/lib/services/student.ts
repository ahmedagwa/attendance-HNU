import "server-only";
import { adminClient } from "../supabase/admin";
import { serverEnv } from "../env";
import { localParts } from "../time";
import type { Actor } from "../auth";

export type ScheduleItem = { id: string; subjectCode: string; subjectName: string; groupName: string; hallName: string; start: string; end: string };
export type OpenSession = { id: string; subjectCode: string; subjectName: string; hallName: string; groupCode: string; startedAt: string; checkedIn: null | "present" | "late" | "review" | "rejected" };
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
  const subjectIds = (enrolled ?? []).map((row) => row.subject_id);
  const groupOf = new Map((enrolled ?? []).map((row) => [row.subject_id, row.group_id]));

  const [{ data: summary }, schedules, sessions, { count: passkeys }, { count: devices }] = await Promise.all([
    db.rpc("attendance_summary", { p_student_id: actor.id }),
    subjectIds.length
      ? db.from("class_schedules").select("id, subject_id, group_id, start_time, end_time, valid_from, valid_to, subject:subjects(code, name), group:student_groups(name), hall:halls(name)").in("subject_id", subjectIds).eq("weekday", weekday)
      : Promise.resolve({ data: [] as never[] }),
    subjectIds.length
      ? db.from("sessions").select("id, subject_id, started_at, subject:subjects(code, name), hall:halls(name)").in("subject_id", subjectIds).eq("status", "active")
      : Promise.resolve({ data: [] as never[] }),
    db.from("webauthn_credentials").select("id", { head: true, count: "exact" }).eq("user_id", actor.id).is("revoked_at", null),
    db.from("device_installations").select("id", { head: true, count: "exact" }).eq("user_id", actor.id).is("revoked_at", null),
  ]);

  const timetable: ScheduleItem[] = ((schedules.data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => groupOf.get(row.subject_id as string) === row.group_id)
    .filter((row) => (!row.valid_from || (row.valid_from as string) <= today) && (!row.valid_to || (row.valid_to as string) >= today))
    .map((row) => ({
      id: row.id as string, subjectCode: (row.subject as { code: string }).code, subjectName: (row.subject as { name: string }).name,
      groupName: (row.group as { name: string }).name, hallName: (row.hall as { name: string }).name,
      start: String(row.start_time).slice(0, 5), end: String(row.end_time).slice(0, 5),
    }))
    .sort((a, b) => a.start.localeCompare(b.start));

  const activeSessions = (sessions.data ?? []) as Array<Record<string, unknown>>;
  const activeIds = activeSessions.map((row) => row.id as string);
  const { data: sessionGroupRows } = activeIds.length
    ? await db.from("session_groups").select("session_id, group_id, group:student_groups(group_code)").in("session_id", activeIds)
    : { data: [] as Array<{ session_id: string; group_id: string; group: unknown }> };
  const groupBySession = new Map<string, string>();
  const eligibleSessionIds = new Set<string>();
  for (const row of (sessionGroupRows ?? []) as unknown as Array<{ session_id: string; group_id: string; group: { group_code: string } }>) {
    const session = activeSessions.find((item) => item.id === row.session_id);
    if (session && groupOf.get(session.subject_id as string) === row.group_id) {
      eligibleSessionIds.add(row.session_id);
      groupBySession.set(row.session_id, row.group.group_code);
    }
  }
  const open = activeSessions.filter((row) => eligibleSessionIds.has(row.id as string));
  const { data: records } = open.length
    ? await db.from("attendance_records").select("session_id, status").eq("student_id", actor.id).in("session_id", open.map((row) => row.id as string))
    : { data: [] as Array<{ session_id: string; status: string }> };
  const recordOf = new Map((records ?? []).map((row) => [row.session_id, row.status]));
  const openSessions: OpenSession[] = open.map((row) => ({
    id: row.id as string,
    subjectCode: (row.subject as { code: string }).code,
    subjectName: (row.subject as { name: string }).name,
    hallName: (row.hall as { name: string }).name,
    groupCode: groupBySession.get(row.id as string) ?? "",
    startedAt: row.started_at as string,
    checkedIn: (recordOf.get(row.id as string) ?? null) as OpenSession["checkedIn"],
  }));

  const subjects: SubjectAttendance[] = ((summary ?? []) as Array<Record<string, unknown>>).map((row) => ({
    subjectId: row.subject_id as string, code: row.subject_code as string, name: row.subject_name as string,
    requiredPercent: Number(row.required_percent), held: Number(row.sessions_held), attended: Number(row.attended),
    percent: Number(row.percent), belowLimit: Boolean(row.below_limit),
  }));

  return { subjects, timetable, openSessions, hasPasskey: (passkeys ?? 0) > 0, hasDevice: (devices ?? 0) > 0 };
}
