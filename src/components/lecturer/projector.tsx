"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { api } from "@/lib/client/api";
import { useSessionLive } from "./use-session-live";

type QrState = { payload: string; bucket: number; period: number; receivedAt: number; elapsedMs: number };

/**
 * Full-screen projector view. High contrast, legible from the back of a hall.
 * The ring sweeps once per rotation; the VERIFIER never trusts it (server time decides validity).
 */
export function Projector({ sessionId, subject }: { sessionId: string; subject: string }) {
  const { data, arrivals, realtime } = useSessionLive(sessionId);
  const [qr, setQr] = useState<QrState | null>(null);
  const [paused, setPaused] = useState(false);
  const [closedByApi, setClosed] = useState(false);
  const [connected, setConnected] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const again = useRef<() => void>(() => undefined);

  const fetchQr = useCallback(async () => {
    const t0 = Date.now();
    try {
      const r = await api<{ status: string; payload?: string; bucket?: number; periodSeconds?: number; msToNext?: number }>(`/api/sessions/${sessionId}/qr`);
      const rtt = Date.now() - t0;
      setConnected(true);
      if (r.status === "paused") { setPaused(true); setQr(null); timer.current = setTimeout(() => again.current(), 2000); return; }
      setPaused(false);
      const period = r.periodSeconds!, toNext = Math.max(r.msToNext! - rtt / 2, 0);
      setQr({ payload: r.payload!, bucket: r.bucket!, period, receivedAt: Date.now(), elapsedMs: period * 1000 - toNext });
      timer.current = setTimeout(() => again.current(), toNext + 60); // refetch just after the next rollover
    } catch (e) {
      if (e instanceof Error && /closed/i.test(e.message)) { setClosed(true); return; }
      setConnected(false); timer.current = setTimeout(() => again.current(), 1500);
    }
  }, [sessionId]);

  useEffect(() => {
    again.current = () => void fetchQr();
    const first = setTimeout(() => again.current(), 0);
    return () => { clearTimeout(first); if (timer.current) clearTimeout(timer.current); };
  }, [fetchQr]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);

  const closed = closedByApi || data?.session.status === "closed";

  // Never present a stale token as current: hide it if we haven't refreshed within period + grace.
  const stale = !qr || now - qr.receivedAt > qr.period * 1000 + 2500;
  const s = data?.summary;
  const feed = arrivals.length ? arrivals : (data?.recent ?? []).map((r) => ({ key: r.studentId, name: r.fullName, idSuffix: r.universityId.slice(-4), status: r.status, at: r.checkedInAt ?? "" }));

  return (
    <div className="min-h-dvh bg-projector p-6 text-white md:p-10">
      <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex flex-col items-center justify-center">
          <p className="mb-1 text-lg text-white/70">{subject}</p>
          <h1 className="mb-6 text-center text-3xl font-bold md:text-5xl">{closed ? "Session closed" : paused ? "Attendance paused" : "Scan to check in"}</h1>

          {closed || paused ? (
            <div className="grid aspect-square w-full max-w-[34rem] place-items-center rounded-3xl border-2 border-white/20 text-center text-2xl text-white/80">
              {closed ? "Attendance is closed for this session." : "Your lecturer paused check-in. A new code appears when it resumes."}
            </div>
          ) : (
            <div className="relative w-full max-w-[34rem]">
              <svg viewBox="0 0 100 100" className="absolute inset-0 -m-3 h-[calc(100%+1.5rem)] w-[calc(100%+1.5rem)]" aria-hidden>
                <rect x="1.5" y="1.5" width="97" height="97" rx="8" fill="none" stroke="rgba(255,255,255,.14)" strokeWidth="1.4" />
                {!stale && qr && (
                  <rect key={qr.bucket} x="1.5" y="1.5" width="97" height="97" rx="8" fill="none" stroke="var(--color-amber)" strokeWidth="1.8" strokeLinecap="round"
                    pathLength={100} strokeDasharray="100" className="ring-sweep"
                    style={{ ["--period" as string]: `${qr.period}s`, animationDelay: `-${qr.elapsedMs / 1000}s` }} />
                )}
              </svg>
              <div className="rounded-2xl bg-white p-5">
                {stale || !qr ? (
                  <div className="grid aspect-square place-items-center text-center text-xl font-semibold text-ink" role="alert">
                    {connected ? "Loading code…" : "Connection lost. Reconnecting… Do not scan an old code."}
                  </div>
                ) : <QRCodeSVG value={qr.payload} size={512} level="M" marginSize={0} className="h-auto w-full" title="Attendance code" />}
              </div>
            </div>
          )}
          <p className="mt-6 text-center text-white/70">The code refreshes about every 10 seconds — scan it live from your seat.</p>
        </div>

        <aside className="space-y-6">
          <div>
            <p className="font-display text-7xl font-bold tabular-nums md:text-8xl">{s ? s.present + s.late + s.review : "–"}<span className="text-4xl text-white/50"> / {s?.enrolled ?? "–"}</span></p>
            <p className="mt-1 text-xl text-white/70">checked in{s && s.late > 0 ? ` · ${s.late} late` : ""}{s && s.review > 0 ? ` · ${s.review} in review` : ""}</p>
          </div>
          <section aria-label="Latest arrivals" aria-live="polite">
            <h2 className="mb-2 text-lg font-semibold text-white/80">Latest arrivals</h2>
            <ul className="max-h-[48vh] space-y-1.5 overflow-hidden">
              {feed.slice(0, 10).map((a) => (
                <li key={a.key} className="flex items-center justify-between rounded-xl bg-white/10 px-4 py-2.5 text-lg">
                  <span className="truncate font-semibold">{a.name}</span>
                  <span className="ml-3 shrink-0 text-white/60">…{a.idSuffix}{a.status === "late" ? " · late" : a.status === "review" ? " · review" : ""}</span>
                </li>
              ))}
              {!feed.length && <li className="text-white/50">Waiting for the first check-in…</li>}
            </ul>
          </section>
          {data?.spotCheck?.active && (
            <div className="rounded-2xl border-2 border-amber p-5 text-center"><p className="text-lg text-white/80">Spot check — enter this code in the app</p><p className="font-display text-8xl font-bold text-amber">{data.spotCheck.code}</p></div>
          )}
          <div className="flex items-center justify-between text-sm text-white/60">
            <span>{realtime === "live" ? "● Live" : realtime === "connecting" ? "Connecting…" : "Live updates paused — counts refresh every 10 s"}</span>
            <Link href={`/lecturer/sessions/${sessionId}`} className="underline">Control room</Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
