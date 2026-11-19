import "server-only";
import { adminClient } from "../supabase/admin";
import { ApiError } from "../http";
import { isUuid } from "../ids";
import { decryptSecret, parseMasterKey } from "../qr";
import { serverEnv } from "../env";
import type { Actor } from "../auth";

export type SessionGroup = { id: string; groupCode: string; name: string };
export type SessionRow = {
  id: string; subject_id: string; group_id: string | null; groupIds: string[]; groups: SessionGroup[];
  hall_id: string; started_by: string;
  status: "active" | "paused" | "closed"; started_at: string; ended_at: string | null;
  late_threshold_minutes: number; qr_period_seconds: number; qr_secret_enc: string;
  subject: { id: string; code: string; name: string; lecturer_id: string | null };
};

/** A session can be managed by its starter, any assigned subject staff member, or an admin. */
export async function requireSessionManager(actor: Actor, sessionId: string): Promise<SessionRow> {
  if (!isUuid(sessionId)) throw new ApiError(404, "not_found");
  const db = adminClient();
  const { data: s } = await db
    .from("sessions")
    .select("*, subject:subjects(id, code, name, lecturer_id)")
    .eq("id", sessionId)
    .maybeSingle();
  if (!s) throw new ApiError(404, "not_found");

  let allowed = actor.role === "admin" || (actor.role === "lecturer" && s.started_by === actor.id);
  if (!allowed && actor.role === "lecturer") {
    const { data: assignment } = await db.from("subject_staff")
      .select("subject_id")
      .eq("subject_id", s.subject_id)
      .eq("user_id", actor.id)
      .maybeSingle();
    allowed = Boolean(assignment);
  }
  if (!allowed) throw new ApiError(404, "not_found");

  const { data: groupRows } = await db.from("session_groups")
    .select("group_id, group:student_groups(group_code, name)")
    .eq("session_id", s.id);
  const groups = (groupRows ?? []).map((row) => {
    const group = row.group as unknown as { group_code: string; name: string };
    return { id: row.group_id, groupCode: group.group_code, name: group.name };
  });

  return { ...(s as Omit<SessionRow, "groupIds" | "groups">), groupIds: groups.map((g) => g.id), groups } as SessionRow;
}

export const sessionSecret = (s: Pick<SessionRow, "qr_secret_enc">) =>
  decryptSecret(s.qr_secret_enc, parseMasterKey(serverEnv().QR_MASTER_KEY));
