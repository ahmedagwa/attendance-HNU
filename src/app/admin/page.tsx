import Link from "next/link";
import { adminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const db = adminClient();
  const head = (table: string) => db.from(table).select("*", { head: true, count: "exact" });
  const n = async (q: PromiseLike<{ count: number | null }>) => (await q).count ?? 0;
  const [students, lecturers, subjects, halls, openFlags, activeSessions] = await Promise.all([
    n(head("profiles").eq("role", "student")), n(head("profiles").eq("role", "lecturer")), n(head("subjects")), n(head("halls")),
    n(head("attendance_flags").eq("status", "open")), n(head("sessions").in("status", ["active", "paused"])),
  ]);
  const tiles = [["Students", students, "/admin/people"], ["Lecturers", lecturers, "/admin/people"], ["Subjects", subjects, "/admin/academics"], ["Lecture halls", halls, "/admin/academics"], ["Sessions in progress", activeSessions, "/admin/review"], ["Open review items", openFlags, "/admin/review"]] as const;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {tiles.map(([label, n, href]) => <Link key={label} href={href} className="panel p-4 hover:border-teal"><p className="font-display text-3xl font-bold tabular-nums">{n}</p><p className="text-sm text-ink-soft">{label}</p></Link>)}
      </div>
    </div>
  );
}
