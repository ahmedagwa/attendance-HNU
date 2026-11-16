import { expect, test } from "@playwright/test";

test("unauthenticated visitors are sent to sign-in", async ({ page }) => {
  await page.goto("/student");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
});

test("PWA manifest is installable", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.display).toBe("standalone");
  expect(m.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
});

test("API refuses unauthenticated callers with JSON 401", async ({ request }) => {
  const res = await request.post("/api/attendance/attempts", { data: { qrPayload: "x".repeat(20) } });
  expect(res.status()).toBe(401);
  expect((await res.json()).error).toBe("unauthenticated");
});

test("security headers are present", async ({ request }) => {
  const res = await request.get("/login");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
  expect(res.headers()["permissions-policy"]).toContain("camera=(self)");
});
