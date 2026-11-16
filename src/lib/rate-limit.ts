import "server-only";
import { adminClient } from "./supabase/admin";
import { ApiError } from "./http";

/** Postgres-backed fixed-window limiter (shared across serverless instances; no Redis needed for the pilot). */
export async function rateLimit(key: string, windowSeconds: number, max: number) {
  const { data, error } = await adminClient().rpc("rate_limit_hit", {
    p_key: key,
    p_window_seconds: windowSeconds,
    p_max: max,
  });

  if (error) {
    // Keep diagnostics in the server terminal only; never return database internals to the client.
    console.error("[rate-limit] RPC failed:", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    throw new ApiError(503, "rate_limit_unavailable", "Please try again shortly");
  }

  if (data !== true) {
    throw new ApiError(429, "rate_limited", "Too many requests. Wait a moment and try again.");
  }
}
