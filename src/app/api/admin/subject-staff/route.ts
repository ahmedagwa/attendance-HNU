import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route } from "@/lib/http";
import { guid } from "@/lib/ids";

const assignmentSchema = z.object({
  subjectId: guid,
  userId: guid,
  assignmentRole: z.enum(["professor", "teaching_assistant"]),
});
const removalSchema = z.object({ subjectId: guid, userId: guid });

export const POST = route(async (req) => {
  const actor = await requireActor("admin");
  const body = await readBody(req, assignmentSchema);
  const { data, error } = await adminClient().rpc("assign_subject_staff", {
    p_subject_id: body.subjectId,
    p_user_id: body.userId,
    p_assignment_role: body.assignmentRole,
    p_assigned_by: actor.id,
  });
  if (error) {
    if (error.code === "23505") throw new ApiError(409, "professor_exists", "This subject already has a professor or this assignment already exists.");
    throw new ApiError(422, "staff_assignment_failed", "Could not assign this teaching staff member.");
  }

  const outcome = String(data);
  if (outcome === "not_admin") throw new ApiError(403, "forbidden", "Administrator access is required.");
  if (outcome === "subject_not_found") throw new ApiError(404, "subject_not_found", "Subject not found.");
  if (outcome === "invalid_staff") throw new ApiError(422, "invalid_staff", "Choose an active lecturer account.");
  if (outcome === "professor_exists") throw new ApiError(409, "professor_exists", "This subject already has a professor. Remove or change that assignment first.");
  if (outcome === "role_conflict") throw new ApiError(409, "role_conflict", "This person is already assigned to the subject with a different role. Remove the existing assignment first.");
  if (outcome === "already_assigned") throw new ApiError(409, "already_assigned", "This person is already assigned to the subject.");
  if (outcome !== "assigned") throw new ApiError(422, "staff_assignment_failed", "The teaching assignment could not be saved.");

  return json({ ok: true, outcome });
});

export const DELETE = route(async (req) => {
  const actor = await requireActor("admin");
  const body = await readBody(req, removalSchema);
  const { data, error } = await adminClient().rpc("remove_subject_staff", {
    p_subject_id: body.subjectId,
    p_user_id: body.userId,
    p_removed_by: actor.id,
  });
  if (error) throw new ApiError(422, "staff_removal_failed", "Could not remove this teaching assignment.");
  const outcome = String(data);
  if (outcome === "not_admin") throw new ApiError(403, "forbidden", "Administrator access is required.");
  if (outcome === "not_found") throw new ApiError(404, "assignment_not_found", "That teaching assignment was not found.");
  if (outcome !== "removed") throw new ApiError(422, "staff_removal_failed", "The teaching assignment could not be removed.");
  return json({ ok: true, outcome });
});
