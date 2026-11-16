import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route, type IdCtx } from "@/lib/http";
import { audit } from "@/lib/audit";
import { broadcastToSession } from "@/lib/realtime";
import { requireSessionManager } from "@/lib/services/session-access";

export const POST = route<IdCtx>(async (req, { params }) => {
  const actor = await requireActor("lecturer", "admin");
  const { paused } = await readBody(req, z.object({ paused: z.boolean() }));
  const session = await requireSessionManager(actor, (await params).id);
  if (session.status === "closed") throw new ApiError(409, "session_closed", "This session is closed.");
  const status = paused ? "paused" : "active";
  await adminClient().from("sessions").update({ status }).eq("id", session.id).neq("status", "closed");
  await audit(actor.id, paused ? "session.paused" : "session.resumed", "session", session.id);
  await broadcastToSession(session.id, "session", { status });
  return json({ ok: true, status });
});
