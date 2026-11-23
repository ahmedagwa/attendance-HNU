import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth";
import { requireSessionManager } from "@/lib/services/session-access";
import { adminClient } from "@/lib/supabase/admin";
import { ControlRoom } from "@/components/lecturer/control-room";

export const metadata = { title: "Control room" };

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePage("lecturer");
  const session = await requireSessionManager(actor, (await params).id).catch(() => null);
  if (!session) notFound();
  const isSessionStarter = session.started_by === actor.id;
  const { data: workbook } = isSessionStarter
    ? await adminClient().from("staff_roster_workbooks").select("id").eq("staff_user_id", actor.id).eq("subject_id", session.subject_id).maybeSingle()
    : { data: null };
  return (
    <ControlRoom
      sessionId={session.id}
      subjectId={session.subject_id}
      subject={`${session.subject.name} (${session.subject.code})`}
      groups={session.groups.map((group) => group.groupCode)}
      isSessionStarter={isSessionStarter}
      hasRosterWorkbook={Boolean(workbook)}
    />
  );
}
