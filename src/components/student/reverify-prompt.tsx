"use client";
import { useEffect, useState } from "react";
import { api, ApiFailure } from "@/lib/client/api";

type Challenge = { id: string; sessionId: string; expiresAt: string };

/** Polls for a lecturer spot check; the student types the 2-digit code shown on the projector. */
export function ReverifyPrompt() {
  const [ch, setCh] = useState<Challenge | null>(null);
  const [left, setLeft] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try { const r = await api<{ challenge: Challenge | null }>("/api/student/reverification"); if (live) setCh((cur) => (r.challenge && !result ? r.challenge : cur && new Date(cur.expiresAt) > new Date() ? cur : null)); } catch { /* transient */ }
    };
    tick(); const t = setInterval(tick, 3000);
    return () => { live = false; clearInterval(t); };
  }, [result]);

  useEffect(() => {
    if (!ch) return;
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((new Date(ch.expiresAt).getTime() - Date.now()) / 1000))), 250);
    return () => clearInterval(t);
  }, [ch]);

  if (!ch || left <= 0) return result ? <p role="status" className="panel p-4 font-semibold">{result}</p> : null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true);
    const code = String(new FormData(e.currentTarget).get("code"));
    try {
      const r = await api<{ correct: boolean }>(`/api/sessions/${ch!.sessionId}/reverification/respond`, { body: { challengeId: ch!.id, code } });
      setResult(r.correct ? "Spot check complete. Thank you." : "That code didn't match. Your lecturer will follow up."); setCh(null);
    } catch (err) { setResult(err instanceof ApiFailure ? err.message : "Could not send your answer."); setCh(null); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="panel border-amber p-4" aria-live="polite">
      <h2 className="font-bold">Spot check — enter the code on the screen</h2>
      <p className="text-sm text-ink-soft">{left}s left</p>
      <div className="mt-3 flex gap-2">
        <input name="code" inputMode="numeric" pattern="\d{2}" maxLength={2} required autoFocus autoComplete="off" aria-label="Two-digit code" className="input w-24 text-center font-display text-2xl tracking-widest" />
        <button className="btn btn-primary flex-1" disabled={busy}>Send code</button>
      </div>
    </form>
  );
}
