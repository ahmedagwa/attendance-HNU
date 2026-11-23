import { requireActor } from "@/lib/auth";
import { ApiError, route } from "@/lib/http";
import { adminClient } from "@/lib/supabase/admin";
import { STAFF_ROSTER_BUCKET, STAFF_ROSTER_CONTENT_TYPE } from "@/lib/services/staff-roster-workbooks";

type Ctx = { params: Promise<{ subjectId: string }> };

export const GET = route<Ctx>(async (_request, { params }) => {
  const actor = await requireActor("lecturer");
  const { subjectId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subjectId)) throw new ApiError(404, "not_found");
  const db = adminClient();
  const { data: assignment, error: assignmentError } = await db.from("subject_staff").select("subject_id").eq("subject_id", subjectId).eq("user_id", actor.id).maybeSingle();
  if (assignmentError) throw new Error(`Could not verify your teaching assignment: ${assignmentError.message}`);
  if (!assignment) throw new ApiError(403, "subject_not_assigned", "You can download a roster only for a subject assigned to you.");
  const { data: workbook, error } = await db.from("staff_roster_workbooks")
    .select("storage_path, original_filename")
    .eq("staff_user_id", actor.id)
    .eq("subject_id", subjectId)
    .maybeSingle();
  if (error) throw new Error(`Could not load your Excel roster: ${error.message}`);
  if (!workbook) throw new ApiError(404, "workbook_not_found", "You have not uploaded an Excel roster for this subject yet.");
  const { data: file, error: downloadError } = await db.storage.from(STAFF_ROSTER_BUCKET).download(workbook.storage_path);
  if (downloadError || !file) throw new Error(`Could not download your Excel roster: ${downloadError?.message ?? "File not found"}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const filename = `attendance-${workbook.original_filename.replace(/[\r\n"\\]/g, "_")}`;
  return new Response(bytes, {
    headers: {
      "Content-Type": STAFF_ROSTER_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
});
