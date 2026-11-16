"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, ApiFailure } from "@/lib/client/api";
import { getInstallationId } from "@/lib/client/installation";

type Phase = "idle" | "scanning" | "verifying" | "retry" | "done" | "error";
type Fix = { latitude: number; longitude: number; accuracy: number };
type Attempt = { attemptId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"]; session: { subjectName: string; hallName: string } };
type RetryInfo = { reason: "poor_accuracy" | "uncertain"; retriesLeft: number; canSubmitForReview: boolean; accuracyMeters: number; maxAccuracyMeters: number };
type Pass = { status: string; review: boolean; checkedInAt: string; student: { name: string; universityId: string }; subject: { code: string; name: string } };

const getFix = () => new Promise<Fix>((resolve, reject) =>
  navigator.geolocation.getCurrentPosition(
    (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }), reject,
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }));

const ERRORS: Record<string, string> = {
  qr_expired: "That code has already changed. Point your camera at the code on the screen again.",
  invalid_qr: "That isn't an attendance code. Scan the code shown by your lecturer.",
  not_eligible: "You can't check in to this session.",
  session_not_active: "Attendance isn't open for this session.",
  already_checked_in: "You're already checked in.",
  passkey_required: "Set up your passkey first.",
  attempt_invalid: "This check-in timed out. Scan the code again.",
  verification_failed: "We couldn't verify your passkey. Scan the code and try again.",
  outside_geofence: "You don't appear to be in the lecture hall. Ask your lecturer to check you in manually.",
  device_conflict: "This browser or installed app is already assigned to another student account. Contact your administrator.",
  device_revoked: "This browser or device registration has been revoked. Contact your administrator.",
  device_approval_required: "This student account is linked to another browser or device. Ask your administrator to verify you and reset the previous device.",
  device_identity_changed: "This browser's saved installation identity changed. Contact your administrator before clearing storage or switching accounts.",
};

export function ScannerFlow() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<RetryInfo | null>(null);
  const [pass, setPass] = useState<Pass | null>(null);
  const scanner = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const pending = useRef<{ attempt: Attempt; assertion: unknown } | null>(null);
  const busy = useRef(false);

  const stopCamera = useCallback(async () => {
    const s = scanner.current; scanner.current = null;
    if (s) { try { if (s.isScanning) await s.stop(); s.clear(); } catch { /* already stopped */ } }
  }, []);
  useEffect(() => () => { void stopCamera(); }, [stopCamera]);

  const fail = useCallback((text: string) => { setMessage(text); setPhase("error"); }, []);

  const submit = useCallback(async (fix: Fix, submitForReview = false) => {
    const p = pending.current!;
    try {
      const res = await api<Record<string, unknown>>("/api/attendance/verify", {
        body: { attemptId: p.attempt.attemptId, assertion: p.assertion, location: fix, installationId: await getInstallationId(), submitForReview },
      });
      if (res.status === "retry") { setRetry(res as unknown as RetryInfo); setPhase("retry"); return; }
      setPass(res as unknown as Pass); setPhase("done");
    } catch (e) { fail(e instanceof ApiFailure ? (ERRORS[e.code] ?? e.message) : "Something went wrong. Try again."); }
  }, [fail]);

  const onDecoded = useCallback(async (text: string) => {
    if (busy.current) return; busy.current = true;
    await stopCamera(); setPhase("verifying"); setMessage(null);
    try {
      const attempt = await api<Attempt>("/api/attendance/attempts", {
        body: { qrPayload: text, installationId: await getInstallationId() },
      });
      // Location and passkey run in parallel to keep the whole check-in short; the server decides the order of checks.
      const fixPromise = getFix();
      fixPromise.catch(() => undefined);
      const assertion = await startAuthentication({ optionsJSON: attempt.options });
      pending.current = { attempt, assertion };
      let fix: Fix;
      try { fix = await fixPromise; } catch { return fail("We couldn't read your location. Allow location access for this site, step outside the signal shadow of thick walls if you can, and scan again."); }
      await submit(fix);
    } catch (e) {
      if (e instanceof ApiFailure) {
        if (e.code === "passkey_required") return fail(ERRORS.passkey_required);
        return fail(ERRORS[e.code] ?? e.message);
      }
      fail(e instanceof Error && e.name === "NotAllowedError" ? "The passkey prompt was cancelled. Scan the code again when you're ready." : "Something went wrong. Try again.");
    } finally { busy.current = false; }
  }, [fail, stopCamera, submit]);

  const start = useCallback(async () => {
    setMessage(null); setRetry(null); setPhase("scanning"); busy.current = false;
    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
      await new Promise((r) => requestAnimationFrame(r));
      const s = new Html5Qrcode("qr-reader", { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
      scanner.current = s;
      // Camera only — no file/image upload UI is offered.
      await s.start({ facingMode: "environment" }, { fps: 12, qrbox: (w, h) => { const n = Math.floor(Math.min(w, h) * 0.8); return { width: n, height: n }; } }, onDecoded, () => undefined);
    } catch (e) {
      const denied = e instanceof Error && /permission|denied|NotAllowed/i.test(e.message + e.name);
      fail(denied ? "Camera access is blocked. Allow camera access for this site in your browser settings, then try again." : "We couldn't open your camera. Close other apps that use it and try again.");
    }
  }, [fail, onDecoded]);

  const retryLocation = async (forReview: boolean) => {
    setPhase("verifying");
    try { await submit(await getFix(), forReview); } catch { fail("We couldn't read your location. Allow location access and scan again."); }
  };

  if (phase === "done" && pass) return <VerifiedPass pass={pass} />;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Scan attendance</h1>
      {phase === "idle" && (
        <div className="panel space-y-3 p-5">
          <p className="text-ink-soft">Point your camera at the code on the lecture screen. You&apos;ll then confirm with your passkey and your location.</p>
          <button className="btn btn-primary w-full text-lg" onClick={start}>Open camera</button>
        </div>
      )}
      {phase === "scanning" && (
        <div className="space-y-3">
          <div id="qr-reader" className="panel overflow-hidden" aria-label="Camera view" />
          <button className="btn btn-quiet w-full" onClick={async () => { await stopCamera(); setPhase("idle"); }}>Cancel</button>
        </div>
      )}
      {phase === "verifying" && (
        <div className="panel p-5" role="status" aria-live="polite">
          <p className="font-semibold">Checking you in…</p>
          <p className="mt-1 text-sm text-ink-soft">Confirm with your passkey if asked, and allow location access.</p>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#e3ebe9]"><div className="h-full w-1/3 animate-pulse rounded-full bg-teal" /></div>
        </div>
      )}
      {phase === "retry" && retry && (
        <div className="panel space-y-3 border-amber p-5" role="alert">
          <p className="font-semibold">{retry.reason === "poor_accuracy" ? "Your location signal is too weak." : "We can't confirm you're inside the hall yet."}</p>
          <p className="text-sm text-ink-soft">Accuracy {retry.accuracyMeters} m (needs {retry.maxAccuracyMeters} m or better). Move near a window or doorway, wait a few seconds, then try again.</p>
          <button className="btn btn-primary w-full" onClick={() => retryLocation(false)}>Try location again</button>
          {retry.canSubmitForReview && <button className="btn btn-quiet w-full" onClick={() => retryLocation(true)}>Send to my lecturer for review</button>}
        </div>
      )}
      {phase === "error" && (
        <div className="panel space-y-3 p-5" role="alert">
          <p className="font-semibold text-bad">{message}</p>
          <button className="btn btn-primary w-full" onClick={start}>Scan again</button>
          <Link href="/student" className="btn btn-quiet w-full">Back to today</Link>
        </div>
      )}
    </div>
  );
}

