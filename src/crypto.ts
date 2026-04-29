// AES-256-GCM with PBKDF2-SHA256 key derivation from password+salt.
//
// Envelope format on disk:
//   bytes 0..3   — magic "RQE1"
//   bytes 4..15  — 12-byte IV (random per encryption)
//   bytes 16..N  — ciphertext (Web Crypto AES-GCM appends a 16-byte auth tag)

const MAGIC = new Uint8Array([0x52, 0x51, 0x45, 0x31]); // "RQE1"
const IV_LEN = 12;
const HEADER_LEN = MAGIC.length + IV_LEN; // 16
const PBKDF2_ITERATIONS = 600_000;

async function deriveKey(password: string, salt: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(
  data: Uint8Array,
  password: string,
  salt: string,
): Promise<Uint8Array> {
  const key = await deriveKey(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data),
  );
  const out = new Uint8Array(HEADER_LEN + ct.byteLength);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, HEADER_LEN);
  return out;
}

export async function decrypt(
  blob: Uint8Array,
  password: string,
  salt: string,
): Promise<Uint8Array> {
  if (blob.byteLength < HEADER_LEN) {
    throw new Error("envelope too short");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) {
      throw new Error("invalid magic — not an RQE1 envelope");
    }
  }
  const iv = blob.slice(MAGIC.length, HEADER_LEN);
  const ct = blob.slice(HEADER_LEN);
  const key = await deriveKey(password, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(pt);
}
