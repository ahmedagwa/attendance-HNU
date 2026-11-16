import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  buildQrPayload, currentBucket, decryptSecret, encryptSecret, generateSessionSecret, parseMasterKey, parseQrPayload, signBucket, verifyQrToken,
} from "@/lib/qr";

const SID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const secret = generateSessionSecret();
const period = 5;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % (period * 1000)); // exact bucket boundary
const verify = (payload: string, nowMs: number, over: Partial<Parameters<typeof verifyQrToken>[0]> = {}) =>
  verifyQrToken({ payload, secret, sessionId: SID, nowMs, periodSeconds: period, ...over });

describe("rotating HMAC QR", () => {
  const bucket = currentBucket(T0 + 1000, period);
  const token = buildQrPayload(secret, SID, bucket);

  it("has the documented shape v1.<session>.<bucket>.<sig>", () => {
    const p = parseQrPayload(token)!;
    expect(token.startsWith(`v1.${SID}.${bucket}.`)).toBe(true);
    expect(p).toMatchObject({ sessionId: SID, bucket });
    expect(p.signature).toBe(signBucket(secret, SID, bucket));
  });

  it("is REUSABLE by many students inside its window (never consumed)", () => {
    for (let student = 0; student < 200; student++) expect(verify(token, T0 + 2000).ok).toBe(true);
  });

  it("accepts the current bucket at any point of the period", () => {
    expect(verify(token, T0).ok).toBe(true);
    expect(verify(token, T0 + 4999).ok).toBe(true);
  });

  it("accepts the previous bucket only during the rollover grace (≈7 s max window)", () => {
    expect(verify(token, T0 + 5000 + 1500).ok).toBe(true);     // 1.5 s after rollover
    expect(verify(token, T0 + 5000 + 2000).ok).toBe(true);     // exactly at grace
    expect(verify(token, T0 + 5000 + 2001)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an old screenshot", () => {
    expect(verify(token, T0 + 60_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects tokens from the future", () => {
    const future = buildQrPayload(secret, SID, bucket + 5);
    expect(verify(future, T0 + 1000)).toEqual({ ok: false, reason: "future" });
  });

  it("rejects forged signatures, other sessions' secrets and other session ids", () => {
    const forged = buildQrPayload(randomBytes(32), SID, bucket);
    expect(verify(forged, T0 + 1000)).toEqual({ ok: false, reason: "bad_signature" });
    const other = "00000000-0000-4000-8000-000000000001";
    expect(verify(buildQrPayload(secret, other, bucket), T0 + 1000, { sessionId: SID })).toEqual({ ok: false, reason: "wrong_session" });
    expect(verify(token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), T0 + 1000).ok).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "garbage", "v2.a.b.c", `v1.${SID}.12.short`, `v1.${SID}.-1.${"A".repeat(43)}`, "x".repeat(500), `v1.${SID}.1.${"A".repeat(43)}.extra`]) {
      expect(verify(bad, T0)).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("tampering with the bucket invalidates the signature", () => {
    const p = parseQrPayload(token)!;
    const tampered = `v1.${SID}.${p.bucket + 1}.${p.signature}`;
    expect(verify(tampered, T0 + 6000)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("session secret encryption (AES-256-GCM)", () => {
  const master = parseMasterKey(randomBytes(32).toString("base64"));
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret(secret, master), b = encryptSecret(secret, master);
    expect(a).not.toEqual(b);
    expect(decryptSecret(a, master).equals(secret)).toBe(true);
  });
  it("fails closed with the wrong key or tampered ciphertext", () => {
    const enc = encryptSecret(secret, master);
    expect(() => decryptSecret(enc, parseMasterKey(randomBytes(32).toString("hex")))).toThrow();
    const parts = enc.split("."); parts[3] = Buffer.from(randomBytes(32)).toString("base64url");
    expect(() => decryptSecret(parts.join("."), master)).toThrow();
  });
  it("accepts base64 or hex master keys and rejects wrong lengths", () => {
    expect(parseMasterKey(randomBytes(32).toString("hex")).length).toBe(32);
    expect(() => parseMasterKey("too-short")).toThrow();
  });
});