/** Verified pass: a live seconds clock lets a TA see at a glance that this is a fresh screen, not a screenshot. */
function VerifiedPass({ pass }: { pass: Pass }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const review = pass.review;
  return (
    <div className={`panel overflow-hidden ${review ? "" : "border-ok"}`} role="status">
      <div className={`px-5 py-6 text-center ${review ? "bg-warn-bg text-warn" : "bg-ok-bg text-ok"}`}>
        <svg viewBox="0 0 48 48" className="mx-auto size-16" aria-hidden><circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="132" strokeDashoffset="132" style={{ animation: "draw 0.7s ease-out forwards" }} /><path d="M14 25l7 7 13-15" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="40" strokeDashoffset="40" style={{ animation: "draw 0.5s 0.5s ease-out forwards" }} /></svg>
        <style>{"@keyframes draw{to{stroke-dashoffset:0}} @media (prefers-reduced-motion:reduce){svg *{animation:none!important;stroke-dashoffset:0!important}}"}</style>
        <h1 className="mt-2 text-2xl font-bold">{review ? "Sent for review" : pass.status === "late" ? "Checked in (late)" : "You're checked in"}</h1>
        {review && <p className="mt-1 text-sm">Your lecturer will confirm your attendance.</p>}
      </div>
      <dl className="space-y-3 p-5">
        <div><dt className="text-sm text-ink-soft">Student</dt><dd className="text-lg font-bold">{pass.student.name}</dd><dd className="text-ink-soft">{pass.student.universityId}</dd></div>
        <div><dt className="text-sm text-ink-soft">Subject</dt><dd className="font-semibold">{pass.subject.name} ({pass.subject.code})</dd></div>
        <div><dt className="text-sm text-ink-soft">Checked in</dt><dd className="font-semibold tabular-nums">{new Date(pass.checkedInAt).toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo" })}</dd></div>
        <div className="border-t border-line pt-3 text-center font-display text-3xl font-bold tabular-nums" aria-label="Live clock">{now.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo" })}</div>
      </dl>
      <div className="p-5 pt-0"><Link href="/student" className="btn btn-primary w-full">Done</Link></div>
    </div>
  );
}
