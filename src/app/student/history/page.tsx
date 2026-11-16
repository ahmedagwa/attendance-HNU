import { requirePage } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/time";
import { statusPill } from "@/components/app-shell";

export const metadata = { title: "History" };
export const dynamic = "force-dynamic";

export default async function History() {
  const actor = await requirePage("student");
  const { data } = await adminClient().from("attendance_records")
    .select("id, status, source, checked_in_at, session:sessions(subject:subjects(code, name))")
    .eq("student_id", actor.id).order("checked_in_at", { ascending: false }).limit(100);
  const tz = serverEnv().ATTENDANCE_TIMEZONE;
  const rows = (data ?? []) as unknown as Array<{ id: string; status: string; source: string; checked_in_at: string; session: { subject: { code: string; name: string } } }>;

  return (
    <div>
      <h1 className="mb-3 text-2xl font-bold">History</h1>
      {rows.length === 0 ? <p className="panel p-4 text-ink-soft">No check-ins yet.</p> : (
        <ul className="panel divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0"><p className="truncate font-semibold">{r.session.subject.name}</p><p className="text-sm text-ink-soft">{formatDateTime(r.checked_in_at, tz)}</p></div>
              <div className="flex shrink-0 gap-1.5">
                {r.source === "manual" && <span className="pill pill-mute">Manual</span>}
                <span className={statusPill[r.status]}>{r.status === "review" ? "In review" : r.status}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
