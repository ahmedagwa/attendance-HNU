/* Demo data for a staging project:  node --env-file=.env.local scripts/seed.ts
 * Creates 1 admin, 2 lecturers, 12 students (two groups), 2 subjects, 1 hall and a timetable.
 * NEVER run against production: it creates accounts with a known demo password. */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed in production");
const db = createClient(url, key, { auth: { persistSession: false } });
const PASSWORD = "Demo-Pass-2026!";

async function user(email: string, fullName: string, universityId: string, role: string) {
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  let id = data?.user?.id;
  if (error) { const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 }); id = list.users.find((u) => u.email === email)?.id; }
  if (!id) throw new Error(`user ${email}: ${error?.message}`);
  await db.from("profiles").upsert({ id, university_id: universityId, full_name: fullName, role });
  return id;
}
const must = <T>(r: { data: T | null; error: { message: string } | null }) => { if (r.error || !r.data) throw new Error(r.error?.message); return r.data; };

await user("admin@demo.edu", "Demo Admin", "A-0001", "admin");
const l1 = await user("lecturer1@demo.edu", "Dr. Mona Hassan", "L-0001", "lecturer");
const l2 = await user("lecturer2@demo.edu", "Dr. Karim Saleh", "L-0002", "lecturer");
const students: { id: string; n: number }[] = [];
for (let n = 1; n <= 12; n++) students.push({ id: await user(`student${n}@demo.edu`, `Student ${n}`, `2026${String(n).padStart(4, "0")}`, "student"), n });

const g1 = must(await db.from("student_groups").upsert({ group_code: "G1", name: "Group 1", academic_year: "2026/27" }, { onConflict: "group_code" }).select("id").single()).id;
const g2 = must(await db.from("student_groups").upsert({ group_code: "G2", name: "Group 2", academic_year: "2026/27" }, { onConflict: "group_code" }).select("id").single()).id;
// Replace with real surveyed coordinates before any pilot. These are placeholders in Helwan, Cairo.
const hall = must(await db.from("halls").upsert({ name: "Hall A (demo)", latitude: 29.8500, longitude: 31.3342, allowed_radius_meters: 75, max_gps_accuracy_meters: 100 }, { onConflict: "name" }).select("id").single()).id;
const s1 = must(await db.from("subjects").upsert({ code: "NET201", name: "Computer Networks", lecturer_id: l1, attendance_required_percent: 75 }, { onConflict: "code" }).select("id").single()).id;
const s2 = must(await db.from("subjects").upsert({ code: "DB202", name: "Databases", lecturer_id: l2, attendance_required_percent: 75 }, { onConflict: "code" }).select("id").single()).id;
for (const s of students) for (const sub of [s1, s2]) await db.from("enrollments").upsert({ subject_id: sub, student_id: s.id, group_id: s.n <= 6 ? g1 : g2 }, { onConflict: "subject_id,student_id" });
for (const [sub, grp, day] of [[s1, g1, 0], [s1, g2, 1], [s2, g1, 2], [s2, g2, 3]] as const)
  await db.from("class_schedules").insert({ subject_id: sub, group_id: grp, hall_id: hall, weekday: day, start_time: "10:00", end_time: "11:30" });
console.log(`Seeded. Sign in with e.g. lecturer1@demo.edu / ${PASSWORD}`);
