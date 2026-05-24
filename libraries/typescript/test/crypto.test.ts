import { describe, expect, test } from "vitest";
import { randomBytes, createCipheriv, pbkdf2Sync } from "node:crypto";
import {
  decryptRqe1,
  encryptRqe1ForTest,
  PBKDF2_ITERATIONS,
} from "../src/crypto.js";
import {
  BundleCorruptError,
  UnsupportedSpecVersionError,
  WrongPassphraseError,
} from "../src/errors.js";

// Salt-byte-semantics: v0.12 §2.1 (post-revision) and the Python
// reference both feed the UTF-8 bytes of the `salt` STRING to PBKDF2.
// Do NOT base64-decode first; that would diverge from the corpus +
// CLI's encrypt path.

const SALT = "20ZiDJFKLLkDsDUiWSMn3g==";
const PASSPHRASE = "correct horse battery staple";

describe("decryptRqe1 — happy path round-trip", () => {
  // NOTE: the lib enforces a 48-byte structural floor for envelopes
  // (magic+salt+IV+tag accounting, per Wave 6 brief and v0.11 truncated-
  // ciphertext vector). CLI-produced bundles always exceed this in
  // practice — the smallest real plaintext is an RQEM0001 manifest at
  // 23+ bytes. We size test plaintexts to keep envelopes ≥ 48 bytes
  // here too; the "structurally short → BundleCorruptError" test below
  // exercises the floor directly.
  const PT_PAD = " ".repeat(16);

  test("encrypt then decrypt returns the original bytes", async () => {
    const pt = new TextEncoder().encode("hello world" + PT_PAD);
    const blob = await encryptRqe1ForTest(pt, PASSPHRASE, SALT);
    const out = await decryptRqe1(blob, PASSPHRASE, SALT);
    expect(Buffer.from(out).toString("utf8")).toBe("hello world" + PT_PAD);
  });

  test("empty plaintext round-trips (exactly 32-byte envelope = the floor)", async () => {
    // True-empty plaintext + AES-GCM yields a 32-byte envelope —
    // exactly at the structural floor (magic+IV+tag, no ciphertext).
    // Lib must let this through; the floor is `<`, not `<=`.
    const pt = new Uint8Array(0);
    const blob = await encryptRqe1ForTest(pt, PASSPHRASE, SALT);
    expect(blob.byteLength).toBe(32);
    const out = await decryptRqe1(blob, PASSPHRASE, SALT);
    expect(out.byteLength).toBe(0);
  });

  test("binary plaintext (non-UTF-8) round-trips byte-identical", async () => {
    const pt = new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x01, 0xc3, 0x28, 0xa0, 0xa1, ...new Array(16).fill(0x42)]);
    const blob = await encryptRqe1ForTest(pt, PASSPHRASE, SALT);
    const out = await decryptRqe1(blob, PASSPHRASE, SALT);
    expect(Array.from(out)).toEqual(Array.from(pt));
  });

  test("custom iterations parameter works (1000 iter for test speed)", async () => {
    const pt = new TextEncoder().encode("x" + PT_PAD);
    const blob = await encryptRqe1ForTest(pt, PASSPHRASE, SALT, 1000);
    const out = await decryptRqe1(blob, PASSPHRASE, SALT, 1000);
    expect(Buffer.from(out).toString("utf8")).toBe("x" + PT_PAD);
  });

  test("default iterations is 600000", () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });
});

