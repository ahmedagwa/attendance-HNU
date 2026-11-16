import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";

/** A tiny software authenticator so the exact verification call used by /api/attendance/verify is exercised. */
const RP_ID = "attendance.example.edu", ORIGIN = "https://attendance.example.edu";
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const x = Buffer.from(jwk.x!, "base64url"), y = Buffer.from(jwk.y!, "base64url");
// COSE_Key {1:2 (EC2), 3:-7 (ES256), -1:1 (P-256), -2:x, -3:y}
const cosePublicKey = new Uint8Array(Buffer.concat([Buffer.from("a50102032620012158", "hex"), Buffer.from([0x20]), x, Buffer.from("225820", "hex"), y]));
const credentialId = b64u(Buffer.from("credential-id-1"));

function assertion(o: { challenge: string; origin?: string; rpId?: string; flags?: number; counter?: number; type?: string }): AuthenticationResponseJSON {
  const authData = Buffer.alloc(37);
  createHash("sha256").update(o.rpId ?? RP_ID).digest().copy(authData, 0);
  authData[32] = o.flags ?? 0x05; // UP | UV
  authData.writeUInt32BE(o.counter ?? 1, 33);
  const clientData = Buffer.from(JSON.stringify({ type: o.type ?? "webauthn.get", challenge: o.challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
  const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), privateKey);
  return { id: credentialId, rawId: credentialId, type: "public-key", clientExtensionResults: {},
    response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) } };
}
const verify = (response: AuthenticationResponseJSON, challenge: string, counter = 0) =>
  verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
    credential: { id: credentialId, publicKey: cosePublicKey, counter } });

describe("per-attempt WebAuthn challenges", () => {
  it("are unique for every attempt and require user verification", async () => {
    const opts = await Promise.all(Array.from({ length: 200 }, () => generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required" })));
    expect(new Set(opts.map((o) => o.challenge)).size).toBe(200);
    expect(opts[0].userVerification).toBe("required");
  });
});

describe("assertion verification (report §6.2 / §10.1)", () => {
  it("accepts a valid assertion and returns the new counter + device info", async () => {
    const { challenge } = await generateAuthenticationOptions({ rpID: RP_ID });
    const r = await verify(assertion({ challenge, counter: 7 }), challenge, 3);
    expect(r.verified).toBe(true);
    expect(r.authenticationInfo.newCounter).toBe(7);
    expect(r.authenticationInfo.userVerified).toBe(true);
  });
  it("rejects another attempt's challenge (no cross-attempt replay)", async () => {
    const a = await generateAuthenticationOptions({ rpID: RP_ID }), b = await generateAuthenticationOptions({ rpID: RP_ID });
    await expect(verify(assertion({ challenge: a.challenge }), b.challenge)).rejects.toThrow();
  });
  it("rejects the wrong origin", async () => {
    const { challenge } = await generateAuthenticationOptions({ rpID: RP_ID });
    await expect(verify(assertion({ challenge, origin: "https://evil.example.com" }), challenge)).rejects.toThrow();
  });
  it("rejects the wrong RP ID", async () => {
    const { challenge } = await generateAuthenticationOptions({ rpID: RP_ID });
    await expect(verify(assertion({ challenge, rpId: "evil.example.com" }), challenge)).rejects.toThrow();
  });
  it("rejects an assertion without user verification (presence only)", async () => {
    const { challenge } = await generateAuthenticationOptions({ rpID: RP_ID });
    await expect(verify(assertion({ challenge, flags: 0x01 }), challenge)).rejects.toThrow();
  });
  it("rejects a registration-type ceremony and a forged signature", async () => {
    const { challenge } = await generateAuthenticationOptions({ rpID: RP_ID });
    await expect(verify(assertion({ challenge, type: "webauthn.create" }), challenge)).rejects.toThrow();
    const good = assertion({ challenge });
    const forged = { ...good, response: { ...good.response, signature: b64u(Buffer.alloc(70, 1)) } };
    await expect(verify(forged, challenge)).rejects.toThrow();
  });
  it("rejects a counter regression (possible cloned authenticator)", async () => {
    const { challenge } = await generateAuthenticationOptions({ rpID: RP_ID });
    await expect(verify(assertion({ challenge, counter: 5 }), challenge, 10)).rejects.toThrow(/counter/i);
  });
});
