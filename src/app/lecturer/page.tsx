import Link from "next/link";
import { requirePage } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/time";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

type Summary = { enrolled: number; present: number; late: number; review: number; absent: number; open_flags: number };

export default async function LecturerDashboard() {
  const actor = await requirePage("lecturer");
  const db = adminClient();
  const tz = serverEnv().ATTENDANCE_TIMEZONE;

  const { data: subjects } = await db.from("subjects").select("id, code, name").eq("lecturer_id", actor.id).eq("is_active", true).order("code");
  const ids = (subjects ?? []).map((s) => s.id);
  const [{ data: enrol }, { data: sessions }] = await Promise.all([
    ids.length ? db.from("enrollments").select("subject_id, group:student_groups(group_code)").in("subject_id", ids) : Promise.resolve({ data: [] as never[] }),
    ids.length ? db.from("sessions").select("id, status, started_at, group_id, subject:subjects(code, name), group:student_groups(group_code), hall:halls(name)").in("subject_id", ids).order("started_at", { ascending: false }).limit(12) : Promise.resolve({ data: [] as never[] }),
  ]);

  const counts = new Map<string, Map<string, number>>();
  for (const e of (enrol ?? []) as unknown as Array<{ subject_id: string; group: { group_code: string } }>) {
    const m = counts.get(e.subject_id) ?? new Map(); m.set(e.group.group_code, (m.get(e.group.group_code) ?? 0) + 1); counts.set(e.subject_id, m);
  }
  const rows = (sessions ?? []) as unknown as Array<{ id: string; status: string; started_at: string; subject: { code: string; name: string }; group: { group_code: string } | null; hall: { name: string } }>;
  const summaries = await Promise.all(rows.map(async (s) => { const { data } = await db.rpc("session_summary", { p_session_id: s.id }); return (Array.isArray(data) ? data[0] : data) as Summary; }));
  const open = rows.filter((s) => s.status !== "closed");

  return (
    <div className="space-y-8">
      {open.length > 0 && (
        <section className="space-y-3">
          {open.map((s) => (
            <div key={s.id} className="panel flex flex-wrap items-center justify-between gap-3 border-teal p-4">
              <div><p className="text-sm text-ink-soft">{s.status === "paused" ? "Paused" : "In progress"} · {s.hall.name}</p><p className="text-lg font-bold">{s.subject.name} {s.group && <span className="font-normal text-ink-soft">· {s.group.group_code}</span>}</p></div>
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

      <section>
        <h2 className="mb-3 text-lg font-bold">Recent sessions</h2>
        {rows.length === 0 ? <p className="panel p-4 text-ink-soft">Sessions you run will appear here.</p> : (
          <div className="panel overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-ink-soft"><tr><th className="p-3">When</th><th>Subject</th><th>Present</th><th>Late</th><th>Review</th><th>Absent</th><th></th></tr></thead>
              <tbody>{rows.map((s, i) => (
                <tr key={s.id} className="border-b border-line last:border-0">
                  <td className="p-3 whitespace-nowrap">{formatDateTime(s.started_at, tz)}</td><td>{s.subject.code}{s.group ? ` · ${s.group.group_code}` : ""}</td>
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
