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
type ZoomCapabilities = MediaTrackCapabilities & { zoom?: number | { min: number; max: number; step?: number } };

/**
 * html5-qrcode 2.3.8 creates two object URLs synchronously inside scanFile():
 * one is tracked by the library and one is assigned to its temporary Image.
 * Track both during that synchronous setup and release them when decoding ends.
 * The override is restored before the asynchronous decode continues.
 */
async function scanFileAndReleaseObjectUrls(
  decoder: import("html5-qrcode").Html5Qrcode,
  file: File,
): Promise<string> {
  const originalCreateObjectURL = URL.createObjectURL;
  const createdUrls: string[] = [];
  let patched = false;

  try {
    URL.createObjectURL = ((object: Blob | MediaSource) => {
      const url = originalCreateObjectURL.call(URL, object);
      createdUrls.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    patched = true;
  } catch {
    // If a browser exposes a non-writable method, keep scanning; the decoder
    // still functions and its own tracked URL cleanup remains available.
  }

  let scanPromise: Promise<string>;
  try {
    scanPromise = decoder.scanFile(file, false);
  } catch (error) {
    for (const url of createdUrls) URL.revokeObjectURL(url);
    throw error;
  } finally {
    if (patched) URL.createObjectURL = originalCreateObjectURL;
  }

  try {
    return await scanPromise;
  } finally {
    for (const url of createdUrls) URL.revokeObjectURL(url);
  }
}

const getFix = () => new Promise<Fix>((resolve, reject) =>
  navigator.geolocation.getCurrentPosition(
    (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }), reject,
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }));

const ERRORS: Record<string, string> = {
  qr_expired: "That code has already changed. Point your camera at the code on the screen again.", invalid_qr: "That isn't an attendance code. Scan the code shown by your lecturer.",
  not_eligible: "You can't check in to this session.", session_not_active: "Attendance isn't open for this session.", already_checked_in: "You're already checked in.",
  passkey_required: "Set up your passkey first.", attempt_invalid: "This check-in timed out. Scan the code again.", verification_failed: "We couldn't verify your passkey. Scan the code and try again.",
  outside_geofence: "You don't appear to be in the lecture hall. Ask your lecturer to check you in manually.", device_conflict: "This browser or installed app is already assigned to another student account. Contact your administrator.",
  device_revoked: "This browser or device registration has been revoked. Contact your administrator.", device_approval_required: "This student account is linked to another browser or device. Ask your administrator to verify you and reset the previous device.",
  device_identity_changed: "This browser's saved installation identity changed. Contact your administrator before clearing storage or switching accounts.",
};

