import "server-only";
import { adminClient } from "./supabase/admin";

const FORBIDDEN_KEYS = /secret|assertion|token|password|payload|signature|authorization|public_?key/i;

/** Append-only audit trail. Never pass WebAuthn assertions, secrets, tokens or full QR payloads. */
export async function audit(actorId: string | null, action: string, entityType: string, entityId: string | null, metadata: Record<string, unknown> = {}) {
  const clean = Object.fromEntries(Object.entries(metadata).filter(([k]) => !FORBIDDEN_KEYS.test(k)));
  const { error } = await adminClient().from("audit_logs").insert({ actor_id: actorId, action, entity_type: entityType, entity_id: entityId, metadata: clean });
  if (error) console.error("[audit] failed to write", action, error.message);
}
