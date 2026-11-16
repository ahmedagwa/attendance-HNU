"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiFailure } from "@/lib/client/api";

const HEADER = "email,full_name,university_id,role,password";

/** CSV: email,full_name,university_id,role,password  (role = student | lecturer | admin). Names with commas are not supported. */
export function BulkUsers() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; text: string; failures?: string[] } | null>(null);

  async function submit() {
    setBusy(true); setOut(null);
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => l.toLowerCase() !== HEADER);
    const users = lines.map((l) => { const [email, fullName, universityId, role, ...pw] = l.split(",").map((c) => c.trim()); return { email, fullName, universityId, role, password: pw.join(",") }; });
    try {
      const r = await api<{ created: number; results: { email: string; ok: boolean; error?: string }[] }>("/api/admin/users", { body: { users } });
      setOut({ ok: r.created === users.length, text: `Created ${r.created} of ${users.length} accounts.`, failures: r.results.filter((x) => !x.ok).map((x) => `${x.email}: ${x.error}`) });
      if (r.created) { setText(""); router.refresh(); }
    } catch (e) { setOut({ ok: false, text: e instanceof ApiFailure ? e.message : "Could not create accounts. Check the CSV format." }); }
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <label className="block"><span className="mb-1 block text-sm font-semibold">Accounts (one per line)</span>
        <textarea className="input min-h-36 font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder={`${HEADER}\nsara@uni.edu,Sara Ahmed,2026001,student,Temp-Pass-123`} /></label>
      <p className="text-xs text-ink-soft">Passwords must be at least 10 characters. Share them privately; students should change them after first sign-in.</p>
      <button className="btn btn-primary" onClick={submit} disabled={busy || !text.trim()}>{busy ? "Creating…" : "Create accounts"}</button>
      {out && <div role="status" className={`rounded-lg p-3 text-sm ${out.ok ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}><p className="font-semibold">{out.text}</p>{out.failures?.map((f) => <p key={f}>{f}</p>)}</div>}
    </div>
  );
}
