// Fails the Vercel build early (with a clear message) instead of shipping a silently broken deployment.
// Runs only on Vercel (VERCEL=1); local builds and CI without secrets are unaffected.
if (!process.env.VERCEL) process.exit(0);

const env = process.env, errors = [], warnings = [];
const isProd = env.VERCEL_ENV === "production";
const need = (k) => { if (!env[k]) errors.push(`${k} is not set`); return env[k]; };

const supa = need("NEXT_PUBLIC_SUPABASE_URL"); need("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"); need("SUPABASE_SECRET_KEY");
const app = need("NEXT_PUBLIC_APP_URL"), rp = need("WEBAUTHN_RP_ID"), origin = need("WEBAUTHN_ORIGIN"), qr = need("QR_MASTER_KEY"), cron = need("CRON_SECRET");

if (supa && /localhost|127\.0\.0\.1/.test(supa)) errors.push("NEXT_PUBLIC_SUPABASE_URL points at localhost");
if (qr) {
  const len = /^[0-9a-f]{64}$/i.test(qr) ? 32 : Buffer.from(qr, "base64").length;
  if (len !== 32) errors.push(`QR_MASTER_KEY must be 32 bytes (got ${len}). Generate one with: openssl rand -base64 32`);
}
if (cron && cron.length < 16) errors.push("CRON_SECRET must be at least 16 characters");
if (env.INSTALLATION_HASH_KEY) {
  const len = /^[0-9a-f]{64}$/i.test(env.INSTALLATION_HASH_KEY) ? 32 : Buffer.from(env.INSTALLATION_HASH_KEY, "base64").length;
  if (len !== 32) errors.push(`INSTALLATION_HASH_KEY must be 32 bytes (got ${len}). Generate one with: openssl rand -base64 32`);
}
if (env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY && env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY === env.SUPABASE_SECRET_KEY) errors.push("SUPABASE_SECRET_KEY must not equal the publishable key");

for (const [k, v] of [["NEXT_PUBLIC_APP_URL", app], ["WEBAUTHN_ORIGIN", origin]]) {
  if (v && !v.startsWith("https://")) (isProd ? errors : warnings).push(`${k} should be https:// (passkeys, camera and GPS require a secure context)`);
}
if (rp && origin) {
  let host = ""; try { host = new URL(origin).hostname; } catch { errors.push("WEBAUTHN_ORIGIN is not a valid URL"); }
  if (host && host !== rp && !host.endsWith("." + rp)) (isProd ? errors : warnings).push(`WEBAUTHN_RP_ID (${rp}) must equal or be a parent domain of the WEBAUTHN_ORIGIN host (${host}); passkeys will fail otherwise`);
}
if (app && origin && app.replace(/\/$/, "") !== origin.replace(/\/$/, "")) warnings.push("NEXT_PUBLIC_APP_URL and WEBAUTHN_ORIGIN differ");
if (!isProd) warnings.push(`VERCEL_ENV=${env.VERCEL_ENV}: passkeys are bound to ${rp || "WEBAUTHN_RP_ID"}; preview URLs on other hostnames cannot use them`);

warnings.forEach((w) => console.warn("⚠ env:", w));
if (errors.length) { console.error("\n✖ Environment check failed:\n" + errors.map((e) => "  - " + e).join("\n") + "\n\nSet these in Vercel → Project → Settings → Environment Variables, then redeploy.\n"); process.exit(1); }
console.log("✓ Environment check passed");
