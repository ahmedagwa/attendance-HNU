import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth";
import { requireSessionManager } from "@/lib/services/session-access";
import { ControlRoom } from "@/components/lecturer/control-room";

export const metadata = { title: "Control room" };

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePage("lecturer");
  const session = await requireSessionManager(actor, (await params).id).catch(() => null);
  if (!session) notFound();
  return <ControlRoom sessionId={session.id} subject={`${session.subject.name} (${session.subject.code})`} />;
}
