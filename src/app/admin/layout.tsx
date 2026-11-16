import { requirePage } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await requirePage("admin");
  return <AppShell title="Administration" name={actor.fullName} wide nav={[{ href: "/admin", label: "Overview" }, { href: "/admin/people", label: "People" }, { href: "/admin/academics", label: "Academics" }, { href: "/admin/review", label: "Review & audit" }]}>{children}</AppShell>;
}
