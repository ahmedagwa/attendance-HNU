"use client";
import { useState } from "react";
import Link from "next/link";
import { api, ApiFailure } from "@/lib/client/api";
import { FLAG_LABELS, type Flag, type RosterRow } from "@/lib/client/types";
import { statusPill } from "@/components/app-shell";
import { useSessionLive } from "./use-session-live";

const Tile = ({ label, value, tone = "" }: { label: string; value: number | string; tone?: string }) => (
  <div className="panel p-4"><p className={`font-display text-3xl font-bold tabular-nums ${tone}`}>{value}</p><p className="text-sm text-ink-soft">{label}</p></div>
);

export function ControlRoom({ sessionId, subject, groups }: { sessionId: string; subject: string; groups: string[] }) {
  const { data, refresh, realtime } = useSessionLive(sessionId);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editing, setEditing] = useState<RosterRow | null>(null);
  const [filter, setFilter] = useState<"all" | "absent" | "review">("all");

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setNotice({ kind: "ok", text: ok }); await refresh(); }
    catch (e) { setNotice({ kind: "err", text: e instanceof ApiFailure ? e.message : "That didn't work. Try again." }); }
  };

  if (!data) return <p className="panel p-6 text-ink-soft" role="status">Loading session…</p>;
  const { session, summary: s, roster, flags, spotCheck } = data;
  const closed = session.status === "closed";
  const rows = roster.filter((r) => filter === "all" || (filter === "absent" ? r.status === "absent" : r.status === "review"));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-ink-soft">{closed ? "Closed" : session.status === "paused" ? "Paused" : "In progress"} · {realtime === "live" ? "live updates on" : "refreshing every 10 s"}</p>
          <h1 className="text-2xl font-bold">{subject}</h1>
          <p className="mt-1 text-sm text-ink-soft">Groups: {groups.join(", ") || "No groups"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!closed && <Link href={`/lecturer/sessions/${sessionId}/projector`} className="btn btn-primary">Open projector</Link>}
          {!closed && <button className="btn btn-quiet" onClick={() => run(() => api(`/api/sessions/${sessionId}/pause`, { body: { paused: session.status !== "paused" } }), session.status === "paused" ? "Check-in resumed." : "Check-in paused.")}>{session.status === "paused" ? "Resume" : "Pause"}</button>}
          {!closed && <button className="btn btn-danger" onClick={() => confirm("Close this session? Students will no longer be able to check in.") && run(() => api(`/api/sessions/${sessionId}/close`, { method: "POST", body: {} }), "Session closed.")}>Close session</button>}
          <a className="btn btn-quiet" href={`/api/sessions/${sessionId}/export`}>Export CSV</a>
        </div>
      </div>

      {notice && <p role={notice.kind === "err" ? "alert" : "status"} className={`rounded-lg p-3 text-sm ${notice.kind === "ok" ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"}`}>{notice.text}</p>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Tile label="Enrolled" value={s.enrolled} /><Tile label="Present" value={s.present} tone="text-ok" /><Tile label="Late" value={s.late} tone="text-warn" />
        <Tile label="Manual" value={s.manual} /><Tile label="In review" value={s.review} tone="text-warn" /><Tile label="Absent" value={s.absent} tone={s.absent ? "text-bad" : ""} />
      </div>

      {flags.length > 0 && (
        <section aria-label="Review queue" className="space-y-2">
          <h2 className="text-lg font-bold">Needs your review ({flags.length})</h2>
          <ul className="space-y-2">{flags.map((f) => <FlagItem key={f.id} flag={f} onResolve={(decision) => run(() => api(`/api/flags/${f.id}/resolve`, { body: { decision } }), "Flag resolved.")} />)}</ul>
        </section>
      )}

      <section className="panel p-4" aria-label="Spot check">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-bold">Spot check</h2><p className="text-sm text-ink-soft">Shows a random code on the projector for 20 seconds. Students who are checked in type it into the app.</p></div>
          <button className="btn btn-quiet" disabled={session.status !== "active"} onClick={() => run(() => api(`/api/sessions/${sessionId}/reverification`, { method: "POST", body: {} }), "Spot check started. The code is on the projector.")}>Start spot check</button>
        </div>
        {spotCheck && (
          <div className="mt-3 rounded-lg bg-chalk p-3 text-sm">
            <p><b>{spotCheck.active ? "Running" : "Finished"}</b> · {spotCheck.responded} responded, {spotCheck.correct} correct{spotCheck.active && <> · code <b className="font-display text-lg">{spotCheck.code}</b></>}</p>
            {!spotCheck.active && spotCheck.nonResponders.length > 0 && (
              <details className="mt-2"><summary className="cursor-pointer font-semibold">{spotCheck.nonResponders.length} didn&apos;t respond (a review signal, not proof)</summary>
                <ul className="mt-1 list-inside list-disc">{spotCheck.nonResponders.map((n) => <li key={n.studentId}>{n.fullName} · {n.universityId}</li>)}</ul></details>
            )}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">Students</h2>
          <div role="group" aria-label="Filter students" className="flex gap-1">
            {(["all", "absent", "review"] as const).map((f) => <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f} className={`btn min-h-9 text-sm ${filter === f ? "btn-primary" : "btn-quiet"}`}>{f === "all" ? "All" : f === "absent" ? "Absent" : "In review"}</button>)}
          </div>
        </div>
        <div className="panel overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-ink-soft"><tr><th className="p-3">ID</th><th>Name</th><th>Group</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.studentId} className="border-b border-line last:border-0">
                  <td className="p-3 tabular-nums">{r.universityId}</td><td className="font-semibold">{r.fullName}</td><td>{r.groupCode}</td>
                  <td><span className={statusPill[r.status]}>{r.status === "review" ? "in review" : r.status}</span>{r.source === "manual" && <span className="pill pill-mute ml-1" title={r.manualReason ?? ""}>manual</span>}</td>
                  <td className="p-3 text-right"><button className="font-semibold text-teal underline" onClick={() => setEditing(r)}>{r.status === "absent" || r.status === "rejected" ? "Mark present" : "Correct"}</button></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={5} className="p-4 text-ink-soft">No students match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {editing && <ManualDialog student={editing} onClose={() => setEditing(null)} onSave={(status, reason) => run(async () => { await api("/api/attendance/manual", { body: { sessionId, studentId: editing.studentId, status, reason } }); setEditing(null); }, `${editing.fullName} marked ${status}.`)} />}
    </div>
  );
}

