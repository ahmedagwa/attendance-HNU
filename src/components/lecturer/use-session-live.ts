"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { browserClient } from "@/lib/supabase/browser";
import type { LiveData } from "@/lib/client/types";

export type Arrival = { key: string; name: string; idSuffix: string; status: string; at: string };

/**
 * Authoritative state comes from the server (initial load, periodic and after-reconnect reconciliation).
 * Realtime Broadcast events only make the feed feel instant; they are notifications, not the source of truth.
 */
export function useSessionLive(sessionId: string) {
  const [data, setData] = useState<LiveData | null>(null);
  const [realtime, setRealtime] = useState<"connecting" | "live" | "down">("connecting");
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastFetch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    lastFetch.current = Date.now();
    try { setData(await api<LiveData>(`/api/sessions/${sessionId}/attendance`)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not refresh"); }
  }, [sessionId]);

  // Coalesce bursts (100 check-ins in seconds) into at most one reconciliation per second.
  const scheduleRefresh = useCallback(() => {
    if (timer.current) return;
    const wait = Math.max(0, 1000 - (Date.now() - lastFetch.current));
    timer.current = setTimeout(() => { timer.current = null; void refresh(); }, wait);
  }, [refresh]);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const poll = setInterval(refresh, 10_000);
    const supabase = browserClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    (async () => {
      await supabase.realtime.setAuth();
      if (cancelled) return;
      channel = supabase.channel(`session:${sessionId}`, { config: { private: true } })
        .on("broadcast", { event: "attendance" }, ({ payload }: { payload: Record<string, string | undefined> }) => {
          if (payload?.name) setArrivals((a) => [{ key: String(payload.recordId ?? Math.random()), name: payload.name!, idSuffix: payload.idSuffix ?? "", status: payload.status ?? "present", at: payload.at ?? new Date().toISOString() }, ...a].slice(0, 30));
          scheduleRefresh();
        })
        .on("broadcast", { event: "session" }, () => scheduleRefresh())
        .subscribe((status: string) => {
          if (status === "SUBSCRIBED") { setRealtime("live"); void refresh(); } // reconcile after (re)connect
          else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setRealtime("down");
        });
    })();
    return () => { cancelled = true; clearTimeout(first); clearInterval(poll); if (timer.current) clearTimeout(timer.current); if (channel) void supabase.removeChannel(channel); };
  }, [sessionId, refresh, scheduleRefresh]);

  return { data, arrivals, realtime, error, refresh };
}
