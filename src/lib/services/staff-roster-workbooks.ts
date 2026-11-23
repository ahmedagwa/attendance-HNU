import "server-only";
import { randomUUID } from "node:crypto";
import { adminClient } from "../supabase/admin";
import { audit } from "../audit";
import { loadRoster } from "./roster";
import {
  findExistingSessionColumn,
  normalizeUniversityId,
  writeAttendanceColumn,
  type XlsxInspection,
} from "../xlsx-zip";

export const STAFF_ROSTER_BUCKET = "staff-rosters";
export const STAFF_ROSTER_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type StaffRosterWorkbook = {
  id: string;
  staff_user_id: string;
  subject_id: string;
  storage_path: string;
  original_filename: string;
  worksheet_name: string;
  worksheet_path: string;
  header_row: number;
  id_column: number;
  id_header: string;
  next_column_number: number;
};

export type SyncResult = {
  status: "updated" | "not_configured" | "busy" | "failed";
  sessionNumber?: number;
  matched?: number;
  unknown?: number;
  missingFromWorkbook?: number;
  message?: string;
};

function inspectionFromWorkbook(workbook: StaffRosterWorkbook): XlsxInspection {
  return {
    sheetName: workbook.worksheet_name,
    worksheetPath: workbook.worksheet_path,
    headerRow: workbook.header_row,
    idColumn: workbook.id_column,
    idHeader: workbook.id_header,
    maxColumn: workbook.next_column_number - 1,
    maxRow: 0,
    studentIds: [],
  };
}

