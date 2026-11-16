import { requireActor } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { getStudentDashboard } from "@/lib/services/student";

export const GET = route(async () => json(await getStudentDashboard(await requireActor("student"))));
