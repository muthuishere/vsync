// RQE1 envelope — decrypt path only. (Read-side library; the CLI is the
// canonical writer.)
//
// Envelope layout (mirrors `src/crypto.ts` in the CLI):
//   bytes 0..3    magic "RQE1"
//   bytes 4..15   12-byte IV (random per encryption)
//   bytes 16..N   ciphertext || 16-byte AES-GCM auth tag
//
// KDF: PBKDF2-HMAC-SHA256, 600_000 iterations → 32-byte AES-256 key.
//
// ─── Salt byte-semantics (load-bearing) ─────────────────────────────────
//
// Per v0.12 §2.1 (post-revision) and the Python reference implementation,
// the `salt` field is a STRING and its **UTF-8 bytes** are the input to
// PBKDF2. Readers MUST NOT base64-decode the salt before feeding it to
// PBKDF2 — the field's base64-like alphabet is a CLI storage artefact
// (the CLI's per-(repo, env) salt is generated as `b64nopad(random_18b)`
// and stored as that ASCII string in the on-disk config), not a wire
// transport-encoding marker.
//
// This convention is what:
//   • the CLI's `src/crypto.ts::deriveKey` does (calls `enc.encode(salt)`)
//   • the test-vector generator does (encrypts via `encryptWithIV(pt, pw, saltStr, iv)`)
//   • the Python reference's `crypto._derive_key` does (`salt.encode("utf-8")`)
//
// Spec contract: feed the UTF-8 bytes of the string directly. Library
// `BundleCorruptError(< 48 bytes structural truncation)` heuristic per
// Wave 6 brief.

import { createDecipheriv, createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  BundleCorruptError,
  UnsupportedSpecVersionError,
  WrongPassphraseError,
} from "./errors.js";

const MAGIC_PREFIX = Buffer.from("RQE", "ascii"); // 3 bytes
const MAGIC_VERSION = Buffer.from("1", "ascii"); // 1 byte
const MAGIC = Buffer.concat([MAGIC_PREFIX, MAGIC_VERSION]); // "RQE1"
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN; // 16
const KEY_LEN = 32;
export const PBKDF2_ITERATIONS = 600_000;
// Structural truncation floor — magic(4) + IV(12) + ciphertext≥0 +
// tag(16) = 32-byte minimum for a syntactically valid RQE1 envelope.
// Anything below 32 bytes can't structurally hold even an empty
// ciphertext + auth tag, so we classify as BundleCorruptError before
// PBKDF2 — this disambiguates the v0.11 `truncated-ciphertext` (30 bytes)
// vector from the `wrong-passphrase` / `bad-gcm-tag` cases (≥32 bytes,
// AES-GCM tag failure → WrongPassphraseError).
//
// Matches Python's `HEADER_LEN(16) + MIN_CT_LEN(16) = 32` floor.
const MIN_ENVELOPE_BYTES = 32;

function deriveKey(passphrase: string, saltString: string, iterations: number): Buffer {
  return pbkdf2Sync(
    Buffer.from(passphrase, "utf8"),
    Buffer.from(saltString, "utf8"),
    iterations,
    KEY_LEN,
    "sha256",
  );
}

/**
 * Decrypt an RQE1 envelope. Maps crypto failures to the v0.12 taxonomy:
 *   - too-short / corrupt magic prefix / structural truncation → BundleCorruptError
 *   - magic prefix "RQE" but version byte != "1"               → UnsupportedSpecVersionError
 *   - GCM tag rejects (wrong passphrase or tampering)          → WrongPassphraseError
 *
 * `salt` is the STRING from the config blob; UTF-8 bytes are fed to PBKDF2.
 */
export async function decryptRqe1(
  blob: Uint8Array,
  passphrase: string,
  salt: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  if (blob.byteLength < MIN_ENVELOPE_BYTES) {
    throw new BundleCorruptError(
      `RQE1 envelope too short: ${blob.byteLength} bytes (need at least ${MIN_ENVELOPE_BYTES} for magic+IV+tag)`,
    );
  }
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (!buf.subarray(0, MAGIC_PREFIX.length).equals(MAGIC_PREFIX)) {
    throw new BundleCorruptError(
      "RQE1 envelope: magic prefix is not 'RQE' — not a vsync envelope",
    );
  }
  if (!buf.subarray(MAGIC_PREFIX.length, MAGIC.length).equals(MAGIC_VERSION)) {
    const got = buf.subarray(MAGIC_PREFIX.length, MAGIC.length).toString("ascii");
    throw new UnsupportedSpecVersionError(
      `RQE envelope advertises version '${got}'; this library understands version '1' only — upgrade vsync-s3-client`,
    );
  }

  const iv = buf.subarray(MAGIC.length, HEADER_LEN);
  const ctAndTag = buf.subarray(HEADER_LEN);
  // Node's createDecipheriv wants ct and tag separately; AES-GCM tag is
  // the last 16 bytes by convention in our envelope.
  const ct = ctAndTag.subarray(0, ctAndTag.byteLength - TAG_LEN);
  const tag = ctAndTag.subarray(ctAndTag.byteLength - TAG_LEN);

  const key = deriveKey(passphrase, salt, iterations);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return new Uint8Array(pt.buffer, pt.byteOffset, pt.byteLength);
  } catch (e) {
    // Node's AES-GCM raises a plain Error with message containing
    // "Unsupported state or unable to authenticate data" on tag rejection.
    // We collapse to WrongPassphraseError per the taxonomy.
    throw new WrongPassphraseError(
      `RQE1 envelope: AES-GCM tag rejected — the passphrase is wrong or the ciphertext has been tampered with (${(e as Error).message})`,
    );
  }
}

/**
 * Round-trip helper for the unit suite — do NOT call from production.
 * Production encryption belongs to the CLI; this helper exists so the
 * test suite can mint envelopes without depending on the corpus.
 */
export async function encryptRqe1ForTest(
  plaintext: Uint8Array,
  passphrase: string,
  salt: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt, iterations);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([MAGIC, iv, ct, tag]);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
