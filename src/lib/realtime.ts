import "server-only";
import { adminClient } from "./supabase/admin";

/**
 * Publishes a minimal event to the lecturer's PRIVATE Broadcast topic after the transaction commits.
 * Events are notifications, not the source of truth: dashboards reconcile with the database.
 * Never include passkey data, exact GPS or QR secrets.
 */
export async function broadcastToSession(sessionId: string, event: string, payload: Record<string, unknown>) {
  try {
    const client = adminClient();
    const channel = client.channel(`session:${sessionId}`, { config: { private: true } });
    await channel.httpSend(event, payload);
    await client.removeChannel(channel);
  } catch (e) {
    console.warn("[realtime] broadcast failed (non-fatal)", e instanceof Error ? e.message : e);
  }
}
