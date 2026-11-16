import { requirePage } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { PasskeySetup } from "@/components/student/passkey-setup";

export const metadata = { title: "Passkey & device" };
export const dynamic = "force-dynamic";

export default async function Onboarding() {
  const actor = await requirePage("student");
  const { data } = await adminClient().from("webauthn_credentials").select("id, nickname, device_type, backed_up, created_at").eq("user_id", actor.id).is("revoked_at", null);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Passkey &amp; device</h1>
      <p className="text-ink-soft">A passkey lets you confirm check-ins with your fingerprint, face or phone PIN. Your biometric never leaves your phone.</p>
      <PasskeySetup universityId={actor.universityId} fullName={actor.fullName} existing={(data ?? []).map((c) => ({ id: c.id, nickname: c.nickname, synced: Boolean(c.backed_up) }))} />
    </div>
  );
}
