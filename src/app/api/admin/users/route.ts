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


const deleteSchema = z.object({ id: guid });

/** Permanently remove an account from Supabase Auth and its cascading profile data. */
export const DELETE = route(async (req) => {
  const actor = await requireActor("admin");
  await rateLimit(`admin-users-delete:${actor.id}`, 60, 5);
  const { id } = await readBody(req, deleteSchema);
  if (id === actor.id) throw new ApiError(409, "self_delete", "You can't delete the account you're currently using.");

  const db = adminClient();
  const { data: target, error: targetError } = await db
    .from("profiles")
    .select("id, university_id, full_name, role")
    .eq("id", id)
    .maybeSingle();
  if (targetError) throw new ApiError(500, "lookup_failed", "Could not verify that account.");
  if (!target) throw new ApiError(404, "account_not_found", "That account no longer exists.");

  // Never allow the institution to be left without an administrator.
  if (target.role === "admin") {
    const { count, error } = await db.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
    if (error) throw new ApiError(500, "admin_check_failed", "Could not verify administrator accounts.");
    if ((count ?? 0) <= 1) throw new ApiError(409, "last_admin", "The last administrator account cannot be deleted.");
  }

  // Session history is retained. The account-deletion migration changes the
  // creator/issuer foreign keys to ON DELETE SET NULL, preserving records while
  // removing the deleted person's identity link.

  const { error: deleteError } = await db.auth.admin.deleteUser(id);
  if (deleteError) throw new ApiError(422, "delete_failed", "The account could not be deleted. Check database constraints and linked records.");

  await audit(actor.id, "user.deleted", "user", id, {
    university_id: target.university_id,
    full_name: target.full_name,
    role: target.role,
  });
  return json({ ok: true });
});