function FlagItem({ flag, onResolve }: { flag: Flag; onResolve: (d: "approve" | "dismiss" | "reject") => void }) {
  const d = flag.details as { distance_m?: number; accuracy_m?: number };
  return (
    <li className="panel flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="font-semibold">{flag.student.full_name} <span className="font-normal text-ink-soft">{flag.student.university_id}</span></p>
        <p className="text-sm text-ink-soft"><span className={`pill mr-2 ${flag.severity === "high" ? "pill-bad" : flag.severity === "medium" ? "pill-warn" : "pill-mute"}`}>{flag.severity}</span>{FLAG_LABELS[flag.flag_type] ?? flag.flag_type}{d.distance_m != null && ` · ${d.distance_m} m away, ±${d.accuracy_m} m`}</p>
      </div>
      <div className="flex gap-2">
        {flag.flag_type === "geo_uncertain" && <button className="btn btn-primary min-h-9 text-sm" onClick={() => onResolve("approve")}>Approve</button>}
        <button className="btn btn-quiet min-h-9 text-sm" onClick={() => onResolve("dismiss")}>Dismiss</button>
        {flag.flag_type === "geo_uncertain" && <button className="btn btn-quiet min-h-9 text-sm text-bad" onClick={() => onResolve("reject")}>Reject</button>}
      </div>
    </li>
  );
}

function ManualDialog({ student, onClose, onSave }: { student: RosterRow; onClose: () => void; onSave: (status: "present" | "late", reason: string) => void }) {
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"present" | "late">("present");
  const valid = reason.trim().length >= 5;
  return (
    <div role="dialog" aria-modal="true" aria-label="Manual attendance" className="fixed inset-0 z-40 grid place-items-end bg-ink/50 p-0 sm:place-items-center sm:p-4">
      <form onSubmit={(e) => { e.preventDefault(); if (valid) onSave(status, reason.trim()); }} className="panel w-full max-w-md space-y-3 rounded-b-none p-5 sm:rounded-b-[0.9rem]">
        <h2 className="text-lg font-bold">Mark {student.fullName}</h2>
        <p className="text-sm text-ink-soft">This is recorded as a manual entry with your name and reason, and added to the audit log.</p>
        <div role="radiogroup" aria-label="Status" className="flex gap-2">
          {(["present", "late"] as const).map((v) => <button type="button" key={v} role="radio" aria-checked={status === v} onClick={() => setStatus(v)} className={`btn flex-1 ${status === v ? "btn-primary" : "btn-quiet"}`}>{v === "present" ? "Present" : "Late"}</button>)}
        </div>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Reason (required)</span>
          <textarea className="input min-h-20" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: phone battery died, camera broken" maxLength={300} autoFocus /></label>
        <div className="flex gap-2"><button type="button" className="btn btn-quiet flex-1" onClick={onClose}>Cancel</button><button className="btn btn-primary flex-1" disabled={!valid}>Save</button></div>
      </form>
    </div>
  );
}
