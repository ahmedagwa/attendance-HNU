import { adminClient } from "@/lib/supabase/admin";
import { ApiForm } from "@/components/admin/api-form";

export const metadata = { title: "Academics" };
export const dynamic = "force-dynamic";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => ({
  value: String(index), label: day,
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
  const [groupsResult, hallsResult, subjectsResult, lecturersResult, staffResult] = await Promise.all([
    db.from("student_groups").select("id, group_code, name, academic_year").order("group_code"),
    db.from("halls").select("id, name, latitude, longitude, allowed_radius_meters, max_gps_accuracy_meters, is_active").order("name"),
    db.from("subjects").select("id, code, name, attendance_required_percent, is_active").order("code"),
    db.from("profiles").select("id, full_name, university_id").eq("role", "lecturer").eq("account_status", "active").order("full_name"),
    db.from("subject_staff").select("subject_id, user_id, assignment_role, assigned_at").order("assignment_role"),
  ]);

  const { data: groups, error: groupsError } = groupsResult;
  const { data: halls, error: hallsError } = hallsResult;
  const { data: subjects, error: subjectsError } = subjectsResult;
  const { data: lecturers, error: lecturersError } = lecturersResult;
  const { data: staffAssignments, error: staffError } = staffResult;

  for (const [label, error] of [
    ["groups", groupsError], ["halls", hallsError], ["subjects", subjectsError],
    ["lecturers", lecturersError], ["subject staff", staffError],
  ] as const) {
    if (error) console.error(`[admin/academics] Failed to load ${label}:`, error.message, error.code);
  }

  const lecturerById = new Map((lecturers ?? []).map((person) => [person.id, person]));
  const assignmentsBySubject = new Map<string, Array<{ userId: string; name: string; universityId: string; role: string }>>();
  for (const assignment of staffAssignments ?? []) {
    const person = lecturerById.get(assignment.user_id);
    const list = assignmentsBySubject.get(assignment.subject_id) ?? [];
    list.push({
      userId: assignment.user_id,
      name: person?.full_name ?? "Unknown lecturer",
      universityId: person?.university_id ?? "",
      role: assignment.assignment_role,
    });
    assignmentsBySubject.set(assignment.subject_id, list);
  }

  const opt = {
    groups: (groups ?? []).map((group) => ({ value: group.id, label: `${group.group_code} · ${group.name}` })),
    halls: (halls ?? []).map((hall) => ({ value: hall.id, label: hall.name })),
    subjects: (subjects ?? []).map((subject) => ({ value: subject.id, label: `${subject.code} · ${subject.name}` })),
    lecturers: (lecturers ?? []).map((person) => ({ value: person.id, label: `${person.full_name} (${person.university_id})` })),
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Academics</h1>

      {(groupsError || hallsError || subjectsError || lecturersError || staffError) && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          Some academic data could not be loaded. Check the server logs for the exact Supabase query error.
          {subjectsError && <p className="mt-1">Subjects: {subjectsError.message} ({subjectsError.code})</p>}
          {lecturersError && <p className="mt-1">Lecturers: {lecturersError.message} ({lecturersError.code})</p>}
          {staffError && <p className="mt-1">Teaching team: {staffError.message} ({staffError.code})</p>}
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

        <Card title="Subjects" note="Create each subject once, then assign its professor and one or more teaching assistants below.">
          <ApiForm endpoint="/api/admin/subjects" submit="Add subject" fields={[
            { name: "code", label: "Code" },
            { name: "name", label: "Name" },
            { name: "attendance_required_percent", label: "Attendance required (%)", type: "number", defaultValue: 75 },
          ]} />
          <ul className="space-y-2 text-sm text-ink-soft">
            {(subjects ?? []).map((subject) => {
              const team = assignmentsBySubject.get(subject.id) ?? [];
              return <li key={subject.id} className="rounded-lg border border-line p-3">
                <p className="font-semibold text-ink">{subject.code} · {subject.name} · {subject.attendance_required_percent}% required</p>
                {team.length ? team.map((member) => <p key={member.userId}>{member.role === "professor" ? "Professor" : "Teaching assistant"}: {member.name} {member.universityId && `(${member.universityId})`}</p>) : <p>No teaching staff assigned yet.</p>}
              </li>;
            })}
          </ul>
        </Card>

        <Card title="Teaching team" note="Assign one professor and as many teaching assistants as needed. Both roles can host attendance for the subject.">
          <ApiForm endpoint="/api/admin/subject-staff" submit="Assign teaching staff" successMessage="staff-assignment" fields={[
            { name: "subjectId", label: "Subject", type: "select", options: opt.subjects },
            { name: "userId", label: "Lecturer / teaching assistant", type: "select", options: opt.lecturers },
            { name: "assignmentRole", label: "Assignment", type: "select", defaultValue: "teaching_assistant", options: [
              { value: "professor", label: "Professor" },
              { value: "teaching_assistant", label: "Teaching assistant" },
            ] },
          ]} />
          <div className="border-t border-line pt-3">
            <p className="mb-2 text-sm font-semibold">Remove an assignment</p>
            <ApiForm endpoint="/api/admin/subject-staff" method="DELETE" submit="Remove assignment" successMessage="staff-removal" fields={[
              { name: "subjectId", label: "Subject", type: "select", options: opt.subjects },
              { name: "userId", label: "Lecturer / teaching assistant", type: "select", options: opt.lecturers },
            ]} />
          </div>
        </Card>

        <Card title="Enrol students" note="Paste university IDs separated by commas, spaces or new lines.">
          <ApiForm endpoint="/api/admin/enrollments" submit="Enrol students"
            fields={[
              { name: "subjectId", label: "Subject", type: "select", options: opt.subjects },
              { name: "groupId", label: "Group", type: "select", options: opt.groups },
              { name: "universityIds", label: "University IDs", type: "textarea", valueFormat: "string-list" },
            ]}
            successMessage="enrollment" />
          {opt.subjects.length === 0 && !subjectsError && <p className="text-sm text-amber-700">No subjects are available to enrol yet.</p>}
        </Card>

        <Card title="Timetable" note="Powers each student's Today screen. Timetable entries remain group-specific.">
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
