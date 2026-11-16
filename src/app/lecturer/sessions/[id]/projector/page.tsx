import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth";
import { requireSessionManager } from "@/lib/services/session-access";
import { Projector } from "@/components/lecturer/projector";

export const metadata = { title: "Projector" };

export default async function ProjectorPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePage("lecturer");
  const session = await requireSessionManager(actor, (await params).id).catch(() => null);
  if (!session) notFound();
  return <Projector sessionId={session.id} subject={`${session.subject.name} (${session.subject.code})`} />;
}