export function ScannerFlow() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<RetryInfo | null>(null);
  const [pass, setPass] = useState<Pass | null>(null);
  const [zoom, setZoom] = useState(1);
  const [hardwareMax, setHardwareMax] = useState(1);
  const [zoomMessage, setZoomMessage] = useState("Checking camera zoom support…");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const scanner = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const frameRef = useRef<number | null>(null);
  const detectingRef = useRef(false);
  const lastDecodeAtRef = useRef(0);
  const pending = useRef<{ attempt: Attempt; assertion: unknown } | null>(null);
  const busy = useRef(false);
  const zoomRef = useRef(1);
  const hardwareMaxRef = useRef(1);
  const scanGenerationRef = useRef(0);
  const appliedHardwareZoomRef = useRef(1);

  const stopCamera = useCallback(async () => {
    // Invalidate pending getUserMedia(), canvas, and decoder promises. A frame
    // that finishes after Cancel must never be allowed to start check-in.
    scanGenerationRef.current += 1;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null; detectingRef.current = false;
    const stream = streamRef.current; streamRef.current = null; trackRef.current = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    const s = scanner.current; scanner.current = null;
    if (s) {
      try { if (s.isScanning) await s.stop(); } catch { /* file scan may already have completed */ }
      try { s.clear(); } catch { /* decoder host is being removed */ }
    }
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

  const onDecoded = useCallback(async (text: string, generation: number) => {
    if (generation !== scanGenerationRef.current || busy.current) return;
    busy.current = true;
    // Remove the Cancel control before stopping the camera and beginning the
    // verification flow, so a late click cannot race this transition.
    setPhase("verifying");
    setMessage(null);
    await stopCamera();
    try {
      const attempt = await api<Attempt>("/api/attendance/attempts", { body: { qrPayload: text, installationId: await getInstallationId() } });
      const fixPromise = getFix(); fixPromise.catch(() => undefined);
      const assertion = await startAuthentication({ optionsJSON: attempt.options });
      pending.current = { attempt, assertion };
      let fix: Fix;
      try { fix = await fixPromise; } catch { return fail("We couldn't read your location. Allow location access for this site, step outside the signal shadow of thick walls if you can, and scan again."); }
      await submit(fix);
    } catch (e) {
      if (e instanceof ApiFailure) { if (e.code === "passkey_required") return fail(ERRORS.passkey_required); return fail(ERRORS[e.code] ?? e.message); }
      fail(e instanceof Error && e.name === "NotAllowedError" ? "The passkey prompt was cancelled. Scan the code again when you're ready." : "Something went wrong. Try again.");
    } finally { busy.current = false; }
  }, [fail, stopCamera, submit]);

  const applyZoom = useCallback(async (next: number) => {
    zoomRef.current = next; setZoom(next);
    const hardware = Math.min(next, hardwareMaxRef.current);
    const track = trackRef.current;
    if (track && hardwareMaxRef.current > 1) {
      try {
        await track.applyConstraints({ advanced: [{ zoom: hardware } as MediaTrackConstraintSet] });
        appliedHardwareZoomRef.current = hardware;
      } catch {
        // Some browsers report zoom capability but reject runtime constraints.
        // Remove the hardware range from the slider and continue with digital
        // crop-and-enlarge instead of leaving the green range non-functional.
        hardwareMaxRef.current = 1;
        appliedHardwareZoomRef.current = 1;
        setHardwareMax(1);
        try { await track.applyConstraints({ advanced: [{ zoom: 1 } as MediaTrackConstraintSet] }); } catch { /* retain camera's current setting */ }
        setZoomMessage("Hardware zoom is unavailable in this browser. Digital scanning zoom is available up to 10×.");
      }
    }
  }, []);

  const start = useCallback(async () => {
    await stopCamera();
    const generation = ++scanGenerationRef.current;
    setMessage(null); setRetry(null); setPhase("scanning"); busy.current = false; setZoom(1);
    zoomRef.current = 1; lastDecodeAtRef.current = 0;
    hardwareMaxRef.current = 1; appliedHardwareZoomRef.current = 1;
    setHardwareMax(1);
    try {
      await new Promise((r) => requestAnimationFrame(r));
      if (generation !== scanGenerationRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d", { willReadFrequently: true });
      if (!video || !canvas || !ctx) throw new Error("Camera view or image processing is unavailable");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      if (generation !== scanGenerationRef.current) {
        stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
        return;
      }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No camera video track is available");
      trackRef.current = track;
      const caps = typeof track.getCapabilities === "function"
        ? track.getCapabilities() as ZoomCapabilities
        : {} as ZoomCapabilities;
      const z = caps.zoom;
      const max = typeof z === "number" ? z : z?.max ?? 1;
      const min = typeof z === "object" ? z.min : 1;
      let hwMax = Math.max(1, Math.min(10, max));
      if (typeof z !== "undefined" && max > min && hwMax > 1) {
        const initialHardwareZoom = Math.max(1, min);
        try {
          await track.applyConstraints({ advanced: [{ zoom: initialHardwareZoom } as MediaTrackConstraintSet] });
          appliedHardwareZoomRef.current = initialHardwareZoom;
        } catch {
          // A reported capability is not enough: only expose hardware zoom
          // after the browser accepts an actual camera constraint.
          hwMax = 1;
          appliedHardwareZoomRef.current = 1;
        }
      }
      if (generation !== scanGenerationRef.current) {
        stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
        return;
      }
      hardwareMaxRef.current = hwMax;
      setHardwareMax(hwMax);

      video.srcObject = stream;
      await video.play();
      if (generation !== scanGenerationRef.current) return;
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
      if (generation !== scanGenerationRef.current) return;
      const decoderHost = document.getElementById("qr-decoder-engine");
      if (!decoderHost) throw new Error("QR decoder host is unavailable");
      decoderHost.innerHTML = "";
      const decoder = new Html5Qrcode("qr-decoder-engine", {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        // Keep decoding on html5-qrcode's ZXing implementation on every browser.
        useBarCodeDetectorIfSupported: false,
        verbose: false,
      });
      scanner.current = decoder;
      setZoomMessage(hwMax > 1
        ? `Hardware zoom to ${hwMax.toFixed(1)}×, then digital scanning zoom to 10×`
        : "Digital scanning zoom to 10× (camera has no adjustable hardware zoom)");

      // Use the same html5-qrcode ZXing decoder for cropped/upscaled frames.
      // scanFile() is run serially at a modest cadence; the helper also releases
      // both temporary object URLs created by html5-qrcode 2.3.8 per frame.
      const scanFrame = async (now: number) => {
        if (generation !== scanGenerationRef.current) return;
        const activeDecoder = scanner.current;
        if (busy.current || !activeDecoder || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          if (generation === scanGenerationRef.current && !busy.current && activeDecoder) {
            frameRef.current = requestAnimationFrame(scanFrame);
          }
          return;
        }
        if (!detectingRef.current && now - lastDecodeAtRef.current >= 450) {
          detectingRef.current = true;
          lastDecodeAtRef.current = now;
          try {
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            if (!vw || !vh) throw new Error("Camera frame is not ready");
            const currentZoom = zoomRef.current;
            const optical = Math.max(1, Math.min(currentZoom, appliedHardwareZoomRef.current));
            const digital = Math.max(1, currentZoom / optical);
            const cropW = vw / digital;
            const cropH = vh / digital;
            const sx = (vw - cropW) / 2;
            const sy = (vh - cropH) / 2;
            canvas.width = vw;
            canvas.height = vh;
            ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, vw, vh);
            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
            if (blob && generation === scanGenerationRef.current && scanner.current === activeDecoder && !busy.current) {
              const frameFile = new File([blob], "qr-frame.jpg", { type: "image/jpeg" });
              try {
                const decoded = await scanFileAndReleaseObjectUrls(activeDecoder, frameFile);
                if (generation === scanGenerationRef.current && scanner.current === activeDecoder && decoded) {
                  await onDecoded(decoded, generation);
                  return;
                }
              } catch {
                // A frame without a QR code is expected; continue with the next.
              }
            }
          } catch {
            // Ignore an individual frame processing error and continue scanning.
          } finally {
            if (generation === scanGenerationRef.current) detectingRef.current = false;
          }
        }
        if (generation === scanGenerationRef.current && scanner.current === activeDecoder && !busy.current) {
          frameRef.current = requestAnimationFrame(scanFrame);
        }
      };
      frameRef.current = requestAnimationFrame(scanFrame);
    } catch (e) {
      if (generation !== scanGenerationRef.current) return;
      await stopCamera();
      const denied = e instanceof Error && /permission|denied|NotAllowed/i.test(e.message + e.name);
      fail(denied
        ? "Camera access is blocked. Allow camera access for this site in your browser settings, then try again."
        : "We couldn't open your camera or QR decoder. Close other apps that use the camera and try again.");
    }
  }, [fail, onDecoded, stopCamera]);

  const retryLocation = async (forReview: boolean) => { setPhase("verifying"); try { await submit(await getFix(), forReview); } catch { fail("We couldn't read your location. Allow location access and scan again."); } };
  const maxZoom = 10;
  const zoomPercent = maxZoom <= 1 ? 0 : ((zoom - 1) / (maxZoom - 1)) * 100;
  const hardwarePercent = maxZoom <= 1 ? 0 : ((hardwareMax - 1) / (maxZoom - 1)) * 100;

  if (phase === "done" && pass) return <VerifiedPass pass={pass} />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Scan attendance</h1>
      {phase === "idle" && <div className="panel space-y-3 p-5"><p className="text-ink-soft">Point your camera at the code on the lecture screen. You&apos;ll then confirm with your passkey and your location.</p><button className="btn btn-primary w-full text-lg" onClick={start}>Open camera</button></div>}
      {phase === "scanning" && <div className="space-y-3">
        <div className="panel overflow-hidden" aria-label="Camera view">
          <video ref={videoRef} className="block max-h-[55vh] w-full bg-black object-contain" style={{ transform: `scale(${Math.max(1, zoom / Math.max(1, Math.min(zoom, hardwareMax)))})`, transformOrigin: "center center" }} playsInline muted autoPlay />
          <canvas ref={canvasRef} className="hidden" />
          <div id="qr-decoder-engine" className="hidden" aria-hidden="true" />
        </div>
        <style>{`#camera-zoom::-webkit-slider-thumb{appearance:none;width:30px;height:30px;background:transparent;border:0}#camera-zoom::-moz-range-thumb{width:30px;height:30px;background:transparent;border:0}#camera-zoom::-webkit-slider-runnable-track{height:12px;background:transparent}#camera-zoom::-moz-range-track{height:12px;background:transparent}`}</style>
        <div className="panel space-y-3 p-4">
          <div className="flex items-center justify-between gap-3"><label htmlFor="camera-zoom" className="font-semibold">Camera zoom</label><span className="rounded-full bg-surface-2 px-3 py-1 text-sm font-bold tabular-nums">{zoom.toFixed(1)}×</span></div>
          <div className="relative px-2 pt-2">
            <div className="relative h-3 rounded-full" style={{ background: `linear-gradient(to right, #16a34a 0%, #16a34a ${hardwarePercent}%, #dc2626 ${hardwarePercent}%, #dc2626 100%)` }}>
              <input id="camera-zoom" aria-label="Camera zoom level" type="range" min="1" max={maxZoom} step="0.1" value={Math.min(zoom, maxZoom)} onChange={(e) => void applyZoom(Number(e.target.value))} className="absolute inset-0 h-3 w-full cursor-pointer appearance-none bg-transparent touch-pan-x focus:outline-none focus-visible:ring-2 focus-visible:ring-teal" style={{ accentColor: "white" }} />
              <div aria-hidden className="pointer-events-none absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-slate-900 shadow-lg" style={{ left: `${zoomPercent}%` }}><div className="absolute inset-1 rounded-full bg-white" /></div>
            </div>
            <div className="mt-3 flex justify-between text-xs font-semibold"><span className="text-green-700">1× · Hardware</span><span className="text-red-600">Digital · 10×</span></div>
          </div>
          <p className="text-xs text-ink-soft" aria-live="polite">{zoomMessage}</p>
        </div>
        <button className="btn btn-quiet w-full" onClick={async () => { await stopCamera(); setPhase("idle"); }}>Cancel</button>
      </div>}
      {phase === "verifying" && <div className="panel p-5" role="status" aria-live="polite"><p className="font-semibold">Checking you in…</p><p className="mt-1 text-sm text-ink-soft">Confirm with your passkey if asked, and allow location access.</p><div className="mt-4 h-1.5 overflow-hidden rounded-full bg-track"><div className="h-full w-1/3 animate-pulse rounded-full bg-teal" /></div></div>}
      {phase === "retry" && retry && <div className="panel space-y-3 border-amber p-5" role="alert"><p className="font-semibold">{retry.reason === "poor_accuracy" ? "Your location signal is too weak." : "We can't confirm you're inside the hall yet."}</p><p className="text-sm text-ink-soft">Accuracy {retry.accuracyMeters} m (needs {retry.maxAccuracyMeters} m or better). Move near a window or doorway, wait a few seconds, then try again.</p><button className="btn btn-primary w-full" onClick={() => retryLocation(false)}>Try location again</button>{retry.canSubmitForReview && <button className="btn btn-quiet w-full" onClick={() => retryLocation(true)}>Send to my lecturer for review</button>}</div>}
      {phase === "error" && <div className="panel space-y-3 p-5" role="alert"><p className="font-semibold text-bad">{message}</p><button className="btn btn-primary w-full" onClick={start}>Scan again</button><Link href="/student" className="btn btn-quiet w-full">Back to today</Link></div>}
    </div>
  );
}

