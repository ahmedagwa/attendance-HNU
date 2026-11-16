import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { userClient } from "./supabase/server";
import { ApiError } from "./http";
import { hasActiveDeviceBinding } from "./device-installation";

export type Role = "student" | "lecturer" | "admin";
export type Actor = { id: string; role: Role; fullName: string; universityId: string };

export const homeFor = (role: Role) => `/${role}`;

/**
 * Identity comes ONLY from the verified Supabase session (JWT claims), never from the request body.
 * Role and account status are read server-side from `profiles`; clients cannot influence them.
 */
export const getActor = cache(async (): Promise<Actor | null> => {
  const supabase = await userClient();
  const { data } = await supabase.auth.getClaims();
  const id = data?.claims?.sub;
  if (!id) return null;
  const { data: p, error: profileError } = await supabase
    .from("profiles")
    .select("id, role, full_name, university_id, account_status")
    .eq("id", id)
    .maybeSingle();

  if (profileError) {
    console.error("[auth] Profile lookup failed:", {
      code: profileError.code,
      message: profileError.message,
    });
    return null;
  }

  if (!p || p.account_status !== "active") return null;
  return { id: p.id, role: p.role as Role, fullName: p.full_name, universityId: p.university_id };
});

export async function requireActor(...roles: Role[]): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ApiError(401, "unauthenticated", "Sign in to continue");
  if (roles.length && !roles.includes(actor.role)) throw new ApiError(403, "forbidden", "You do not have access to this action");
  if (roles.includes("student") && actor.role === "student" && !(await hasActiveDeviceBinding(actor.id))) {
    throw new ApiError(403, "device_not_linked", "This browser or installed app is not assigned to this student account. Sign in through the university login page or contact your administrator.");
  }
  return actor;
}

/** For Server Component pages/layouts. */
export async function requirePage(role: Role): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.role !== role) redirect(homeFor(actor.role));
  if (role === "student" && !(await hasActiveDeviceBinding(actor.id))) {
    redirect("/login?device=unlinked");
  }
  return actor;
}
