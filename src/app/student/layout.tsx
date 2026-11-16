import { requirePage } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const actor = await requirePage("student");
  return (
    <AppShell title="Attendance" name={`${actor.fullName} · ${actor.universityId}`}
      nav={[{ href: "/student", label: "Today" }, { href: "/student/history", label: "History" }, { href: "/student/onboarding", label: "Passkey & device" }]}>
      {children}
    </AppShell>
  );
}
