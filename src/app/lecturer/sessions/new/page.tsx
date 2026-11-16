import { requirePage } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { NewSessionForm } from "@/components/lecturer/new-session-form";

export const metadata = { title: "Start session" };
export const dynamic = "force-dynamic";

export default async function NewSession() {
  const actor = await requirePage("lecturer");
  const db = adminClient();
  const [{ data: subjects }, { data: halls }] = await Promise.all([
    db.from("subjects").select("id, code, name").eq("lecturer_id", actor.id).eq("is_active", true).order("code"),
    db.from("halls").select("id, name").eq("is_active", true).order("name"),
  ]);
  const ids = (subjects ?? []).map((s) => s.id);
  const { data: enrol } = ids.length ? await db.from("enrollments").select("subject_id, group:student_groups(id, group_code, name)").in("subject_id", ids) : { data: [] };
  const groups: Record<string, { id: string; label: string }[]> = {};
  for (const e of (enrol ?? []) as unknown as Array<{ subject_id: string; group: { id: string; group_code: string; name: string } }>) {
    const list = (groups[e.subject_id] ??= []);
    if (!list.some((g) => g.id === e.group.id)) list.push({ id: e.group.id, label: `${e.group.group_code} · ${e.group.name}` });
  }
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-bold">Start a session</h1>
      <NewSessionForm subjects={subjects ?? []} halls={halls ?? []} groups={groups} />
    </div>
  );
}
