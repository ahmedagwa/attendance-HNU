import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Rotating projector QR (report §6.1).
 *   bucket    = floor(server_unix_time / period)
 *   signature = HMAC_SHA256(session_secret, session_id + ":" + bucket)
 *   payload   = "v1." + session_id + "." + bucket + "." + base64url(signature)
 * The token is SHARED by every student in the room and is never "consumed".
 * Per-student single-use state lives in attendance_attempts, not here.
 */
export const QR_VERSION = "v1";
export const DEFAULT_GRACE_MS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMasterKey(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("master key must be exactly 32 bytes");
  return key;
}

export const generateSessionSecret = () => randomBytes(32);

/** AES-256-GCM. Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptSecret(secret: Buffer, masterKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(encoded: string, masterKey: Buffer): Buffer {
  const [v, iv, tag, ct] = encoded.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unsupported secret format");
  const d = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
}

export const currentBucket = (nowMs: number, periodSeconds: number) => Math.floor(nowMs / 1000 / periodSeconds);

export function signBucket(secret: Buffer, sessionId: string, bucket: number): string {
  return createHmac("sha256", secret).update(`${sessionId}:${bucket}`).digest("base64url");
}

export const buildQrPayload = (secret: Buffer, sessionId: string, bucket: number) =>
  `${QR_VERSION}.${sessionId}.${bucket}.${signBucket(secret, sessionId, bucket)}`;

export function parseQrPayload(payload: string): { sessionId: string; bucket: number; signature: string } | null {
  if (payload.length > 200) return null;
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== QR_VERSION) return null;
  const [, sessionId, bucketStr, signature] = parts;
  if (!UUID.test(sessionId) || !/^\d{1,12}$/.test(bucketStr) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  return { sessionId: sessionId.toLowerCase(), bucket: Number(bucketStr), signature };
}

export type QrVerdict =
  | { ok: true; bucket: number }
  | { ok: false; reason: "malformed" | "wrong_session" | "bad_signature" | "expired" | "future" };

/**
 * Accepts the current bucket, plus the immediately previous bucket only during a short rollover
 * grace. The session period is configurable (10 s by default), plus a 2 s rollover grace.
 */
export function verifyQrToken(o: {
  payload: string; secret: Buffer; sessionId: string; nowMs: number; periodSeconds: number; graceMs?: number;
}): QrVerdict {
  const parsed = parseQrPayload(o.payload);
  if (!parsed) return { ok: false, reason: "malformed" };
  if (parsed.sessionId !== o.sessionId.toLowerCase()) return { ok: false, reason: "wrong_session" };

  const expected = Buffer.from(signBucket(o.secret, o.sessionId, parsed.bucket));
  const given = Buffer.from(parsed.signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };

  const cur = currentBucket(o.nowMs, o.periodSeconds);
  if (parsed.bucket === cur) return { ok: true, bucket: cur };
  if (parsed.bucket > cur) return { ok: false, reason: "future" };
  const sinceRollover = o.nowMs - cur * o.periodSeconds * 1000;
  if (parsed.bucket === cur - 1 && sinceRollover <= (o.graceMs ?? DEFAULT_GRACE_MS)) return { ok: true, bucket: parsed.bucket };
  return { ok: false, reason: "expired" };
}
