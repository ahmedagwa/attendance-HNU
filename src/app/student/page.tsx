import Link from "next/link";
import { requirePage } from "@/lib/auth";
import { getStudentDashboard, type SubjectAttendance } from "@/lib/services/student";
import { formatTime } from "@/lib/time";
import { statusPill } from "@/components/app-shell";
import { ReverifyPrompt } from "@/components/student/reverify-prompt";

export const metadata = { title: "Today" };
export const dynamic = "force-dynamic";

function Ledger({ s }: { s: SubjectAttendance }) {
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate font-semibold">{s.name} <span className="font-normal text-ink-soft">{s.code}</span></p>
        <p className={`shrink-0 font-display text-lg font-bold ${s.belowLimit ? "text-bad" : ""}`}>{s.percent}%</p>
      </div>
      <div className="relative mt-2 h-2.5 rounded-full bg-track" role="img" aria-label={`${s.percent}% overall attendance, ${s.requiredPercent}% required`}>
        <div className={`h-full rounded-full ${s.belowLimit ? "bg-bad" : "bg-teal"}`} style={{ width: `${Math.min(s.percent, 100)}%` }} />
        <div className="absolute -top-1 h-4.5 w-0.5 bg-ink" style={{ left: `${s.requiredPercent}%` }} />
      </div>
      <p className="mt-1.5 text-sm text-ink-soft">
        {s.held === 0 ? "No sessions held yet" : `${s.attended} of ${s.held} sessions overall · ${s.requiredPercent}% required`}
        {s.belowLimit && s.held > 0 && <span className="ml-2 font-semibold text-bad">Below the absence limit</span>}
      </p>

      {s.staffAttendance.length > 0 && (
        <div className="mt-4 space-y-3 border-t border-line pt-3">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-soft">Attendance by teaching staff</p>
          {s.staffAttendance.map((staff) => {
            const roleLabel = staff.role === "professor" ? "Professor" : "Teaching assistant";
            const percent = staff.percent;
            return (
              <div key={staff.staffId} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 text-sm font-semibold">{roleLabel}: <span className="font-normal">{staff.fullName}</span></p>
                  <p className={`shrink-0 font-display text-sm font-bold ${staff.belowLimit ? "text-bad" : ""}`}>{percent === null ? "—" : `${percent}%`}</p>
                </div>
                <div
                  className="relative h-2 rounded-full bg-track"
                  role="img"
                  aria-label={percent === null ? `${roleLabel} ${staff.fullName}: no sessions held yet` : `${roleLabel} ${staff.fullName}: ${percent}% attendance across ${staff.held} sessions; ${s.requiredPercent}% required`}
                >
                  {percent !== null && <div className={`h-full rounded-full ${staff.belowLimit ? "bg-bad" : "bg-teal"}`} style={{ width: `${Math.min(percent, 100)}%` }} />}
                  <div className="absolute -top-1 h-4 w-0.5 bg-ink" style={{ left: `${s.requiredPercent}%` }} />
                </div>
                <p className="text-xs text-ink-soft">
                  {staff.held === 0 ? "No sessions opened by this staff member yet" : `${staff.attended} attended out of ${staff.held} sessions · ${s.requiredPercent}% required`}
                  {staff.belowLimit && <span className="ml-2 font-semibold text-bad">Below the absence limit</span>}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

export default async function StudentHome() {
  const actor = await requirePage("student");
  const d = await getStudentDashboard(actor);
  const ready = d.hasPasskey && d.hasDevice;

  return (
    <div className="space-y-6">
      {!ready && (
        <section className="panel border-amber p-4">
          <h2 className="font-bold">Finish setting up before your first check-in</h2>
          <p className="mt-1 text-sm text-ink-soft">You need a passkey and this device linked to your account.</p>
          <Link href="/student/onboarding" className="btn btn-primary mt-3">Set up passkey</Link>
        </section>
      )}

      <ReverifyPrompt />

      {d.openSessions.length > 0 && (
        <section aria-label="Open sessions" className="space-y-3">
          {d.openSessions.map((s) => (
            <div key={s.id} className="panel p-4">
              <p className="text-sm text-ink-soft">Open now · started {formatTime(s.startedAt)} · {s.hallName}{s.groupCode ? ` · ${s.groupCode}` : ""}</p>
              <h2 className="mt-0.5 text-xl font-bold">{s.subjectName}</h2>
              {s.checkedIn ? (
                <p className="mt-3"><span className={statusPill[s.checkedIn]}>{s.checkedIn === "review" ? "Waiting for lecturer review" : `You're checked in (${s.checkedIn})`}</span></p>
              ) : (
                <Link href="/student/scan" className="btn btn-primary mt-3 w-full text-lg" aria-disabled={!ready}>Scan attendance</Link>
              )}
            </div>
          ))}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-bold">Today&apos;s classes</h2>
        {d.timetable.length === 0 ? <p className="panel p-4 text-ink-soft">No classes scheduled today.</p> : (
          <ul className="panel divide-y divide-line">
            {d.timetable.map((c) => (
              <li key={c.id} className="flex items-center gap-4 p-4">
                <p className="w-24 shrink-0 font-display font-bold tabular-nums">{c.start}–{c.end}</p>
                <div className="min-w-0"><p className="truncate font-semibold">{c.subjectName}</p><p className="truncate text-sm text-ink-soft">{c.hallName} · {c.groupName}</p></div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-bold">Your attendance</h2>
        {d.subjects.length === 0 ? <p className="panel p-4 text-ink-soft">You aren&apos;t enrolled in any subjects yet. Ask your administrator.</p> : (
          <ul className="panel divide-y divide-line px-4">{d.subjects.map((s) => <Ledger key={s.subjectId} s={s} />)}</ul>
        )}
      </section>
    </div>
  );
}
