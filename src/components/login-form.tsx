"use client";
import { useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import { api, ApiFailure } from "@/lib/client/api";
import { getInstallationId } from "@/lib/client/installation";

export function LoginForm({ next, notice }: { next?: string; notice?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError(null);
    const f = new FormData(e.currentTarget);
    const supabase = browserClient();
    const { error } = await supabase.auth.signInWithPassword({ email: String(f.get("email")), password: String(f.get("password")) });
    if (error) { setError("That email and password don't match. Check them and try again."); setBusy(false); return; }

    // Claim the persistent browser/PWA installation before allowing a student into the portal.
    // The server skips this policy for lecturer and admin accounts.
    try {
      await api("/api/devices/register", {
        body: { installationId: await getInstallationId() },
      });
    } catch (e) {
      await supabase.auth.signOut();
      const message = e instanceof ApiFailure
        ? e.code === "device_conflict"
          ? "This browser or installed app is already assigned to another student account. Switching student accounts on this installation is blocked. Use the same student account or contact your administrator for a verified device transfer."
          : e.code === "device_approval_required"
            ? "This student account is already linked to another browser or device. Ask your administrator to verify you and reset the previous device before using this one."
            : e.code === "device_revoked"
              ? "This browser or device registration has been revoked. Contact your administrator before signing in again."
              : e.code === "device_identity_changed"
                ? "This browser's saved installation identity changed. Contact your administrator before clearing storage or switching accounts."
                : e.message
        : "We couldn't verify this browser or app installation. Check your connection and try again.";
      setError(message);
      setBusy(false);
      return;
    }

    const validNext = next && /^\/(admin|lecturer|student)(\/|$)/.test(next);
    const destination = validNext ? next! : "/";
    window.location.assign(destination);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block"><span className="mb-1 block text-sm font-semibold">University email</span>
        <input name="email" type="email" required autoComplete="username" inputMode="email" className="input" /></label>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Password</span>
        <input name="password" type="password" required autoComplete="current-password" className="input" /></label>
      {notice && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p>}
      {error && <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</p>}
      <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
