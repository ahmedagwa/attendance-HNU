import { randomUUID } from "node:crypto";
import { requireActor } from "@/lib/auth";
import { ApiError, json, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { adminClient } from "@/lib/supabase/admin";
import { backfillClosedSessionsForStaff, STAFF_ROSTER_BUCKET, STAFF_ROSTER_CONTENT_TYPE } from "@/lib/services/staff-roster-workbooks";
import { inspectXlsxWorkbook, XlsxInputError } from "@/lib/xlsx-zip";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const POST = route(async (request) => {
  const actor = await requireActor("lecturer");
  const form = await request.formData();
  const subjectId = String(form.get("subjectId") ?? "").trim();
  const file = form.get("file");
  const forcedIdHeader = String(form.get("idColumnHeader") ?? "").trim() || undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subjectId)) {
    throw new ApiError(400, "invalid_subject", "Choose a valid subject.");
  }
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    throw new ApiError(400, "file_required", "Choose the university Excel workbook first.");
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw new ApiError(415, "xlsx_required", "Upload an Excel .xlsx file. Older .xls files must first be saved as .xlsx.");
  }
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, "file_too_large", "The Excel file must be between 1 byte and 10 MB.");
  }

  const db = adminClient();
  const { data: assignment, error: assignmentError } = await db.from("subject_staff")
    .select("subject_id")
    .eq("subject_id", subjectId)
    .eq("user_id", actor.id)
    .maybeSingle();
  if (assignmentError) throw new Error(`Could not verify teaching assignment: ${assignmentError.message}`);
  if (!assignment) throw new ApiError(403, "subject_not_assigned", "You can upload a roster only for a subject assigned to you.");

  const { data: existing, error: existingError } = await db.from("staff_roster_workbooks")
    .select("*")
    .eq("staff_user_id", actor.id)
    .eq("subject_id", subjectId)
    .maybeSingle();
  if (existingError) throw new Error(`Could not check the existing roster workbook: ${existingError.message}`);

  const buffer = Buffer.from(await file.arrayBuffer());
  let inspection;
  try { inspection = inspectXlsxWorkbook(buffer, forcedIdHeader); }
  catch (error) {
    if (error instanceof XlsxInputError) throw new ApiError(422, "invalid_roster_workbook", error.message);
    throw error;
  }
  const path = `${actor.id}/${subjectId}/${randomUUID()}.xlsx`;
  const safeName = file.name.replace(/[\r\n\\/]/g, "_").slice(0, 180) || "university-roster.xlsx";
  const lockToken = existing ? randomUUID() : null;
  let uploadedNewFile = false;
  let savedId = "";

  // Serialize replacement with session-close updates. Without this lock, a
  // session could write to the old workbook while this route swaps its file.
  if (existing && lockToken) {
    const { data: acquired, error: lockError } = await db.rpc("acquire_staff_roster_workbook_lock", {
      p_workbook_id: existing.id,
      p_lock_token: lockToken,
    });
    if (lockError) throw new Error(`Could not lock your existing Excel workbook: ${lockError.message}`);
    if (!acquired) throw new ApiError(409, "workbook_busy", "Your Excel workbook is currently being updated. Try replacing it again after that update finishes.");
  }

  try {
    const { error: storageError } = await db.storage.from(STAFF_ROSTER_BUCKET).upload(
      path,
      new Uint8Array(buffer),
      { contentType: STAFF_ROSTER_CONTENT_TYPE, upsert: false, cacheControl: "0" },
    );
    if (storageError) throw new Error(`Could not store the Excel workbook: ${storageError.message}`);
    uploadedNewFile = true;

    const workbookFields = {
      storage_path: path,
      original_filename: safeName,
      worksheet_name: inspection.sheetName,
      worksheet_path: inspection.worksheetPath,
      header_row: inspection.headerRow,
      id_column: inspection.idColumn,
      id_header: inspection.idHeader,
      next_column_number: inspection.maxColumn + 1,
      updated_at: new Date().toISOString(),
    };

    if (existing && lockToken) {
      const { data: updated, error: updateError } = await db.from("staff_roster_workbooks")
        .update(workbookFields)
        .eq("id", existing.id)
        .eq("sync_lock_token", lockToken)
        .select("id")
        .maybeSingle();
      if (updateError || !updated) throw new Error(`Could not replace your roster settings: ${updateError?.message ?? "The workbook update lock was lost."}`);
      savedId = updated.id;
    } else {
      const { data: inserted, error: insertError } = await db.from("staff_roster_workbooks")
        .insert({ staff_user_id: actor.id, subject_id: subjectId, ...workbookFields })
        .select("id")
        .single();
      if (insertError || !inserted) {
        if (insertError?.code === "23505") throw new ApiError(409, "workbook_already_uploaded", "A workbook was uploaded for this subject at the same time. Refresh the page and try again.");
        throw new Error(`Could not save the roster workbook settings: ${insertError?.message ?? "No workbook record was returned"}`);
      }
      savedId = inserted.id;
    }

    // A replacement workbook is a new base. Reset mapping history before
    // backfilling this staff member's own closed sessions into the new file.
    const { error: historyError } = await db.from("staff_roster_workbook_sessions").delete().eq("workbook_id", savedId);
    if (historyError) {
      if (existing) {
        const { error: rollbackError } = await db.from("staff_roster_workbooks").update({
          storage_path: existing.storage_path,
          original_filename: existing.original_filename,
          worksheet_name: existing.worksheet_name,
          worksheet_path: existing.worksheet_path,
          header_row: existing.header_row,
          id_column: existing.id_column,
          id_header: existing.id_header,
          next_column_number: existing.next_column_number,
          updated_at: existing.updated_at,
        }).eq("id", existing.id).eq("sync_lock_token", lockToken);
        if (rollbackError) throw new Error(`Could not reset previous session mapping (${historyError.message}) or restore the previous workbook (${rollbackError.message}).`);
      } else {
        await db.from("staff_roster_workbooks").delete().eq("id", savedId);
      }
      throw new Error(`Workbook was not replaced because its previous session mapping could not be reset: ${historyError.message}`);
    }

    if (existing?.storage_path && existing.storage_path !== path) {
      await db.storage.from(STAFF_ROSTER_BUCKET).remove([existing.storage_path]);
    }
  } catch (error) {
    if (uploadedNewFile) await db.storage.from(STAFF_ROSTER_BUCKET).remove([path]);
    throw error;
  } finally {
    if (existing && lockToken) {
      await db.rpc("release_staff_roster_workbook_lock", { p_workbook_id: existing.id, p_lock_token: lockToken });
    }
  }

  const backfill = await backfillClosedSessionsForStaff(actor.id, subjectId);
  await audit(actor.id, "roster_workbook.uploaded", "subject", subjectId, {
    workbook_id: savedId,
    filename: safeName,
    worksheet: inspection.sheetName,
    id_header: inspection.idHeader,
    students: inspection.studentIds.length,
    historical_sessions_updated: backfill.updated,
    historical_sessions_failed: backfill.failed,
  });

  return json({
    ok: true,
    filename: safeName,
    subjectId,
    worksheet: inspection.sheetName,
    idHeader: inspection.idHeader,
    students: inspection.studentIds.length,
    sessionsFound: backfill.sessionsFound,
    sessionsUpdated: backfill.updated,
    sessionsFailed: backfill.failed,
  }, 201);
});
