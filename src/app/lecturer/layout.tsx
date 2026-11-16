import { requirePage } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

export default async function LecturerLayout({ children }: { children: React.ReactNode }) {
  const actor = await requirePage("lecturer");
  return <AppShell title="Lecturer" name={actor.fullName} wide nav={[{ href: "/lecturer", label: "Dashboard" }, { href: "/lecturer/sessions/new", label: "Start session" }]}>{children}</AppShell>;
}
