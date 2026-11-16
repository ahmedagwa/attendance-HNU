import { requireActor } from "@/lib/auth";
import { ApiError, route, type IdCtx } from "@/lib/http";
import { audit } from "@/lib/audit";
import { requireSessionManager } from "@/lib/services/session-access";
import { loadRoster } from "@/lib/services/roster";
import { csvCell } from "@/lib/csv";

export const GET = route<IdCtx>(async (_req, { params }) => {
  const actor = await requireActor("lecturer", "admin");
  const session = await requireSessionManager(actor, (await params).id);
  const roster = await loadRoster(session);
  if (!roster.length) throw new ApiError(404, "empty", "Nothing to export");
  const head = ["university_id", "full_name", "group", "status", "source", "checked_in_at_utc", "manual_reason"];
  const lines = [head.join(","), ...roster.map((r) => [r.universityId, r.fullName, r.groupCode, r.status, r.source, r.checkedInAt, r.manualReason].map(csvCell).join(","))];
  await audit(actor.id, "attendance.exported", "session", session.id, { rows: roster.length });
  return new Response("\uFEFF" + lines.join("\r\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="attendance-${session.subject.code}-${session.started_at.slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
  });
});
