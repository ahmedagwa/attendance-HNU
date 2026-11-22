import { adminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/time";
import { FLAG_LABELS } from "@/lib/client/types";
import { FlagButtons } from "@/components/admin/row-actions";

export const metadata = { title: "Review & audit" };
export const dynamic = "force-dynamic";

export default async function Review() {
  const db = adminClient(), tz = serverEnv().ATTENDANCE_TIMEZONE;
  const [{ data: flags, error: flagsError }, { data: logs, error: logsError }] = await Promise.all([
    db.from("attendance_flags").select("id, flag_type, severity, created_at, student:profiles(full_name, university_id), session:sessions(subject:subjects(code))").eq("status", "open").order("created_at", { ascending: false }).limit(100),
    // Do not join profiles here: audit_logs.actor_id intentionally has no FK
    // so deleting a profile never updates or mutates the append-only audit log.
    db.from("audit_logs").select("id, actor_id, action, entity_type, entity_id, created_at").order("created_at", { ascending: false }).limit(100),
  ]);

  if (flagsError) console.error("[admin review] failed to load attendance flags:", flagsError);
  if (logsError) console.error("[admin review] failed to load audit logs:", logsError);

  type F = { id: string; flag_type: string; severity: string; created_at: string; student: { full_name: string; university_id: string }; session: { subject: { code: string } } };
  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-3 text-2xl font-bold">Review queue ({flags?.length ?? 0})</h1>
        {!flags?.length ? <p className="panel p-4 text-ink-soft">Nothing needs review.</p> : (
          <ul className="space-y-2">{(flags as unknown as F[]).map((f) => (
            <li key={f.id} className="panel flex flex-wrap items-center justify-between gap-3 p-3">
              <div><p className="font-semibold">{f.student.full_name} <span className="font-normal text-ink-soft">{f.student.university_id} · {f.session.subject.code}</span></p>
                <p className="text-sm text-ink-soft"><span className={`pill mr-2 ${f.severity === "high" ? "pill-bad" : f.severity === "medium" ? "pill-warn" : "pill-mute"}`}>{f.severity}</span>{FLAG_LABELS[f.flag_type] ?? f.flag_type} · {formatDateTime(f.created_at, tz)}</p></div>
              <FlagButtons id={f.id} canApprove={f.flag_type === "geo_uncertain"} />
            </li>))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-lg font-bold">Audit log (latest 100)</h2>
        {logsError ? (
          <p className="panel p-4 text-ink-soft">Audit logs could not be loaded. Check the server logs for details.</p>
        ) : (
          <div className="panel overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="border-b border-line text-ink-soft"><tr><th className="p-3">When</th><th>Who</th><th>Action</th><th>Entity</th></tr></thead>
            <tbody>{(logs ?? []).map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0">
                <td className="p-3 whitespace-nowrap">{formatDateTime(l.created_at, tz)}</td>
                <td className="font-mono text-xs">{l.actor_id ?? "System"}</td>
                <td className="font-mono text-xs">{l.action}</td>
                <td className="text-ink-soft">{l.entity_type}</td>
              </tr>))}
              {!logs?.length && <tr><td className="p-3 text-ink-soft" colSpan={4}>No audit entries found.</td></tr>}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
