import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { json, route } from "@/lib/http";

/** The student's currently open spot check, if any. The answer code is never returned. */
export const GET = route(async () => {
  const actor = await requireActor("student");
  const db = adminClient();
  const { data: mine } = await db.from("attendance_records").select("session_id, session:sessions!inner(status)").eq("student_id", actor.id).in("status", ["present", "late", "review"]).eq("session.status", "active");
  const sessionIds = (mine ?? []).map((r) => r.session_id);
  if (!sessionIds.length) return json({ challenge: null });

  const { data: ch } = await db.from("reverification_challenges").select("id, session_id, expires_at").in("session_id", sessionIds).gt("expires_at", new Date().toISOString()).order("issued_at", { ascending: false }).limit(1).maybeSingle();
  if (!ch) return json({ challenge: null });
  const { count } = await db.from("reverification_responses").select("student_id", { head: true, count: "exact" }).eq("challenge_id", ch.id).eq("student_id", actor.id);
  return json({ challenge: count ? null : { id: ch.id, sessionId: ch.session_id, expiresAt: ch.expires_at } });
});
