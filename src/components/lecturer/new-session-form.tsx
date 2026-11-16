"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiFailure } from "@/lib/client/api";

type Props = { subjects: { id: string; code: string; name: string }[]; halls: { id: string; name: string }[]; groups: Record<string, { id: string; label: string }[]> };

export function NewSessionForm({ subjects, halls, groups }: Props) {
  const router = useRouter();
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError(null);
    const f = new FormData(e.currentTarget);
    try {
      const { id } = await api<{ id: string }>("/api/sessions", { body: { subjectId, groupId: f.get("groupId") || null, hallId: f.get("hallId"), lateThresholdMinutes: Number(f.get("late")) } });
      router.push(`/lecturer/sessions/${id}/projector`);
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "session_already_open") { router.push(`/lecturer/sessions/${err.data.sessionId}`); return; }
      setError(err instanceof ApiFailure ? err.message : "Could not start the session."); setBusy(false);
    }
  }

  if (!subjects.length) return <p className="panel p-4 text-ink-soft">No subjects are assigned to you yet. Ask your administrator.</p>;
  return (
    <form onSubmit={submit} className="panel space-y-4 p-5">
      <label className="block"><span className="mb-1 block text-sm font-semibold">Subject</span>
        <select className="input" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} required>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}</select></label>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Group</span>
        <select name="groupId" className="input" key={subjectId} defaultValue="">
          <option value="">All enrolled groups</option>
          {(groups[subjectId] ?? []).map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Lecture hall</span>
        <select name="hallId" className="input" required>{halls.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
      <label className="block"><span className="mb-1 block text-sm font-semibold">Mark students late after</span>
        <div className="flex items-center gap-2"><input name="late" type="number" min={0} max={180} defaultValue={15} className="input w-28" /><span>minutes</span></div></label>
      {error && <p role="alert" className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{error}</p>}
      <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Starting…" : "Start session and open projector"}</button>
    </form>
  );
}
