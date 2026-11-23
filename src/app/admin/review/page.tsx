import { adminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/time";
import { FLAG_LABELS } from "@/lib/client/types";
import { FlagButtons } from "@/components/admin/row-actions";

export const metadata = { title: "Review & audit" };
export const dynamic = "force-dynamic";

type FlagRow = {
  id: string;
  flag_type: string;
  severity: string;
  created_at: string;
  student_id: string;
  session_id: string;
};

type ProfileRow = { id: string; full_name: string; university_id: string | null };
type SessionRow = { id: string; subject_id: string };
type SubjectRow = { id: string; code: string };
type AuditRow = {
  id: number;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: unknown;
  created_at: string;
};

function metadataText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const safeKeys = new Set([
    "reason", "binding", "decision", "flag_type", "device_type", "backed_up",
    "rows", "enrolled", "devices_revoked", "passkeys_revoked", "gps_rows_purged",
    "rate_limit_rows_purged", "retention_days", "kind", "credentialFound",
    "authenticatorDataLength", "flagsHex", "userPresent", "userVerified", "backupEligible",
  ]);
  return Object.entries(value as Record<string, unknown>)
    .filter(([key, item]) => safeKeys.has(key) && ["string", "number", "boolean"].includes(typeof item))
    .map(([key, item]) => `${key}: ${String(item)}`)
    .join(" · ");
}

export default async function Review() {
  const db = adminClient();
  const tz = serverEnv().ATTENDANCE_TIMEZONE;

  // Keep these queries flat. Embedding profiles from attendance_flags is ambiguous
  // because that table has both student_id and resolved_by foreign keys to profiles.
  const [flagsResult, logsResult] = await Promise.all([
    db.from("attendance_flags")
      .select("id, flag_type, severity, created_at, student_id, session_id")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(100),
    // actor_id intentionally has no FK so profile deletion cannot mutate the append-only log.
    db.from("audit_logs")
      .select("id, actor_id, action, entity_type, entity_id, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (flagsResult.error) console.error("[admin review] failed to load attendance flags:", flagsResult.error);
  if (logsResult.error) console.error("[admin review] failed to load audit logs:", logsResult.error);

  const flags = (flagsResult.data ?? []) as FlagRow[];
  const logs = (logsResult.data ?? []) as AuditRow[];

  const profileIds = Array.from(new Set([
    ...flags.map((flag) => flag.student_id),
    ...logs.map((log) => log.actor_id).filter((id): id is string => Boolean(id)),
  ]));
  const sessionIds = Array.from(new Set(flags.map((flag) => flag.session_id)));

  const [profilesResult, sessionsResult] = await Promise.all([
    profileIds.length
      ? db.from("profiles").select("id, full_name, university_id").in("id", profileIds)
      : Promise.resolve({ data: [], error: null }),
    sessionIds.length
      ? db.from("sessions").select("id, subject_id").in("id", sessionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (profilesResult.error) console.error("[admin review] failed to load related profiles:", profilesResult.error);
  if (sessionsResult.error) console.error("[admin review] failed to load related sessions:", sessionsResult.error);

  const profiles = new Map<string, ProfileRow>(
    ((profilesResult.data ?? []) as ProfileRow[]).map((profile) => [profile.id, profile]),
  );
  const sessions = new Map<string, SessionRow>(
    ((sessionsResult.data ?? []) as SessionRow[]).map((session) => [session.id, session]),
  );
  const subjectIds = Array.from(new Set(Array.from(sessions.values()).map((session) => session.subject_id)));
  const subjectsResult = subjectIds.length
    ? await db.from("subjects").select("id, code").in("id", subjectIds)
    : { data: [], error: null };

  if (subjectsResult.error) console.error("[admin review] failed to load related subjects:", subjectsResult.error);
  const subjects = new Map<string, SubjectRow>(
    ((subjectsResult.data ?? []) as SubjectRow[]).map((subject) => [subject.id, subject]),
  );

  const profilesUnavailable = Boolean(profilesResult.error);
  const sessionsUnavailable = Boolean(sessionsResult.error);
  const subjectsUnavailable = Boolean(subjectsResult.error);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-3 text-2xl font-bold">Review queue ({flagsResult.error ? "unavailable" : flags.length})</h1>
        {flagsResult.error ? (
          <p className="panel p-4 text-ink-soft">The review queue could not be loaded. Check the server logs.</p>
        ) : !flags.length ? (
          <p className="panel p-4 text-ink-soft">Nothing needs review.</p>
        ) : (
          <>
            {(profilesUnavailable || sessionsUnavailable || subjectsUnavailable) && (
              <p className="panel mb-2 p-3 text-sm text-ink-soft">Some student or subject details could not be loaded. Review items are still shown below.</p>
            )}
            <ul className="space-y-2">{flags.map((flag) => {
              const student = profiles.get(flag.student_id);
              const session = sessions.get(flag.session_id);
              const subject = session ? subjects.get(session.subject_id) : undefined;
              return (
                <li key={flag.id} className="panel flex flex-wrap items-center justify-between gap-3 p-3">
                  <div>
                    <p className="font-semibold">
                      {student?.full_name ?? "Unknown student"}{" "}
                      <span className="font-normal text-ink-soft">
                        {student?.university_id ?? "ID unavailable"} · {subject?.code ?? "Subject unavailable"}
                      </span>
                    </p>
                    <p className="text-sm text-ink-soft">
                      <span className={`pill mr-2 ${flag.severity === "high" ? "pill-bad" : flag.severity === "medium" ? "pill-warn" : "pill-mute"}`}>{flag.severity}</span>
                      {FLAG_LABELS[flag.flag_type] ?? flag.flag_type} · {formatDateTime(flag.created_at, tz)}
                    </p>
                  </div>
                  <FlagButtons id={flag.id} canApprove={flag.flag_type === "geo_uncertain"} />
                </li>
              );
            })}</ul>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-bold">Audit log (latest 100)</h2>
        {logsResult.error ? (
          <p className="panel p-4 text-ink-soft">Audit logs could not be loaded. Check the server logs.</p>
        ) : (
          <div className="panel overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="border-b border-line text-ink-soft"><tr>
              <th className="p-3">When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th>
            </tr></thead>
            <tbody>{logs.map((log) => (
              <tr key={log.id} className="border-b border-line last:border-0 align-top">
                <td className="whitespace-nowrap p-3">{formatDateTime(log.created_at, tz)}</td>
                <td title={log.actor_id ?? undefined}>{log.actor_id ? profiles.get(log.actor_id)?.full_name ?? "Deleted account" : "System"}</td>
                <td className="font-mono text-xs">{log.action}</td>
                <td className="text-ink-soft">{log.entity_type}</td>
                <td className="max-w-md whitespace-normal break-words text-ink-soft">{metadataText(log.metadata) || "—"}</td>
              </tr>
            ))}
              {!logs.length && <tr><td className="p-3 text-ink-soft" colSpan={5}>No audit entries found.</td></tr>}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
