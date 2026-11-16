import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { json, route, type IdCtx } from "@/lib/http";
import { audit } from "@/lib/audit";
import { broadcastToSession } from "@/lib/realtime";
import { requireSessionManager } from "@/lib/services/session-access";

export const POST = route<IdCtx>(async (_req, { params }) => {
  const actor = await requireActor("lecturer", "admin");
  const session = await requireSessionManager(actor, (await params).id);
  if (session.status !== "closed") {
    await adminClient().from("sessions").update({ status: "closed", ended_at: new Date().toISOString() }).eq("id", session.id).neq("status", "closed");
    await audit(actor.id, "session.closed", "session", session.id);
    await broadcastToSession(session.id, "session", { status: "closed" });
  }
  return json({ ok: true, status: "closed" });
});
