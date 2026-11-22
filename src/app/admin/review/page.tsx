import { adminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/time";
import { FLAG_LABELS } from "@/lib/client/types";
import { FlagButtons } from "@/components/admin/row-actions";

export const metadata = { title: "Review & audit" };
export const dynamic = "force-dynamic";

export default async function Review() {
  const db = adminClient(), tz = serverEnv().ATTENDANCE_TIMEZONE;
  const [flagsResult, logsResult] = await Promise.all([
    db.from("attendance_flags").select("id, flag_type, severity, created_at, student:profiles(full_name, university_id), session:sessions(subject:subjects(code))").eq("status", "open").order("created_at", { ascending: false }).limit(100),
    // audit_logs.actor_id intentionally has no FK so profile deletion cannot
    // mutate the append-only audit trail. Resolve names with a separate query.
    db.from("audit_logs").select("id, actor_id, action, entity_type, entity_id, created_at").order("created_at", { ascending: false }).limit(100),
  ]);

  if (flagsResult.error) console.error("[admin review] failed to load attendance flags:", flagsResult.error);
  if (logsResult.error) console.error("[admin review] failed to load audit logs:", logsResult.error);

  const flags = flagsResult.data ?? [];
  const logs = logsResult.data ?? [];
  const actorIds = Array.from(new Set(logs.map((log) => log.actor_id).filter((id): id is string => Boolean(id))));
  const actorNames = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: actors, error: actorsError } = await db.from("profiles").select("id, full_name").in("id", actorIds);
    if (actorsError) console.error("[admin review] failed to load audit actor names:", actorsError);
    for (const actor of actors ?? []) actorNames.set(actor.id, actor.full_name);
  }

  type F = { id: string; flag_type: string; severity: string; created_at: string; student: { full_name: string; university_id: string }; session: { subject: { code: string } } };
  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-3 text-2xl font-bold">Review queue ({flags.length})</h1>
        {flagsResult.error ? <p className="panel p-4 text-ink-soft">The review queue could not be loaded. Check the server logs.</p> : !flags.length ? <p className="panel p-4 text-ink-soft">Nothing needs review.</p> : (
          <ul className="space-y-2">{(flags as unknown as F[]).map((f) => (
            <li key={f.id} className="panel flex flex-wrap items-center justify-between gap-3 p-3">
              <div><p className="font-semibold">{f.student.full_name} <span className="font-normal text-ink-soft">{f.student.university_id} · {f.session.subject.code}</span></p>
                <p className="text-sm text-ink-soft"><span className={`pill mr-2 ${f.severity === "high" ? "pill-bad" : f.severity === "medium" ? "pill-warn" : "pill-mute"}`}>{f.severity}</span>{FLAG_LABELS[f.flag_type] ?? f.flag_type} · {formatDateTime(f.created_at, tz)}</p></div>
              <FlagButtons id={f.id} canApprove={f.flag_type === "geo_uncertain"} />
            </li>))}</ul>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-lg font-bold">Audit log (latest 100)</h2>
        {logsResult.error ? <p className="panel p-4 text-ink-soft">Audit logs could not be loaded. Check the server logs.</p> : (
          <div className="panel overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="border-b border-line text-ink-soft"><tr><th className="p-3">When</th><th>Who</th><th>Action</th><th>Entity</th></tr></thead>
            <tbody>{logs.map((log) => (
              <tr key={log.id} className="border-b border-line last:border-0">
                <td className="p-3 whitespace-nowrap">{formatDateTime(log.created_at, tz)}</td>
                <td title={log.actor_id ?? undefined}>{log.actor_id ? actorNames.get(log.actor_id) ?? "Deleted account" : "System"}</td>
                <td className="font-mono text-xs">{log.action}</td>
                <td className="text-ink-soft">{log.entity_type}</td>
              </tr>))}
              {!logs.length && <tr><td className="p-3 text-ink-soft" colSpan={4}>No audit entries found.</td></tr>}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
