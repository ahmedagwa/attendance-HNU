import Link from "next/link";
import { requirePage } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/time";
import { RosterWorkbooks } from "@/components/lecturer/roster-workbooks";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

type Summary = { enrolled: number; present: number; late: number; review: number; absent: number; open_flags: number };

export default async function LecturerDashboard() {
  const actor = await requirePage("lecturer");
  const db = adminClient();
  const tz = serverEnv().ATTENDANCE_TIMEZONE;

  const { data: assignments } = await db.from("subject_staff").select("subject_id").eq("user_id", actor.id);
  const subjectIds = [...new Set((assignments ?? []).map((row) => row.subject_id))];
  const { data: subjects } = subjectIds.length
    ? await db.from("subjects").select("id, code, name").in("id", subjectIds).eq("is_active", true).order("code")
    : { data: [] as Array<{ id: string; code: string; name: string }> };
  const ids = (subjects ?? []).map((s) => s.id);
  const [{ data: enrol }, { data: sessions }, { data: workbookRows }] = await Promise.all([
    ids.length ? db.from("enrollments").select("subject_id, group:student_groups(group_code)").in("subject_id", ids) : Promise.resolve({ data: [] as never[] }),
    ids.length ? db.from("sessions").select("id, status, started_at, subject_id, subject:subjects(code, name), hall:halls(name)").in("subject_id", ids).eq("started_by", actor.id).order("started_at", { ascending: false }).limit(12) : Promise.resolve({ data: [] as never[] }),
    ids.length ? db.from("staff_roster_workbooks").select("id, subject_id, original_filename, updated_at").eq("staff_user_id", actor.id).in("subject_id", ids) : Promise.resolve({ data: [] as never[] }),
  ]);
  const sessionIds = (sessions ?? []).map((session) => session.id);
  const { data: sessionGroupRows } = sessionIds.length
    ? await db.from("session_groups").select("session_id, group:student_groups(group_code)").in("session_id", sessionIds)
    : { data: [] as Array<{ session_id: string; group: unknown }> };
  const sessionGroups = new Map<string, string[]>();
  for (const row of (sessionGroupRows ?? []) as unknown as Array<{ session_id: string; group: { group_code: string } }>) {
    const list = sessionGroups.get(row.session_id) ?? [];
    list.push(row.group.group_code);
    sessionGroups.set(row.session_id, list);
  }

  const counts = new Map<string, Map<string, number>>();
  for (const e of (enrol ?? []) as unknown as Array<{ subject_id: string; group: { group_code: string } }>) {
    const m = counts.get(e.subject_id) ?? new Map(); m.set(e.group.group_code, (m.get(e.group.group_code) ?? 0) + 1); counts.set(e.subject_id, m);
  }
  const rows = (sessions ?? []).map((session) => ({
    ...session,
    subject: session.subject as unknown as { code: string; name: string },
    hall: session.hall as unknown as { name: string },
    groupLabels: sessionGroups.get(session.id) ?? [],
  }));
  const summaries = await Promise.all(rows.map(async (s) => { const { data } = await db.rpc("session_summary", { p_session_id: s.id }); return (Array.isArray(data) ? data[0] : data) as Summary; }));
  const open = rows.filter((s) => s.status !== "closed");

  return (
    <div className="space-y-8">
      {open.length > 0 && (
        <section className="space-y-3">
          {open.map((s) => (
            <div key={s.id} className="panel flex flex-wrap items-center justify-between gap-3 border-teal p-4">
              <div><p className="text-sm text-ink-soft">{s.status === "paused" ? "Paused" : "In progress"} · {s.hall.name}</p><p className="text-lg font-bold">{s.subject.name} <span className="font-normal text-ink-soft">· {s.groupLabels.join(", ")}</span></p></div>
              <div className="flex gap-2"><Link className="btn btn-primary" href={`/lecturer/sessions/${s.id}/projector`}>Open projector</Link><Link className="btn btn-quiet" href={`/lecturer/sessions/${s.id}`}>Control room</Link></div>
            </div>
          ))}
        </section>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-bold">Your subjects</h2><Link href="/lecturer/sessions/new" className="btn btn-primary">Start a session</Link></div>
        {(subjects ?? []).length === 0 ? <p className="panel p-4 text-ink-soft">No subjects are assigned to you yet. Ask your administrator.</p> : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {(subjects ?? []).map((s) => (
              <li key={s.id} className="panel p-4"><p className="font-bold">{s.name}</p><p className="text-sm text-ink-soft">{s.code}</p>
                <p className="mt-2 text-sm">{[...(counts.get(s.id) ?? new Map()).entries()].map(([g, n]) => `${g}: ${n} students`).join(" · ") || "No students enrolled"}</p></li>
            ))}
          </ul>
        )}
      </section>

      <RosterWorkbooks subjects={(subjects ?? []).map((s) => ({ id: s.id, code: s.code, name: s.name }))} workbooks={(workbookRows ?? []) as Array<{ id: string; subject_id: string; original_filename: string; updated_at: string }>} />

      <section>
        <h2 className="mb-3 text-lg font-bold">Recent sessions</h2>
        {rows.length === 0 ? <p className="panel p-4 text-ink-soft">Only sessions you opened appear here. Sessions opened by other teaching staff remain private to them.</p> : (
          <div className="panel overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-ink-soft"><tr><th className="p-3">When</th><th>Subject</th><th>Present</th><th>Late</th><th>Review</th><th>Absent</th><th></th></tr></thead>
              <tbody>{rows.map((s, i) => (
                <tr key={s.id} className="border-b border-line last:border-0">
                  <td className="p-3 whitespace-nowrap">{formatDateTime(s.started_at, tz)}</td><td>{s.subject.code}{s.groupLabels.length ? ` · ${s.groupLabels.join(", ")}` : ""}</td>
                  <td>{summaries[i]?.present}</td><td>{summaries[i]?.late}</td><td>{summaries[i]?.review}</td><td>{summaries[i]?.absent}</td>
                  <td className="p-3 text-right"><Link className="font-semibold text-teal underline" href={`/lecturer/sessions/${s.id}`}>Open</Link></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
