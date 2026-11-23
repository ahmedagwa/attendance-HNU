import { requireActor } from "@/lib/auth";
import { ApiError, json, route, type IdCtx } from "@/lib/http";
import { requireSessionManager } from "@/lib/services/session-access";
import { applySessionToStaffWorkbook } from "@/lib/services/staff-roster-workbooks";

export const POST = route<IdCtx>(async (_request, { params }) => {
  const actor = await requireActor("lecturer");
  const session = await requireSessionManager(actor, (await params).id);
  if (session.started_by !== actor.id) throw new ApiError(403, "not_session_starter", "Only the staff member who opened this session can update their Excel workbook.");
  if (session.status !== "closed") throw new ApiError(409, "session_not_closed", "Close the session before updating its Excel attendance column.");
  const result = await applySessionToStaffWorkbook(session.id);
  if (result.status === "failed") throw new ApiError(503, "workbook_sync_failed", result.message ?? "The Excel workbook could not be updated. Try again.");
  if (result.status === "busy") throw new ApiError(409, "workbook_busy", result.message ?? "Your Excel workbook is being updated. Try again shortly.");
  return json({ ok: true, rosterWorkbook: result });
});
