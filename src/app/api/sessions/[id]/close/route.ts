import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { json, route, type IdCtx } from "@/lib/http";
import { audit } from "@/lib/audit";
import { broadcastToSession } from "@/lib/realtime";
import { requireSessionManager } from "@/lib/services/session-access";
import { applySessionToStaffWorkbook, type SyncResult } from "@/lib/services/staff-roster-workbooks";

export const POST = route<IdCtx>(async (_request, { params }) => {
  const actor = await requireActor("lecturer", "admin");
  const session = await requireSessionManager(actor, (await params).id);
  if (session.status !== "closed") {
    const { error } = await adminClient().from("sessions")
      .update({ status: "closed", ended_at: new Date().toISOString() })
      .eq("id", session.id)
      .neq("status", "closed");
    if (error) throw new Error(`Could not close the session: ${error.message}`);
    await audit(actor.id, "session.closed", "session", session.id);
    await broadcastToSession(session.id, "session", { status: "closed" });
  }

  // The service derives the workbook owner exclusively from sessions.started_by.
  // An admin or another assigned tutor closing this session never writes to
  // their own workbook; only the staff member who opened it is considered.
  let rosterWorkbook: SyncResult;
  try {
    rosterWorkbook = await applySessionToStaffWorkbook(session.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Excel workbook could not be updated.";
    // Closing attendance must not be rolled back or reported as failed just
    // because the optional Excel export failed. The starter can retry later.
    await audit(actor.id, "roster_workbook.session_column_failed", "session", session.id, {
      reason: message.slice(0, 300),
    });
    rosterWorkbook = { status: "failed" as const, message };
  }
  return json({ ok: true, status: "closed", rosterWorkbook });
});
