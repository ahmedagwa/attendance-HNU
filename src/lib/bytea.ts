/** PostgREST represents bytea as a "\x…" hex string. */
export const toBytea = (u8: Uint8Array) => "\\x" + Buffer.from(u8).toString("hex");
export const fromBytea = (s: string): Uint8Array<ArrayBuffer> => {
  const hex = s.startsWith("\\x") ? s.slice(2) : s;
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
