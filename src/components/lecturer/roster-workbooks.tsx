"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Subject = { id: string; code: string; name: string };
type WorkbookInfo = { id: string; subject_id: string; original_filename: string; updated_at: string };

export function RosterWorkbooks({ subjects, workbooks }: { subjects: Subject[]; workbooks: WorkbookInfo[] }) {
  if (!subjects.length) return null;
  const bySubject = new Map(workbooks.map((item) => [item.subject_id, item]));
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-bold">Your Excel attendance workbooks</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Upload your university .xlsx roster once for each subject. Each professor and teaching assistant has a separate private copy. A new Session column is filled only for sessions you opened, when those sessions are closed.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {subjects.map((subject) => <RosterWorkbookCard key={subject.id} subject={subject} workbook={bySubject.get(subject.id) ?? null} />)}
      </div>
    </section>
  );
}

function RosterWorkbookCard({ subject, workbook }: { subject: Subject; workbook: WorkbookInfo | null }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [idColumnHeader, setIdColumnHeader] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) { setNotice({ kind: "err", text: "Choose an .xlsx workbook first." }); return; }
    setBusy(true); setNotice(null);
    const body = new FormData();
    body.set("subjectId", subject.id);
    body.set("file", file);
    if (idColumnHeader.trim()) body.set("idColumnHeader", idColumnHeader.trim());
    try {
      const response = await fetch("/api/lecturer/rosters", { method: "POST", body, cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message ?? "The workbook could not be uploaded.");
      const backfill = data.sessionsFound
        ? ` ${data.sessionsUpdated} previous session column(s) filled${data.sessionsFailed ? `; ${data.sessionsFailed} need a retry` : ""}.`
        : "";
      setNotice({ kind: data.sessionsFailed ? "err" : "ok", text: `Workbook uploaded. Detected “${data.idHeader}” in sheet “${data.worksheet}” (${data.students} student IDs).${backfill}` });
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (error) {
      setNotice({ kind: "err", text: error instanceof Error ? error.message : "The workbook could not be uploaded." });
    } finally { setBusy(false); }
  }

  return (
    <article className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><p className="font-bold">{subject.name}</p><p className="text-xs text-ink-soft">{subject.code}</p></div>
        {workbook ? <span className="pill pill-ok">Workbook connected</span> : <span className="pill pill-mute">No workbook</span>}
      </div>
      {workbook && (
        <div className="rounded-lg bg-chalk p-3 text-sm">
          <p className="break-all font-semibold">{workbook.original_filename}</p>
          <p className="mt-1 text-xs text-ink-soft">Updated {new Date(workbook.updated_at).toLocaleString()} · session columns are numbered only from sessions you opened</p>
          <a className="mt-2 inline-flex font-semibold text-teal underline" href={`/api/lecturer/rosters/${subject.id}`}>Download my updated Excel workbook</a>
        </div>
      )}
      <form onSubmit={upload} className="space-y-2">
        <label className="block text-sm font-semibold" htmlFor={`roster-file-${subject.id}`}>{workbook ? "Replace base workbook" : "Upload university Excel file"}</label>
        <input
          ref={fileRef}
          id={`roster-file-${subject.id}`}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="input file:mr-3 file:rounded-md file:border-0 file:bg-chalk file:px-3 file:py-2 file:font-semibold"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <label className="block text-xs text-ink-soft" htmlFor={`roster-id-header-${subject.id}`}>ID column header (optional; leave blank to auto-detect)</label>
        <input
          id={`roster-id-header-${subject.id}`}
          className="input"
          value={idColumnHeader}
          onChange={(event) => setIdColumnHeader(event.target.value)}
          placeholder="e.g. Student ID or University ID"
          maxLength={80}
        />
        <button className="btn btn-primary w-full" disabled={busy || !file}>{busy ? "Uploading and updating sessions…" : workbook ? "Replace workbook and rebuild session columns" : "Upload workbook"}</button>
      </form>
      {notice && <p role={notice.kind === "err" ? "alert" : "status"} className={`rounded-lg p-3 text-sm ${notice.kind === "ok" ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"}`}>{notice.text}</p>}
      <p className="text-xs text-ink-soft">Only .xlsx files up to 10 MB are accepted. Replacing the base file rebuilds the session columns from sessions you previously opened.</p>
    </article>
  );
}
