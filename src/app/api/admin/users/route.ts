import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { ApiError, json, readBody, route } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { guid } from "@/lib/ids";

const userSchema = z.object({
  email: z.email(), fullName: z.string().trim().min(2).max(120), universityId: z.string().trim().min(3).max(40),
  role: z.enum(["student", "lecturer", "admin"]), password: z.string().min(10).max(72),
});

/** Admin-provisioned accounts only. Public sign-up must be disabled in Supabase Auth settings. */
export const POST = route(async (req) => {
  const actor = await requireActor("admin");
  await rateLimit(`admin-users:${actor.id}`, 60, 10);
  const { users } = await readBody(req, z.object({ users: z.array(userSchema).min(1).max(300) }));
  const db = adminClient();

  const results: Array<{ email: string; ok: boolean; error?: string }> = [];
  for (const u of users) {
    const { data: created, error } = await db.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
    if (error || !created.user) { results.push({ email: u.email, ok: false, error: error?.message ?? "could not create" }); continue; }
    const { error: pErr } = await db.from("profiles").insert({ id: created.user.id, university_id: u.universityId, full_name: u.fullName, role: u.role });
    if (pErr) {
      await db.auth.admin.deleteUser(created.user.id); // never leave an account without a profile
      results.push({ email: u.email, ok: false, error: pErr.code === "23505" ? "university ID already in use" : "could not save profile" });
      continue;
    }
    await audit(actor.id, "user.created", "user", created.user.id, { role: u.role, university_id: u.universityId });
    results.push({ email: u.email, ok: true });
  }
  return json({ created: results.filter((r) => r.ok).length, results }, 201);
});

const patchSchema = z.object({ id: guid, accountStatus: z.enum(["active", "suspended"]).optional(), role: z.enum(["student", "lecturer", "admin"]).optional() });

export const PATCH = route(async (req) => {
  const actor = await requireActor("admin");
  const body = await readBody(req, patchSchema);
  if (body.id === actor.id) throw new ApiError(409, "self_change", "You can't change your own role or status.");
  const patch: Record<string, string> = {};
  if (body.accountStatus) patch.account_status = body.accountStatus;
  if (body.role) patch.role = body.role;
  if (!Object.keys(patch).length) throw new ApiError(400, "invalid_request", "Nothing to update");
  const { error } = await adminClient().from("profiles").update(patch).eq("id", body.id);
  if (error) throw new ApiError(422, "update_failed", "Could not update that account.");
  await audit(actor.id, "user.updated", "user", body.id, patch);
  return json({ ok: true });
});
