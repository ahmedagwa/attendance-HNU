"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { api, ApiFailure } from "@/lib/client/api";
import { getInstallationId } from "@/lib/client/installation";

type Existing = { id: string; nickname: string | null; synced: boolean };

export function PasskeySetup({ existing }: { universityId: string; fullName: string; existing: Existing[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"device" | "passkey" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const supported = typeof window === "undefined" || (window.isSecureContext && "PublicKeyCredential" in window);

  async function linkDevice() {
    setBusy("device"); setMsg(null);
    try { await api("/api/devices/register", { body: { installationId: await getInstallationId() } }); setMsg({ kind: "ok", text: "This browser is linked to your account." }); }
    catch (e) { setMsg({ kind: "err", text: e instanceof ApiFailure ? e.message : "Could not link this device." }); }
    setBusy(null);
  }

  async function createPasskey() {
    setBusy("passkey"); setMsg(null);
    try {
      const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/webauthn/registration/options", { method: "POST", body: {} });
      const response = await startRegistration({ optionsJSON: options });
      await api("/api/webauthn/registration/verify", { body: { response, nickname: navigator.userAgent.includes("iPhone") ? "iPhone" : navigator.userAgent.includes("Android") ? "Android phone" : "This device" } });
      await api("/api/devices/register", { body: { installationId: await getInstallationId() } });
      setMsg({ kind: "ok", text: "Passkey created and this device is linked. You're ready to check in." });
      router.refresh();
    } catch (e) {
      const cancelled = e instanceof Error && e.name === "NotAllowedError";
      setMsg({ kind: "err", text: e instanceof ApiFailure ? e.message : cancelled ? "The passkey prompt was cancelled. Try again when you're ready." : "This device couldn't create a passkey. Make sure a screen lock is set up, then try again." });
    }
    setBusy(null);
  }

  return (
    <div className="space-y-4">
      {!supported && <p role="alert" className="rounded-lg bg-bad-bg p-3 text-sm text-bad">Passkeys need a secure (HTTPS) connection and a supported browser. Open the installed app or use Chrome or Safari.</p>}
      {existing.length > 0 && (
        <section className="panel p-4">
          <h2 className="font-bold">Your passkeys</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {existing.map((c) => <li key={c.id}>{c.nickname ?? "Passkey"}{c.synced && <span className="pill pill-mute ml-2">Synced across your devices</span>}</li>)}
          </ul>
        </section>
      )}
      <section className="panel space-y-3 p-4">
        <h2 className="font-bold">{existing.length ? "Add another passkey" : "Create your passkey"}</h2>
        <p className="text-sm text-ink-soft">You&apos;ll be asked to confirm with fingerprint, face or PIN.</p>
        <button className="btn btn-primary w-full" onClick={createPasskey} disabled={busy !== null || !supported}>{busy === "passkey" ? "Waiting for your phone…" : "Create passkey"}</button>
      </section>
      <section className="panel space-y-3 p-4">
        <h2 className="font-bold">Device assignment</h2>
        <p className="text-sm text-ink-soft">This browser or installed app is assigned to one student account automatically when you sign in. Signing out does not release it. On Android, always use the same Chrome/browser profile or installed PWA. On iPhone, choose either Safari or the Home Screen app and keep using that same one. Do not use private browsing, clear site data, reinstall the app or switch browser contexts without an administrator-approved reset.</p>
        <button className="btn btn-quiet w-full" onClick={linkDevice} disabled={busy !== null}>{busy === "device" ? "Checking…" : "Verify this device link"}</button>
      </section>
      {msg && <p role={msg.kind === "err" ? "alert" : "status"} className={`rounded-lg p-3 text-sm ${msg.kind === "ok" ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"}`}>{msg.text}</p>}
      <p className="text-sm text-ink-soft">Lost your phone? Ask your administrator to reset your passkeys so you can set up a new device.</p>
    </div>
  );
}
