// Plaintext manifest bound into the encrypted bundle. Lets the pull side
// verify that the bundle was actually sealed at the timestamp `latest`
// claims, so an attacker with bucket-write but no encryption key can't
// repoint `latest` at a renamed copy of an older version.
//
// Layout (before encryption):
//   bytes 0..7   — magic "RQEM0001"
//   bytes 8..22  — 15-byte timestamp string "YYYYMMDD-HHmmss"
//   bytes 23..N  — original payload (the zip bytes)

const MAGIC = new TextEncoder().encode("RQEM0001");
const TS_LEN = 15;
const HEADER_LEN = MAGIC.length + TS_LEN; // 23

export function wrap(ts: string, payload: Uint8Array): Uint8Array {
  if (ts.length !== TS_LEN) {
    throw new Error(`manifest ts must be ${TS_LEN} chars (got ${ts.length})`);
  }
  const out = new Uint8Array(HEADER_LEN + payload.byteLength);
  out.set(MAGIC, 0);
  out.set(new TextEncoder().encode(ts), MAGIC.length);
  out.set(payload, HEADER_LEN);
  return out;
}

export function unwrap(blob: Uint8Array): { ts: string; payload: Uint8Array } {
  if (blob.byteLength < HEADER_LEN) {
    throw new Error("manifest too short");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) {
      throw new Error("invalid manifest magic — not an RQEM0001 bundle");
    }
  }
  const ts = new TextDecoder().decode(blob.slice(MAGIC.length, HEADER_LEN));
  const payload = blob.slice(HEADER_LEN);
  return { ts, payload };
}
