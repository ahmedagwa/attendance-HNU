import "server-only";
import { adminClient } from "../supabase/admin";
import { ApiError } from "../http";
import { isUuid } from "../ids";
import { decryptSecret, parseMasterKey } from "../qr";
import { serverEnv } from "../env";
import type { Actor } from "../auth";

export type SessionRow = {
  id: string; subject_id: string; group_id: string | null; hall_id: string; started_by: string;
  status: "active" | "paused" | "closed"; started_at: string; ended_at: string | null;
  late_threshold_minutes: number; qr_period_seconds: number; qr_secret_enc: string;
  subject: { id: string; code: string; name: string; lecturer_id: string | null };
};

/** Lecturer who owns the session (or an admin). Unknown and foreign sessions both answer 404. */
export async function requireSessionManager(actor: Actor, sessionId: string): Promise<SessionRow> {
  if (!isUuid(sessionId)) throw new ApiError(404, "not_found");
  const { data: s } = await adminClient()
    .from("sessions").select("*, subject:subjects(id, code, name, lecturer_id)").eq("id", sessionId).maybeSingle();
  if (!s) throw new ApiError(404, "not_found");
  const allowed = actor.role === "admin" || (actor.role === "lecturer" && (s.started_by === actor.id || s.subject?.lecturer_id === actor.id));
  if (!allowed) throw new ApiError(404, "not_found");
  return s as SessionRow;
}

export const sessionSecret = (s: Pick<SessionRow, "qr_secret_enc">) =>
  decryptSecret(s.qr_secret_enc, parseMasterKey(serverEnv().QR_MASTER_KEY));
