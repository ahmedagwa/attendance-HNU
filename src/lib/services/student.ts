import "server-only";
import { adminClient } from "../supabase/admin";
import { serverEnv } from "../env";
import { localParts } from "../time";
import type { Actor } from "../auth";

export type ScheduleItem = { id: string; subjectCode: string; subjectName: string; groupName: string; hallName: string; start: string; end: string };
export type OpenSession = { id: string; subjectCode: string; subjectName: string; hallName: string; groupCode: string; startedAt: string; checkedIn: null | "present" | "late" | "review" | "rejected" };
export type StaffAttendance = {
  staffId: string;
  fullName: string;
  role: "professor" | "teaching_assistant";
  held: number;
  attended: number;
  percent: number | null;
  belowLimit: boolean;
};
export type SubjectAttendance = {
  subjectId: string;
  code: string;
  name: string;
  requiredPercent: number;
  held: number;
  attended: number;
  percent: number;
  belowLimit: boolean;
  staffAttendance: StaffAttendance[];
};

/** Everything the student home screen needs. Identity is the verified actor; no client-supplied ids. */
export async function getStudentDashboard(actor: Actor) {
  const db = adminClient();
  const tz = serverEnv().ATTENDANCE_TIMEZONE;
  const { weekday } = localParts(new Date(), tz);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

  const { data: enrolled } = await db.from("enrollments").select("subject_id, group_id").eq("student_id", actor.id);
  const subjectIds = [...new Set((enrolled ?? []).map((row) => row.subject_id))];
  const groupOf = new Map((enrolled ?? []).map((row) => [row.subject_id, row.group_id]));

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
    .filter((row) => groupOf.get(row.subject_id as string) === row.group_id)
    .filter((row) => (!row.valid_from || (row.valid_from as string) <= today) && (!row.valid_to || (row.valid_to as string) >= today))
    .map((row) => ({
      id: row.id as string, subjectCode: (row.subject as { code: string }).code, subjectName: (row.subject as { name: string }).name,
      groupName: (row.group as { name: string }).name, hallName: (row.hall as { name: string }).name,
      start: String(row.start_time).slice(0, 5), end: String(row.end_time).slice(0, 5),
    }))
    .sort((a, b) => a.start.localeCompare(b.start));

  // Only active sessions that include this student's enrolled group are visible as check-in options.
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
  // Backwards compatibility for a legacy one-group session if its session_groups row is absent.
  for (const session of activeSessions) {
    if (!eligibleSessionIds.has(session.id as string) && session.group_id && groupOf.get(session.subject_id as string) === session.group_id) {
      eligibleSessionIds.add(session.id as string);
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

  const baseSubjects: SubjectAttendance[] = ((summary ?? []) as Array<Record<string, unknown>>).map((row) => ({
    subjectId: row.subject_id as string, code: row.subject_code as string, name: row.subject_name as string,
    requiredPercent: Number(row.required_percent), held: Number(row.sessions_held), attended: Number(row.attended),
    percent: Number(row.percent), belowLimit: Boolean(row.below_limit), staffAttendance: [],
  }));

  // Per-staff attendance: a staff member's denominator includes only closed sessions
  // they personally started that covered this student's enrolled group. Other tutors'
  // sessions never affect this percentage.
  const closedQuery = subjectIds.length
    ? db.from("sessions").select("id, subject_id, group_id, started_by").in("subject_id", subjectIds).eq("status", "closed")
    : Promise.resolve({ data: [] as never[], error: null });
  const staffQuery = subjectIds.length
    ? db.from("subject_staff").select("subject_id, user_id, assignment_role").in("subject_id", subjectIds)
    : Promise.resolve({ data: [] as never[], error: null });
  const [{ data: closedSessions, error: closedSessionsError }, { data: assignments, error: assignmentsError }] = await Promise.all([closedQuery, staffQuery]);
  if (closedSessionsError) throw new Error(`Could not load closed sessions for staff attendance: ${closedSessionsError.message}`);
  if (assignmentsError) throw new Error(`Could not load subject teaching staff: ${assignmentsError.message}`);
  const closedRows = (closedSessions ?? []) as Array<{ id: string; subject_id: string; group_id: string | null; started_by: string | null }>;
  const closedIds = closedRows.map((row) => row.id);
  const { data: closedGroupRows, error: closedGroupError } = closedIds.length
    ? await db.from("session_groups").select("session_id, group_id").in("session_id", closedIds)
    : { data: [] as Array<{ session_id: string; group_id: string }>, error: null };
  if (closedGroupError) throw new Error(`Could not load groups for staff attendance sessions: ${closedGroupError.message}`);
  const groupIdsBySession = new Map<string, Set<string>>();
  for (const row of closedGroupRows ?? []) {
    const set = groupIdsBySession.get(row.session_id) ?? new Set<string>();
    set.add(row.group_id);
    groupIdsBySession.set(row.session_id, set);
  }
  for (const session of closedRows) {
    const set = groupIdsBySession.get(session.id) ?? new Set<string>();
    if (session.group_id) set.add(session.group_id);
    groupIdsBySession.set(session.id, set);
  }

  const eligibleBySession = new Map<string, string>();
  const staffStats = new Map<string, { held: number; attended: number }>();
  for (const session of closedRows) {
    const studentGroup = groupOf.get(session.subject_id);
    if (!session.started_by || !studentGroup || !groupIdsBySession.get(session.id)?.has(studentGroup)) continue;
    const key = `${session.subject_id}:${session.started_by}`;
    const stats = staffStats.get(key) ?? { held: 0, attended: 0 };
    stats.held += 1;
    staffStats.set(key, stats);
    eligibleBySession.set(session.id, key);
  }

  const eligibleIds = [...eligibleBySession.keys()];
  const { data: staffRecords, error: staffRecordsError } = eligibleIds.length
    ? await db.from("attendance_records").select("session_id, status").eq("student_id", actor.id).in("session_id", eligibleIds)
    : { data: [] as Array<{ session_id: string; status: string }>, error: null };
  if (staffRecordsError) throw new Error(`Could not load attendance records for staff percentages: ${staffRecordsError.message}`);
  for (const record of staffRecords ?? []) {
    if (record.status !== "present" && record.status !== "late") continue;
    const key = eligibleBySession.get(record.session_id);
    if (!key) continue;
    const stats = staffStats.get(key);
    if (stats) stats.attended += 1;
  }

  const assignmentsBySubject = new Map<string, Array<{ userId: string; role: "professor" | "teaching_assistant" }>>();
  const staffIds = new Set<string>();
  for (const assignment of (assignments ?? []) as Array<{ subject_id: string; user_id: string; assignment_role: string }>) {
    if (assignment.assignment_role !== "professor" && assignment.assignment_role !== "teaching_assistant") continue;
    const list = assignmentsBySubject.get(assignment.subject_id) ?? [];
    list.push({ userId: assignment.user_id, role: assignment.assignment_role });
    assignmentsBySubject.set(assignment.subject_id, list);
    staffIds.add(assignment.user_id);
  }
  const { data: staffProfiles, error: staffProfilesError } = staffIds.size
    ? await db.from("profiles").select("id, full_name").in("id", [...staffIds])
    : { data: [] as Array<{ id: string; full_name: string }>, error: null };
  if (staffProfilesError) throw new Error(`Could not load teaching staff names: ${staffProfilesError.message}`);
  const names = new Map((staffProfiles ?? []).map((profile) => [profile.id, profile.full_name]));

  const subjects = baseSubjects.map((subject) => {
    const staffAttendance: StaffAttendance[] = (assignmentsBySubject.get(subject.subjectId) ?? [])
      .map((assignment) => {
        const stats = staffStats.get(`${subject.subjectId}:${assignment.userId}`) ?? { held: 0, attended: 0 };
        const percent = stats.held === 0 ? null : Math.round((1000 * stats.attended) / stats.held) / 10;
        return {
          staffId: assignment.userId,
          fullName: names.get(assignment.userId) ?? "Teaching staff",
          role: assignment.role,
          held: stats.held,
          attended: stats.attended,
          percent,
          belowLimit: percent !== null && percent < subject.requiredPercent,
        };
      })
      .sort((a, b) => (a.role === b.role ? a.fullName.localeCompare(b.fullName) : a.role === "professor" ? -1 : 1));
    return { ...subject, staffAttendance };
  });

  return { subjects, timetable, openSessions, hasPasskey: (passkeys ?? 0) > 0, hasDevice: (devices ?? 0) > 0 };
}