function VerifiedPass({ pass }: { pass: Pass }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const review = pass.review;
  return <div className={`panel overflow-hidden ${review ? "" : "border-ok"}`} role="status"><div className={`px-5 py-6 text-center ${review ? "bg-warn-bg text-warn" : "bg-ok-bg text-ok"}`}><svg viewBox="0 0 48 48" className="mx-auto size-16" aria-hidden><circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="132" strokeDashoffset="132" style={{ animation: "draw 0.7s ease-out forwards" }} /><path d="M14 25l7 7 13-15" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="40" strokeDashoffset="40" style={{ animation: "draw 0.5s 0.5s ease-out forwards" }} /></svg><style>{"@keyframes draw{to{stroke-dashoffset:0}} @media (prefers-reduced-motion:reduce){svg *{animation:none!important;stroke-dashoffset:0!important}}"}</style><h1 className="mt-2 text-2xl font-bold">{review ? "Sent for review" : pass.status === "late" ? "Checked in (late)" : "You're checked in"}</h1>{review && <p className="mt-1 text-sm">Your lecturer will confirm your attendance.</p>}</div><dl className="space-y-3 p-5"><div><dt className="text-sm text-ink-soft">Student</dt><dd className="text-lg font-bold">{pass.student.name}</dd><dd className="text-ink-soft">{pass.student.universityId}</dd></div><div><dt className="text-sm text-ink-soft">Subject</dt><dd className="font-semibold">{pass.subject.name} ({pass.subject.code})</dd></div><div><dt className="text-sm text-ink-soft">Checked in</dt><dd className="font-semibold tabular-nums">{new Date(pass.checkedInAt).toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo" })}</dd></div><div className="border-t border-line pt-3 text-center font-display text-3xl font-bold tabular-nums" aria-label="Live clock">{now.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo" })}</div></dl><div className="p-5 pt-0"><Link href="/student" className="btn btn-primary w-full">Done</Link></div></div>;
}