export async function applySessionToStaffWorkbook(sessionId: string): Promise<SyncResult> {
  const db = adminClient();
  const { data: session, error: sessionError } = await db.from("sessions")
    .select("id, subject_id, group_id, started_by, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw new Error(`Could not load session for Excel update: ${sessionError.message}`);
  if (!session || session.status !== "closed") return { status: "failed", message: "The session must be closed before its Excel column can be written." };
  if (!session.started_by) return { status: "not_configured", message: "The original staff account for this session is no longer active." };

  const { data: workbookRow, error: workbookError } = await db.from("staff_roster_workbooks")
    .select("*")
    .eq("staff_user_id", session.started_by)
    .eq("subject_id", session.subject_id)
    .maybeSingle();
  if (workbookError) throw new Error(`Could not load the staff Excel roster: ${workbookError.message}`);
  if (!workbookRow) return { status: "not_configured" };
  const workbook = workbookRow as StaffRosterWorkbook;

  const lockToken = randomUUID();
  const { data: acquired, error: lockError } = await db.rpc("acquire_staff_roster_workbook_lock", {
    p_workbook_id: workbook.id,
    p_lock_token: lockToken,
  });
  if (lockError) throw new Error(`Could not lock the staff Excel roster: ${lockError.message}`);
  if (!acquired) return { status: "busy", message: "This staff workbook is currently being updated by another session." };

  let reservation: { session_number: number; column_number: number; sync_status: string } | null = null;
  try {
    const { data: file, error: downloadError } = await db.storage.from(STAFF_ROSTER_BUCKET).download(workbook.storage_path);
    if (downloadError || !file) throw new Error(`Could not download the staff Excel workbook: ${downloadError?.message ?? "File not found"}`);
    const original = Buffer.from(await file.arrayBuffer());
    const inspection = inspectionFromWorkbook(workbook);
    const { data: subjectSessions, error: subjectSessionsError } = await db.from("sessions")
      .select("id")
      .eq("subject_id", session.subject_id)
      .eq("started_by", session.started_by)
      .order("started_at", { ascending: true })
      .order("id", { ascending: true });
    if (subjectSessionsError) throw new Error(`Could not determine the subject session number: ${subjectSessionsError.message}`);
    const sessionNumber = (subjectSessions ?? []).findIndex((row) => row.id === session.id) + 1;
    if (sessionNumber < 1) throw new Error("Could not determine this session's number in the subject history.");
    const existingColumn = findExistingSessionColumn(original, inspection, sessionNumber);

    const { data: groupRows, error: groupError } = await db.from("session_groups").select("group_id").eq("session_id", session.id);
    if (groupError) throw new Error(`Could not load session groups: ${groupError.message}`);
    let groupIds = [...new Set((groupRows ?? []).map((row) => row.group_id))];
    // Keep legacy single-group sessions readable even if their session_groups
    // row is missing. Older NULL-group sessions fall back to all enrolled groups.
    if (!groupIds.length && session.group_id) groupIds = [session.group_id];
    if (!groupIds.length) {
      const { data: legacyEnrollments, error: legacyEnrollmentError } = await db.from("enrollments")
        .select("group_id").eq("subject_id", session.subject_id);
      if (legacyEnrollmentError) throw new Error(`Could not determine the session groups: ${legacyEnrollmentError.message}`);
      groupIds = [...new Set((legacyEnrollments ?? []).map((row) => row.group_id))];
    }
    if (!groupIds.length) throw new Error("No enrolled student groups could be found for this session; the Excel workbook was not changed.");
    const roster = await loadRoster({ id: session.id, subject_id: session.subject_id, groupIds });
    const attendanceById = new Map<string, string>();
    for (const row of roster) attendanceById.set(normalizeUniversityId(row.universityId), {
      present: "Present", late: "Late", review: "Needs review", rejected: "Rejected", absent: "Absent",
    }[row.status]);

    const { data: enrollmentRows, error: enrollmentError } = await db.from("enrollments")
      .select("student:profiles(university_id)")
      .eq("subject_id", session.subject_id);
    if (enrollmentError) throw new Error(`Could not load subject enrollment IDs: ${enrollmentError.message}`);
    const subjectIds = new Set<string>();
    for (const item of (enrollmentRows ?? []) as unknown as Array<{ student: { university_id: string } | null }>) {
      const id = normalizeUniversityId(item.student?.university_id);
      if (id) subjectIds.add(id);
    }

    const { data: claimRows, error: claimError } = await db.rpc("claim_staff_roster_workbook_column", {
      p_workbook_id: workbook.id,
      p_session_id: session.id,
      p_lock_token: lockToken,
      p_session_number: sessionNumber,
      p_existing_column: existingColumn,
    });
    if (claimError) throw new Error(`Could not reserve the Excel session column: ${claimError.message}`);
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim) throw new Error("The database did not return an Excel session column reservation.");
    reservation = claim as { session_number: number; column_number: number; sync_status: string };

    const updated = writeAttendanceColumn(original, inspection, {
      sessionNumber: reservation.session_number,
      columnNumber: reservation.column_number,
      attendanceById,
      subjectIds,
    });
    const { error: uploadError } = await db.storage.from(STAFF_ROSTER_BUCKET).upload(
      workbook.storage_path,
      new Uint8Array(updated.buffer),
      { contentType: STAFF_ROSTER_CONTENT_TYPE, upsert: true, cacheControl: "0" },
    );
    if (uploadError) throw new Error(`Could not save the updated Excel workbook: ${uploadError.message}`);

    const { error: updateError } = await db.from("staff_roster_workbook_sessions").update({
      sync_status: "applied",
      matched_count: updated.matched,
      unknown_count: updated.unknown,
      missing_count: updated.missingFromWorkbook,
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("workbook_id", workbook.id).eq("session_id", session.id);
    if (updateError) throw new Error(`Workbook updated, but the sync record could not be saved: ${updateError.message}`);
    await audit(session.started_by, "roster_workbook.session_column_updated", "session", session.id, {
      workbook_id: workbook.id,
      session_number: reservation.session_number,
      matched_count: updated.matched,
      unknown_count: updated.unknown,
      missing_count: updated.missingFromWorkbook,
    });
    return {
      status: "updated",
      sessionNumber: reservation.session_number,
      matched: updated.matched,
      unknown: updated.unknown,
      missingFromWorkbook: updated.missingFromWorkbook,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Excel roster update failed.";
    if (reservation) {
      await db.from("staff_roster_workbook_sessions").update({
        sync_status: "failed", last_error: message.slice(0, 500), updated_at: new Date().toISOString(),
      }).eq("workbook_id", workbook.id).eq("session_id", session.id);
    }
    await audit(session.started_by, "roster_workbook.session_column_failed", "session", session.id, {
      workbook_id: workbook.id,
      reason: message.slice(0, 300),
    });
    return { status: "failed", message };
  } finally {
    await db.rpc("release_staff_roster_workbook_lock", { p_workbook_id: workbook.id, p_lock_token: lockToken });
  }
}

export async function backfillClosedSessionsForStaff(staffUserId: string, subjectId: string) {
  const db = adminClient();
  const { data: sessions, error } = await db.from("sessions")
    .select("id")
    .eq("started_by", staffUserId)
    .eq("subject_id", subjectId)
    .eq("status", "closed")
    .order("started_at", { ascending: true });
  if (error) throw new Error(`Could not load previous sessions for workbook backfill: ${error.message}`);
  const results: SyncResult[] = [];
  for (const session of sessions ?? []) results.push(await applySessionToStaffWorkbook(session.id));
  return {
    sessionsFound: sessions?.length ?? 0,
    updated: results.filter((item) => item.status === "updated").length,
    failed: results.filter((item) => item.status === "failed").length,
    busy: results.filter((item) => item.status === "busy").length,
    results,
  };
}
