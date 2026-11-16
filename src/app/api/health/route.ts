import { adminClient } from "@/lib/supabase/admin";
import { json, route } from "@/lib/http";

/** Unauthenticated liveness/readiness probe for uptime monitors and post-deploy checks. Reveals nothing sensitive. */
export const GET = route(async () => {
  const { error } = await adminClient().from("profiles").select("id", { head: true, count: "exact" }).limit(1);
  return json({ ok: !error, db: !error, time: new Date().toISOString() }, error ? 503 : 200);
});
