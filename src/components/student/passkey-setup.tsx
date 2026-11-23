"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { api, ApiFailure } from "@/lib/client/api";
import { getInstallationId } from "@/lib/client/installation";

type Existing = { id: string; nickname: string | null; synced: boolean };
type RegistrationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];

function passkeyFailureMessage(error: unknown): string {
  if (error instanceof ApiFailure) return error.message;
  const name = error instanceof Error ? error.name : "";

  if (name === "NotAllowedError") {
    return "The iPhone or browser did not complete the passkey request. It may have been cancelled, timed out, or blocked. Open this site directly in Safari, enable iCloud Passwords & Keychain, and try again.";
  }
  if (name === "SecurityError") {
    return "The browser rejected this site's passkey domain. Open the university's normal production URL, not a Vercel preview link, or contact the administrator.";
  }
  if (name === "NotSupportedError") {
    return "This browser cannot access a passkey provider. Try the latest version of Safari with iCloud Passwords & Keychain enabled.";
  }
  if (name === "InvalidStateError") {
    return "This phone may already have a passkey for this account. Check the Passwords app before trying again.";
  }
  if (name === "AbortError") {
    return "The passkey request was interrupted. Keep this page open and try again.";
  }
  return "This device couldn't create a passkey. Check that a device passcode or Face ID is set up, then try Safari again.";
}

export function PasskeySetup({ existing }: { universityId: string; fullName: string; existing: Existing[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"device" | "passkey" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [registrationOptions, setRegistrationOptions] = useState<RegistrationOptions | null>(null);
  const [preparingOptions, setPreparingOptions] = useState(true);
  const supported = typeof window === "undefined" || (window.isSecureContext && "PublicKeyCredential" in window);

  // The options are prepared before the student taps the button. This is important
  // for older iOS Safari releases, which can lose the user-gesture context if the
  // page awaits a network request before calling navigator.credentials.create().
  const optionsRef = useRef<RegistrationOptions | null>(null);
  const busyRef = useRef(false);
  const refreshOptionsRef = useRef<() => Promise<void>>(async () => {});

  const storeOptions = useCallback((value: RegistrationOptions | null) => {
    optionsRef.current = value;
    setRegistrationOptions(value);
  }, []);

  const refreshRegistrationOptions = useCallback(async () => {
    if (busyRef.current || !supported) return;
    setPreparingOptions(true);
    storeOptions(null);
    try {
      const options = await api<RegistrationOptions>("/api/webauthn/registration/options", {
        method: "POST",
        body: {},
      });
      if (!busyRef.current) storeOptions(options);
    } catch (error) {
      if (error instanceof ApiFailure) {
        setMsg({ kind: "err", text: error.message });
      } else {
        setMsg({ kind: "err", text: "Couldn't prepare passkey registration. Check your connection and try again." });
      }
    } finally {
      setPreparingOptions(false);
    }
  }, [storeOptions, supported]);

  useEffect(() => {
    refreshOptionsRef.current = refreshRegistrationOptions;
    void refreshRegistrationOptions();

    // Registration options expire on the server after five minutes. Refresh before
    // expiry, and refresh again when the student returns to a backgrounded tab.
    const interval = window.setInterval(() => {
      if (!document.hidden && !busyRef.current) void refreshRegistrationOptions();
    }, 3 * 60 * 1000);
    const onVisibilityChange = () => {
      if (!document.hidden && !busyRef.current) void refreshRegistrationOptions();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshRegistrationOptions]);

  async function linkDevice() {
    setBusy("device");
    setMsg(null);
    try {
      await api("/api/devices/register", { body: { installationId: await getInstallationId() } });
      setMsg({ kind: "ok", text: "This browser is linked to your account." });
    } catch (error) {
      setMsg({ kind: "err", text: error instanceof ApiFailure ? error.message : "Could not link this device." });
    }
    setBusy(null);
  }

  // Keep this handler synchronous up to startRegistration(). Do not await a fetch,
  // timer, storage operation, or other asynchronous work before this call.
  function createPasskey() {
    const options = optionsRef.current;
    if (!options || busyRef.current || !supported) return;

    busyRef.current = true;
    setBusy("passkey");
    setMsg(null);
    storeOptions(null); // A registration challenge is single-use; prepare a fresh one afterward.

    let registration: ReturnType<typeof startRegistration>;
    try {
      registration = startRegistration({ optionsJSON: options });
    } catch (error) {
      busyRef.current = false;
      setBusy(null);
      setMsg({ kind: "err", text: passkeyFailureMessage(error) });
      void refreshOptionsRef.current();
      return;
    }

    void completePasskeyRegistration(registration);
  }

  async function completePasskeyRegistration(registration: ReturnType<typeof startRegistration>) {
    let completed = false;
    try {
      const response = await registration;
      await api("/api/webauthn/registration/verify", {
        body: {
          response,
          nickname: navigator.userAgent.includes("iPhone")
            ? "iPhone"
            : navigator.userAgent.includes("Android")
              ? "Android phone"
              : "This device",
        },
      });
      await api("/api/devices/register", { body: { installationId: await getInstallationId() } });
      setMsg({ kind: "ok", text: "Passkey created and this device is linked. You're ready to check in." });
      completed = true;
      router.refresh();
    } catch (error) {
      setMsg({ kind: "err", text: passkeyFailureMessage(error) });
    } finally {
      busyRef.current = false;
      setBusy(null);
      if (!completed) void refreshOptionsRef.current();
    }
  }

  return (
    <div className="space-y-4">
      {!supported && <p role="alert" className="rounded-lg bg-bad-bg p-3 text-sm text-bad">Passkeys need a secure (HTTPS) connection and a supported browser. Open the installed app or use Safari.</p>}
      {existing.length > 0 && (
        <section className="panel p-4">
          <h2 className="font-bold">Your passkeys</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {existing.map((credential) => <li key={credential.id}>{credential.nickname ?? "Passkey"}{credential.synced && <span className="pill pill-mute ml-2">Synced across your devices</span>}</li>)}
          </ul>
        </section>
      )}
      <section className="panel space-y-3 p-4">
        <h2 className="font-bold">{existing.length ? "Add another passkey" : "Create your passkey"}</h2>
        <p className="text-sm text-ink-soft">You'll be asked to confirm with fingerprint, face or PIN. On iPhone, the passkey is normally saved in Passwords/iCloud Keychain.</p>
        <button className="btn btn-primary w-full" onClick={createPasskey} disabled={busy !== null || !supported || !registrationOptions}>
          {busy === "passkey" ? "Waiting for your phone…" : preparingOptions ? "Preparing passkey…" : registrationOptions ? "Create passkey" : "Passkey setup unavailable — retry by reloading"}
        </button>
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
