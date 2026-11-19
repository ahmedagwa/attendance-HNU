"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiFailure } from "@/lib/client/api";

type GroupOption = { id: string; label: string };
type Props = {
  subjects: { id: string; code: string; name: string }[];
  halls: { id: string; name: string }[];
  groups: Record<string, GroupOption[]>;
};

export function NewSessionForm({ subjects, halls, groups }: Props) {
  const router = useRouter();
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? "");
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>(() => groups[subjects[0]?.id ?? ""]?.map((g) => g.id) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentGroups = useMemo(() => groups[subjectId] ?? [], [groups, subjectId]);

  useEffect(() => {
    setSelectedGroupIds(currentGroups.map((group) => group.id));
  }, [subjectId, currentGroups]);

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroupIds((current) => checked
      ? [...new Set([...current, groupId])]
      : current.filter((id) => id !== groupId));
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedGroupIds.length) { setError("Select at least one student group."); return; }
    setBusy(true); setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const { id } = await api<{ id: string }>("/api/sessions", {
        body: {
          subjectId,
          groupIds: selectedGroupIds,
          hallId: String(form.get("hallId") ?? ""),
          lateThresholdMinutes: Number(form.get("late")),
        },
      });
      router.push(`/lecturer/sessions/${id}/projector`);
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "session_already_open") {
        const existingSessionId = err.data.sessionId;
        if (typeof existingSessionId === "string") {
          router.push(`/lecturer/sessions/${existingSessionId}`);
          return;
        }
      }
      setError(err instanceof ApiFailure ? err.message : "Could not start the session.");
      setBusy(false);
    }
  }

  if (!subjects.length) return <p className="panel p-4 text-ink-soft">No subjects are assigned to you yet. Ask your administrator.</p>;

  return (
    <form onSubmit={submit} className="panel space-y-4 p-5">
      <label className="block">
        <span className="mb-1 block text-sm font-semibold">Subject</span>
        <select className="input" value={subjectId} onChange={(event) => setSubjectId(event.target.value)} required>
          {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name} ({subject.code})</option>)}
        </select>
      </label>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">Groups included in this session</legend>
        {currentGroups.length ? currentGroups.map((group) => (
          <label key={group.id} className="flex min-h-11 items-center gap-3 rounded-lg border border-line px-3">
            <input
              type="checkbox"
              className="size-5 accent-teal"
              checked={selectedGroupIds.includes(group.id)}
              onChange={(event) => toggleGroup(group.id, event.target.checked)}
            />
            <span>{group.label}</span>
          </label>
        )) : <p className="rounded-lg bg-warn-bg p-3 text-sm text-warn">No groups have enrolled students in this subject yet.</p>}
        {currentGroups.length > 1 && <p className="text-xs text-ink-soft">Select both groups to host one shared session and display one shared QR code.</p>}
      </fieldset>

      <label className="block">
        <span className="mb-1 block text-sm font-semibold">Lecture hall</span>
        <select name="hallId" className="input" required>
          {halls.map((hall) => <option key={hall.id} value={hall.id}>{hall.name}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-semibold">Mark students late after</span>
        <div className="flex items-center gap-2"><input name="late" type="number" min={0} max={180} defaultValue={15} className="input w-28" /><span>minutes</span></div>
      </label>

      <div className="rounded-lg bg-chalk p-3 text-sm">
        <span className="font-semibold">Selected: </span>
        {currentGroups.filter((group) => selectedGroupIds.includes(group.id)).map((group) => group.label).join(", ") || "No groups selected"}
      </div>
      {error && <p role="alert" className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{error}</p>}
      <button className="btn btn-primary w-full" disabled={busy || !currentGroups.length || !halls.length || !selectedGroupIds.length}>
        {busy ? "Starting…" : "Start session and open projector"}
      </button>
    </form>
  );
}
