import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { guid } from "@/lib/ids";
import { ENTITIES, enrollSchema, isEntity, unenrollSchema } from "@/lib/admin-entities";

type Ctx = { params: Promise<{ entity: string }> };

/** Administrator data management. `enrollments` is special-cased (bulk enrol by university ID). */
export const POST = route<Ctx>(async (req, { params }) => {
  const actor = await requireActor("admin");
  const entity = (await params).entity;
  const db = adminClient();

  if (entity === "enrollments") {
    const { subjectId, groupId, universityIds } = await readBody(req, enrollSchema);
    const { data: students } = await db.from("profiles").select("id, university_id").eq("role", "student").in("university_id", universityIds);
    const found = new Map((students ?? []).map((s) => [s.university_id, s.id]));
    const rows = [...found.values()].map((student_id) => ({ subject_id: subjectId, student_id, group_id: groupId }));
    if (rows.length) {
      const { error } = await db.from("enrollments").upsert(rows, { onConflict: "subject_id,student_id" });
      if (error) throw new ApiError(422, "enroll_failed", "Could not enrol students. Check the subject and group.");
    }
    await audit(actor.id, "enrollment.bulk", "subject", subjectId, { group_id: groupId, enrolled: rows.length });
    return json({ enrolled: rows.length, unknown: universityIds.filter((u) => !found.has(u)) });
  }

  if (!isEntity(entity)) throw new ApiError(404, "not_found");
  const cfg = ENTITIES[entity];
  const body = cfg.create.parse(await req.json().catch(() => ({})));
  const { data, error } = await db.from(cfg.table).insert(body as never).select("id").single();
  if (error) throw new ApiError(error.code === "23505" ? 409 : 422, "create_failed", error.code === "23505" ? "That already exists." : "Could not save. Check the values and try again.");
  await audit(actor.id, `${entity}.created`, cfg.table, data.id, body as Record<string, unknown>);
  return json({ id: data.id }, 201);
});

export const PATCH = route<Ctx>(async (req, { params }) => {
  const actor = await requireActor("admin");
  const entity = (await params).entity;
  if (!isEntity(entity)) throw new ApiError(404, "not_found");
  const cfg = ENTITIES[entity];
  const raw = (await req.json().catch(() => null)) as { id?: string } & Record<string, unknown> | null;
  const id = guid.parse(raw?.id);
  const { id: _omit, ...rest } = raw!; void _omit;
  const patch = (cfg.create as unknown as z.ZodObject).partial().parse(rest);
  if (!Object.keys(patch).length) throw new ApiError(400, "invalid_request", "Nothing to update");
  const { error } = await adminClient().from(cfg.table).update(patch).eq("id", id);
  if (error) throw new ApiError(422, "update_failed", "Could not save. Check the values and try again.");
  await audit(actor.id, `${entity}.updated`, cfg.table, id, patch as Record<string, unknown>);
  return json({ ok: true });
});

export const DELETE = route<Ctx>(async (req, { params }) => {
  const actor = await requireActor("admin");
  if ((await params).entity !== "enrollments") throw new ApiError(405, "method_not_allowed", "Deactivate instead of deleting.");
  const { subjectId, studentId } = await readBody(req, unenrollSchema);
  await adminClient().from("enrollments").delete().eq("subject_id", subjectId).eq("student_id", studentId);
  await audit(actor.id, "enrollment.removed", "subject", subjectId, { student_id: studentId });
  return json({ ok: true });
});
