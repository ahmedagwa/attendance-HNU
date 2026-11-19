import { requirePage } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { NewSessionForm } from "@/components/lecturer/new-session-form";

export const metadata = { title: "Start session" };
export const dynamic = "force-dynamic";

export default async function NewSession() {
  const actor = await requirePage("lecturer");
  const db = adminClient();
  const { data: assignments } = await db.from("subject_staff").select("subject_id").eq("user_id", actor.id);
  const subjectIds = [...new Set((assignments ?? []).map((row) => row.subject_id))];
  const [{ data: subjects }, { data: halls }] = await Promise.all([
    subjectIds.length
      ? db.from("subjects").select("id, code, name").in("id", subjectIds).eq("is_active", true).order("code")
      : Promise.resolve({ data: [] as Array<{ id: string; code: string; name: string }> }),
    db.from("halls").select("id, name").eq("is_active", true).order("name"),
  ]);
  const ids = (subjects ?? []).map((subject) => subject.id);
  const { data: enrolments } = ids.length
    ? await db.from("enrollments").select("subject_id, group:student_groups(id, group_code, name)").in("subject_id", ids)
    : { data: [] as Array<{ subject_id: string; group: unknown }> };

  const groups: Record<string, { id: string; label: string }[]> = {};
  for (const enrolment of (enrolments ?? []) as unknown as Array<{ subject_id: string; group: { id: string; group_code: string; name: string } }>) {
    const list = (groups[enrolment.subject_id] ??= []);
    if (!list.some((group) => group.id === enrolment.group.id)) {
      list.push({ id: enrolment.group.id, label: `${enrolment.group.group_code} · ${enrolment.group.name}` });
    }
  }
  for (const list of Object.values(groups)) list.sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-bold">Start a session</h1>
      <p className="text-sm text-ink-soft">Choose one group or combine both groups in one lecture session and one rotating QR code.</p>
      <NewSessionForm subjects={subjects ?? []} halls={halls ?? []} groups={groups} />
    </div>
  );
}
