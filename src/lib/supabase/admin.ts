import "server-only";
import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "../env";

/** Service-role client. Bypasses RLS: use ONLY after verifying the caller's identity and role. */
export function adminClient() {
  const env = serverEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