describe("decryptRqe1 — error taxonomy", () => {
  test("too-short input → BundleCorruptError", async () => {
    await expect(decryptRqe1(new Uint8Array(10), PASSPHRASE, SALT)).rejects.toBeInstanceOf(
      BundleCorruptError,
    );
  });

  test("structurally short (< 32 bytes) → BundleCorruptError (truncation heuristic)", async () => {
    // 30 bytes — below the magic(4) + IV(12) + tag(16) = 32-byte
    // structural floor. v0.11 truncated-ciphertext vector pins this
    // exact size. Anything below 32 cannot carry even an empty
    // ciphertext + auth tag, so the lib classifies as BundleCorruptError
    // instead of letting it fall through to a GCM-tag failure (which
    // would surface as WrongPassphraseError and confuse operators).
    const tooShort = Buffer.concat([
      Buffer.from("RQE1", "ascii"),
      Buffer.alloc(26, 0),
    ]);
    expect(tooShort.byteLength).toBe(30);
    await expect(decryptRqe1(tooShort, PASSPHRASE, SALT)).rejects.toBeInstanceOf(
      BundleCorruptError,
    );
  });

  test("wrong magic prefix (not 'RQE') → BundleCorruptError", async () => {
    const blob = await encryptRqe1ForTest(
      new TextEncoder().encode("payload long enough to clear floor"),
      PASSPHRASE,
      SALT,
    );
    const corrupt = Buffer.from(blob);
    corrupt[0] = 0x58; // 'X'
    await expect(decryptRqe1(corrupt, PASSPHRASE, SALT)).rejects.toBeInstanceOf(
      BundleCorruptError,
    );
    // Distinct from the structural-truncation path: this is the magic check.
    await expect(decryptRqe1(corrupt, PASSPHRASE, SALT)).rejects.toThrow(/magic|not a vsync/i);
  });

  test("magic 'RQE' but version != '1' → UnsupportedSpecVersionError", async () => {
    const blob = await encryptRqe1ForTest(
      new TextEncoder().encode("payload that is at least sixteen bytes"),
      PASSPHRASE,
      SALT,
    );
    const v2 = Buffer.from(blob);
    v2[3] = 0x32; // '2'
    await expect(decryptRqe1(v2, PASSPHRASE, SALT)).rejects.toBeInstanceOf(
      UnsupportedSpecVersionError,
    );
  });

  test("wrong passphrase → WrongPassphraseError (full-size envelope)", async () => {
    const blob = await encryptRqe1ForTest(
      new TextEncoder().encode("the real secret payload"),
      PASSPHRASE,
      SALT,
    );
    await expect(
      decryptRqe1(blob, "definitely-not-the-passphrase", SALT),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("tampered ciphertext (full size, flipped byte) → WrongPassphraseError", async () => {
    const blob = await encryptRqe1ForTest(
      new TextEncoder().encode("payload that survives header"),
      PASSPHRASE,
      SALT,
    );
    const tampered = Buffer.from(blob);
    // Flip a byte deep in the ciphertext (past the 16-byte header).
    tampered[tampered.length - 5] ^= 0xff;
    await expect(decryptRqe1(tampered, PASSPHRASE, SALT)).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });
});

describe("decryptRqe1 — salt byte-semantics (CLI compat)", () => {
  test("PBKDF2 input = UTF-8 of the salt STRING (matches src/crypto.ts)", async () => {
    // Belt-and-braces: derive the key the same way the CLI does, encrypt
    // a payload by hand, then verify our decryptRqe1 unwraps it. If the
    // lib ever base64-decoded the salt first, this would fail.
    const passphrase = "team-secret";
    const saltStr = "abc==";  // intentionally not 16-byte base64
    const expectedKey = pbkdf2Sync(
      Buffer.from(passphrase, "utf8"),
      Buffer.from(saltStr, "utf8"),
      PBKDF2_ITERATIONS,
      32,
      "sha256",
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", expectedKey, iv);
    // Plaintext must be long enough that envelope ≥ 48 bytes (the
    // structural truncation floor). magic(4) + IV(12) + tag(16) = 32
    // header overhead, so a 16-byte plaintext yields 48 bytes exactly.
    const pt = Buffer.from("16-byte payload!");
    expect(pt.byteLength).toBe(16);
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([Buffer.from("RQE1", "ascii"), iv, ct, tag]);
    expect(blob.byteLength).toBeGreaterThanOrEqual(48);
    const out = await decryptRqe1(blob, passphrase, saltStr);
    expect(Buffer.from(out).toString("utf8")).toBe("16-byte payload!");
  });
});
