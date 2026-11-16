import { adminClient } from "@/lib/supabase/admin";
import { ApiForm } from "@/components/admin/api-form";

export const metadata = { title: "Academics" };
export const dynamic = "force-dynamic";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => ({
  value: String(index),
  label: day,
}));

function Card({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="panel space-y-3 p-5">
      <h2 className="font-bold">{title}</h2>
      {note && <p className="text-sm text-ink-soft">{note}</p>}
      {children}
    </section>
  );
}

export default async function Academics() {
  const db = adminClient();
  const [groupsResult, hallsResult, subjectsResult, lecturersResult] = await Promise.all([
    db.from("student_groups").select("id, group_code, name, academic_year").order("group_code"),
    db.from("halls").select("id, name, latitude, longitude, allowed_radius_meters, max_gps_accuracy_meters, is_active").order("name"),
    // Keep this query independent of the lecturer relationship. If a PostgREST
    // relationship/embed fails, it must not make the subject dropdown empty.
    db.from("subjects").select("id, code, name, lecturer_id, attendance_required_percent, is_active").order("code"),
    db.from("profiles").select("id, full_name, university_id").eq("role", "lecturer").eq("account_status", "active").order("full_name"),
  ]);

  const { data: groups, error: groupsError } = groupsResult;
  const { data: halls, error: hallsError } = hallsResult;
  const { data: subjects, error: subjectsError } = subjectsResult;
  const { data: lecturers, error: lecturersError } = lecturersResult;

  // Surface query failures instead of silently turning them into empty dropdowns.
  for (const [label, error] of [
    ["groups", groupsError],
    ["halls", hallsError],
    ["subjects", subjectsError],
    ["lecturers", lecturersError],
  ] as const) {
    if (error) console.error(`[admin/academics] Failed to load ${label}:`, error.message, error.code);
  }

  const lecturerNames = new Map((lecturers ?? []).map((lecturer) => [lecturer.id, lecturer.full_name]));

  const opt = {
    groups: (groups ?? []).map((group) => ({ value: group.id, label: `${group.group_code} · ${group.name}` })),
    halls: (halls ?? []).map((hall) => ({ value: hall.id, label: hall.name })),
    subjects: (subjects ?? []).map((subject) => ({ value: subject.id, label: `${subject.code} · ${subject.name}` })),
    lecturers: (lecturers ?? []).map((lecturer) => ({ value: lecturer.id, label: `${lecturer.full_name} (${lecturer.university_id})` })),
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Academics</h1>

      {(groupsError || hallsError || subjectsError || lecturersError) && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          Some academic data could not be loaded. Check the Next.js terminal for the exact Supabase query error.
          {subjectsError && <p className="mt-1">Subjects: {subjectsError.message} ({subjectsError.code})</p>}
          {lecturersError && <p className="mt-1">Lecturers: {lecturersError.message} ({lecturersError.code})</p>}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Student groups">
          <ApiForm endpoint="/api/admin/groups" submit="Add group" fields={[
            { name: "group_code", label: "Code", hint: "For example G1" },
            { name: "name", label: "Name" },
            { name: "academic_year", label: "Academic year", defaultValue: "2026/27" },
          ]} />
          <p className="text-sm text-ink-soft">{(groups ?? []).map((group) => group.group_code).join(", ") || "No groups yet."}</p>
        </Card>

        <Card title="Lecture halls" note="Coordinates stay on the server and are never sent to student phones. Measure real GPS accuracy in each hall before choosing a radius.">
          <ApiForm endpoint="/api/admin/halls" submit="Add hall" fields={[
            { name: "name", label: "Name" },
            { name: "latitude", label: "Latitude", type: "number", step: "any" },
            { name: "longitude", label: "Longitude", type: "number", step: "any" },
            { name: "allowed_radius_meters", label: "Allowed radius (m)", type: "number", defaultValue: 75 },
            { name: "max_gps_accuracy_meters", label: "Max GPS accuracy (m)", type: "number", defaultValue: 100 },
          ]} />
          <ul className="text-sm text-ink-soft">
            {(halls ?? []).map((hall) => <li key={hall.id}>{hall.name} · {hall.allowed_radius_meters} m radius, accuracy ≤ {hall.max_gps_accuracy_meters} m</li>)}
          </ul>
        </Card>

        <Card title="Subjects">
          <ApiForm endpoint="/api/admin/subjects" submit="Add subject" fields={[
            { name: "code", label: "Code" },
            { name: "name", label: "Name" },
            { name: "lecturer_id", label: "Lecturer", type: "select", options: opt.lecturers, optional: true },
            { name: "attendance_required_percent", label: "Attendance required (%)", type: "number", defaultValue: 75 },
          ]} />
          <ul className="text-sm text-ink-soft">
            {(subjects ?? []).map((subject) => (
              <li key={subject.id}>
                {subject.code} · {subject.name} · {subject.lecturer_id ? lecturerNames.get(subject.lecturer_id) ?? "lecturer not found" : "no lecturer"} · {subject.attendance_required_percent}% required
              </li>
            ))}
          </ul>
          {!subjectsError && (subjects ?? []).length === 0 && (
            <p className="text-sm text-ink-soft">No subjects found. Create a subject above, then refresh this page.</p>
          )}
        </Card>

        <Card title="Enrol students" note="Paste university IDs separated by commas, spaces or new lines.">
          <ApiForm endpoint="/api/admin/enrollments" submit="Enrol students"
            fields={[
              { name: "subjectId", label: "Subject", type: "select", options: opt.subjects },
              { name: "groupId", label: "Group", type: "select", options: opt.groups },
              { name: "universityIds", label: "University IDs", type: "textarea", valueFormat: "string-list" },
            ]}
            successMessage="enrollment" />
          {opt.subjects.length === 0 && !subjectsError && (
            <p className="text-sm text-amber-700">No subjects are available to enrol yet.</p>
          )}
        </Card>

        <Card title="Timetable" note="Powers each student's Today screen.">
          <ApiForm endpoint="/api/admin/schedules" submit="Add class" fields={[
            { name: "subject_id", label: "Subject", type: "select", options: opt.subjects },
            { name: "group_id", label: "Group", type: "select", options: opt.groups },
            { name: "hall_id", label: "Hall", type: "select", options: opt.halls },
            { name: "weekday", label: "Day", type: "select", options: DAYS, valueFormat: "number" },
            { name: "start_time", label: "Starts", type: "time" },
            { name: "end_time", label: "Ends", type: "time" },
          ]} />
        </Card>
      </div>
    </div>
  );
}
