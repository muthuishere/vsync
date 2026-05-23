#!/usr/bin/env bun
// Deterministic test-vector generator for docs/specs/test-vectors/.
//
// Spec: docs/specs/v0.11-conformance-test-vectors.md
// Wire formats reused unchanged:
//   - RQE1 envelope from src/crypto.ts (encryptWithIV — deterministic IV)
//   - RQEM0001 manifest from src/manifest.ts
//
// Determinism rules:
//   - Per-vector IV / salt / nonces come from sha256("vsync-vec-v0.12|<cat>|<name>")
//   - gzip level fixed (9). Bun.gzipSync emits zero mtime/os bytes by default.
//   - base64url, no padding (RFC 4648 §5).
//   - JSON.stringify with 2-space indent, LF, trailing newline.
//   - Object key insertion order is deliberate so JSON.stringify is byte-stable.
//   - `generated_by` defaults to the current HEAD sha (override via VSYNC_VECTOR_SHA
//     or the {sha} option) so tests can pin a value.
//
// CLI usage:
//   bun scripts/generate-test-vectors.ts                          # → docs/specs/test-vectors/
//   bun scripts/generate-test-vectors.ts --out=/tmp/vectors       # → /tmp/vectors/
//   VSYNC_VECTOR_SHA=abc123 bun scripts/generate-test-vectors.ts  # pin sha
//
// Programmatic:
//   import { generateAllVectors } from "./scripts/generate-test-vectors";
//   await generateAllVectors({ outDir: "/tmp/x", sha: "deadbeef..." });

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encryptWithIV } from "../src/crypto";
import { wrap as wrapManifest } from "../src/manifest";

const SPEC_VERSION = "v0.12";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT = join(REPO_ROOT, "docs", "specs", "test-vectors");

// Categories preserved in spec order; README.md in each one is kept across
// regen (the spec says the category READMEs are part of the corpus).
const CATEGORIES = [
  "rqe1-decrypt",
  "rqe1-decrypt-error",
  "rqem0001-manifest",
  "config-blob",
  "fallback-chain",
  "asset-path",
  "error-taxonomy",
] as const;
type Category = (typeof CATEGORIES)[number];

// ---------- determinism helpers --------------------------------------------

function vectorSeed(category: string, name: string, label: string): Uint8Array {
  // SHA-256 over a stable preimage. The label lets one vector source two
  // independent byte streams (e.g. IV and salt) without correlation.
  const pre = `vsync-vec-v0.12|${category}|${name}|${label}`;
  return new Uint8Array(
    Bun.CryptoHasher.hash("sha256", new TextEncoder().encode(pre)) as Uint8Array,
  );
}

function deterministicIV(category: string, name: string): Uint8Array {
  return vectorSeed(category, name, "iv").slice(0, 12);
}

function deterministicSalt(category: string, name: string): string {
  // The salt is a string fed to PBKDF2; we use a base64-encoded 16-byte
  // digest so the salt itself is text-safe and pinned per vector.
  const raw = vectorSeed(category, name, "salt").slice(0, 16);
  return Buffer.from(raw).toString("base64");
}

function base64urlNoPad(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gzipFixed(bytes: Uint8Array): Uint8Array {
  return Bun.gzipSync(bytes, { level: 9 });
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function jsonStableStringify(obj: unknown): string {
  // 2-space indent, LF, trailing newline. We rely on insertion order of the
  // input object — every vector builder below constructs its object in a
  // fixed order.
  return JSON.stringify(obj, null, 2) + "\n";
}

// ---------- output --------------------------------------------------------

function clearCategoryDir(outDir: string, cat: Category): void {
  const dir = join(outDir, cat);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  for (const entry of readdirSync(dir)) {
    if (entry === "README.md") continue; // README is hand-written, keep it.
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
    else rmSync(p);
  }
}

interface VectorJSON {
  category: Category;
  description: string;
  inputs: Record<string, unknown>;
  expected: Record<string, unknown>;
  generated_by: string;
  spec_version: typeof SPEC_VERSION;
}

function writeVector(
  outDir: string,
  cat: Category,
  name: string,
  meta: VectorJSON,
  bin: Uint8Array | null,
): void {
  const base = join(outDir, cat, name);
  writeFileSync(`${base}.json`, jsonStableStringify(meta));
  if (bin !== null) writeFileSync(`${base}.bin`, bin);
}

// ---------- main generator -------------------------------------------------

export interface GenerateOptions {
  outDir?: string;
  sha?: string;
}

export async function generateAllVectors(opts: GenerateOptions = {}): Promise<void> {
  const outDir = opts.outDir ?? DEFAULT_OUT;
  const sha = opts.sha ?? process.env.VSYNC_VECTOR_SHA ?? readGitSha();
  const tag = `vsync@${sha}`;
  mkdirSync(outDir, { recursive: true });
  for (const cat of CATEGORIES) clearCategoryDir(outDir, cat);

  await emitRqe1Decrypt(outDir, tag);
  await emitRqe1DecryptError(outDir, tag);
  await emitRqem0001Manifest(outDir, tag);
  emitConfigBlob(outDir, tag);
  emitFallbackChain(outDir, tag);
  emitAssetPath(outDir, tag);
  await emitErrorTaxonomy(outDir, tag);
}

function readGitSha(): string {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT });
    return new TextDecoder().decode(r.stdout).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// ===== category emitters ==================================================

// --- rqe1-decrypt ---------------------------------------------------------
//
// Three positive vectors covering: empty plaintext, short UTF-8, raw bytes
// that are NOT valid UTF-8 (so a lib's loader is forced down the hex-only
// comparison path defined in v0.11 §3).

async function emitRqe1Decrypt(outDir: string, tag: string): Promise<void> {
  const cat: Category = "rqe1-decrypt";
  const passphrase = "correct horse battery staple";

  const cases: { name: string; description: string; pt: Uint8Array; utf8?: string }[] = [
    {
      name: "empty-plaintext",
      description: "Decrypt an empty-payload RQE1 envelope; expected plaintext is zero bytes",
      pt: new Uint8Array(0),
      utf8: "",
    },
    {
      name: "hello-world",
      description: "Decrypt a passphrase-derived RQE1 envelope; expect 'hello world' UTF-8",
      pt: new TextEncoder().encode("hello world"),
      utf8: "hello world",
    },
    {
      name: "non-utf8-bytes",
      description: "Decrypt RQE1 envelope whose plaintext is binary (not valid UTF-8); loaders compare on hex only",
      pt: new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x01, 0xc3, 0x28, 0xa0, 0xa1]),
    },
  ];

  for (const c of cases) {
    const salt = deterministicSalt(cat, c.name);
    const iv = deterministicIV(cat, c.name);
    const bin = await encryptWithIV(c.pt, passphrase, salt, iv);
    const expected: Record<string, unknown> = {
      plaintext_hex: toHex(c.pt),
    };
    if (c.utf8 !== undefined) expected.plaintext_utf8 = c.utf8;
    expected.error = null;
    writeVector(
      outDir,
      cat,
      c.name,
      {
        category: cat,
        description: c.description,
        inputs: { passphrase, salt },
        expected,
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      bin,
    );
  }
}

// --- rqe1-decrypt-error ---------------------------------------------------
//
// Five negative vectors. Each .bin is either a tampered RQE1 envelope or
// the wrong-passphrase case (envelope is fine; the passphrase in inputs is
// wrong on purpose). v0.12 §11 names the canonical error classes.

async function emitRqe1DecryptError(outDir: string, tag: string): Promise<void> {
  const cat: Category = "rqe1-decrypt-error";
  const correctPassphrase = "correct horse battery staple";

  // Build one fresh valid envelope; the negative cases mutate copies.
  const baseName = "wrong-passphrase";
  const baseSalt = deterministicSalt(cat, baseName);
  const baseIV = deterministicIV(cat, baseName);
  const validEnvelope = await encryptWithIV(
    new TextEncoder().encode("the real secret"),
    correctPassphrase,
    baseSalt,
    baseIV,
  );

  // 1. Wrong passphrase — envelope is valid, inputs.passphrase isn't.
  writeVector(
    outDir,
    cat,
    "wrong-passphrase",
    {
      category: cat,
      description: "Valid RQE1 envelope; inputs.passphrase is wrong → WrongPassphraseError",
      inputs: { passphrase: "definitely-not-the-passphrase", salt: baseSalt },
      expected: { plaintext_hex: null, error: "WrongPassphraseError" },
      generated_by: tag,
      spec_version: SPEC_VERSION,
    },
    validEnvelope,
  );

  // 2. Corrupt magic — flip byte 0 from 'R' to 'X'.
  const magicName = "corrupt-magic";
  const magicSalt = deterministicSalt(cat, magicName);
  const magicIV = deterministicIV(cat, magicName);
  const magicEnvelope = await encryptWithIV(
    new TextEncoder().encode("payload"),
    correctPassphrase,
    magicSalt,
    magicIV,
  );
  const corruptMagic = new Uint8Array(magicEnvelope);
  corruptMagic[0] = 0x58; // 'X'
  writeVector(
    outDir,
    cat,
    "corrupt-magic",
    {
      category: cat,
      description: "RQE1 magic byte 0 flipped (R→X) → BundleCorruptError",
      inputs: { passphrase: correctPassphrase, salt: magicSalt },
      expected: { plaintext_hex: null, error: "BundleCorruptError" },
      generated_by: tag,
      spec_version: SPEC_VERSION,
    },
    corruptMagic,
  );

  // 3. Truncated ciphertext — structurally short. AES-GCM raises the same
  // InvalidTag exception for "tag bytes corrupted" and "ciphertext clipped
  // mid-payload," so the lib disambiguates by length: an RQE1 envelope
  // shorter than magic(4) + salt(16) + IV(12) + tag(16) = 48 bytes is
  // structurally impossible → BundleCorruptError. Without the length
  // heuristic the lib can't tell this case apart from bad-gcm-tag.bin
  // (which is the canonical full-size, flipped-byte case that surfaces
  // WrongPassphraseError). We emit the first 30 bytes of a real envelope
  // so it looks like a valid prefix that was cut short.
  const truncName = "truncated-ciphertext";
  const truncSalt = deterministicSalt(cat, truncName);
  const truncIV = deterministicIV(cat, truncName);
  const fullEnvelope = await encryptWithIV(
    new TextEncoder().encode("longer payload to clearly survive header"),
    correctPassphrase,
    truncSalt,
    truncIV,
  );
  const truncated = fullEnvelope.slice(0, 30);
  writeVector(
    outDir,
    cat,
    "truncated-ciphertext",
    {
      category: cat,
      description: "RQE1 envelope structurally truncated to 30 bytes — below the 48-byte minimum (magic+salt+IV+tag) → BundleCorruptError",
      inputs: { passphrase: correctPassphrase, salt: truncSalt },
      expected: { plaintext_hex: null, error: "BundleCorruptError" },
      generated_by: tag,
      spec_version: SPEC_VERSION,
    },
    truncated,
  );

  // 4. Bad GCM tag — flip a byte deep inside the ciphertext (auth fails).
  const tagName = "bad-gcm-tag";
  const tagSalt = deterministicSalt(cat, tagName);
  const tagIV = deterministicIV(cat, tagName);
  const tagEnvelope = await encryptWithIV(
    new TextEncoder().encode("payload"),
    correctPassphrase,
    tagSalt,
    tagIV,
  );
  const badTag = new Uint8Array(tagEnvelope);
  // 16-byte header + 16-byte GCM tag at end; flip last byte for predictable failure.
  badTag[badTag.length - 1] ^= 0xff;
  writeVector(
    outDir,
    cat,
    "bad-gcm-tag",
    {
      category: cat,
      description: "RQE1 envelope final byte XOR 0xFF (GCM tag invalid) → WrongPassphraseError",
      inputs: { passphrase: correctPassphrase, salt: tagSalt },
      expected: { plaintext_hex: null, error: "WrongPassphraseError" },
      generated_by: tag,
      spec_version: SPEC_VERSION,
    },
    badTag,
  );

  // 5. Wrong RQE1 version — flip byte 3 from '1' to '2'.
  const verName = "wrong-version";
  const verSalt = deterministicSalt(cat, verName);
  const verIV = deterministicIV(cat, verName);
  const verEnvelope = await encryptWithIV(
    new TextEncoder().encode("payload"),
    correctPassphrase,
    verSalt,
    verIV,
  );
  const wrongVer = new Uint8Array(verEnvelope);
  wrongVer[3] = 0x32; // '2' instead of '1'
  writeVector(
    outDir,
    cat,
    "wrong-version",
    {
      category: cat,
      description: "RQE1 magic byte 3 flipped (1→2) → UnsupportedSpecVersionError",
      inputs: { passphrase: correctPassphrase, salt: verSalt },
      expected: { plaintext_hex: null, error: "UnsupportedSpecVersionError" },
      generated_by: tag,
      spec_version: SPEC_VERSION,
    },
    wrongVer,
  );
}

// --- rqem0001-manifest ----------------------------------------------------
//
// 2 positives (round-trip with embedded ts) + 2 negatives (embedded vs remote
// ts mismatch, wrong magic).

async function emitRqem0001Manifest(outDir: string, tag: string): Promise<void> {
  const cat: Category = "rqem0001-manifest";

  // Positive 1 — embedded ts == remote ts, small inner payload.
  {
    const name = "positive-basic";
    const ts = "20260429-103045";
    const payload = new TextEncoder().encode("{ \"gen\": 1, \"hello\": \"world\" }");
    const wrapped = wrapManifest(ts, payload);
    writeVector(
      outDir,
      cat,
      name,
      {
        category: cat,
        description: "RQEM0001 manifest sealed at ts=20260429-103045; matches remote",
        inputs: { passphrase: "n/a — plaintext manifest layer", remote_ts: ts },
        expected: { embedded_ts: ts, payload_hex: toHex(payload), error: null },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      wrapped,
    );
  }

  // Positive 2 — different ts + gen=N counter inside.
  {
    const name = "positive-gen-counter";
    const ts = "20260501-091500";
    const payload = new TextEncoder().encode("{ \"gen\": 42 }");
    const wrapped = wrapManifest(ts, payload);
    writeVector(
      outDir,
      cat,
      name,
      {
        category: cat,
        description: "RQEM0001 manifest with gen=42; embedded ts matches remote",
        inputs: { passphrase: "n/a — plaintext manifest layer", remote_ts: ts },
        expected: { embedded_ts: ts, payload_hex: toHex(payload), error: null },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      wrapped,
    );
  }

  // Negative 1 — embedded ts != remote ts (attacker renamed an older blob).
  {
    const name = "ts-mismatch";
    const embeddedTs = "20260429-103045";
    const remoteTs = "20260501-091500";
    const wrapped = wrapManifest(embeddedTs, new TextEncoder().encode("payload"));
    writeVector(
      outDir,
      cat,
      name,
      {
        category: cat,
        description: "Manifest embedded ts (20260429…) != remote ts (20260501…) → BundleCorruptError",
        inputs: { passphrase: "n/a", remote_ts: remoteTs },
        expected: { embedded_ts: embeddedTs, payload_hex: null, error: "BundleCorruptError" },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      wrapped,
    );
  }

  // Negative 2 — wrong magic.
  {
    const name = "wrong-magic";
    const ts = "20260429-103045";
    const wrapped = wrapManifest(ts, new TextEncoder().encode("payload"));
    const tampered = new Uint8Array(wrapped);
    tampered[0] = 0x58; // 'X' instead of 'R'
    writeVector(
      outDir,
      cat,
      name,
      {
        category: cat,
        description: "RQEM0001 magic byte 0 flipped (R→X) → BundleCorruptError",
        inputs: { passphrase: "n/a", remote_ts: ts },
        expected: { embedded_ts: null, payload_hex: null, error: "BundleCorruptError" },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      tampered,
    );
  }
}

// --- config-blob ----------------------------------------------------------
//
// v0.12 §2.1 format: "vsync-cfg-v1:<base64url-no-pad(gzip(json))>".
// 3 positives (AWS / R2 / MinIO endpoint shapes) + 3 negatives (wrong magic,
// malformed gzip, unknown v).

function buildConfigBlob(inner: object): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(inner));
  const gz = gzipFixed(json);
  const b64 = base64urlNoPad(gz);
  return new TextEncoder().encode(`vsync-cfg-v1:${b64}`);
}

function emitConfigBlob(outDir: string, tag: string): void {
  const cat: Category = "config-blob";

  // v0.12 §2.1 / v0.10 §4: the runtime lib has no separate salt source for
  // RQE1 PBKDF2, so the inner JSON now carries `salt` (base64 16 bytes) and
  // `iterations`. Per-vector salt is derived deterministically the same way
  // every other secret in this corpus is — sha256("vsync-vec-v0.12|<cat>|
  // <name>|salt") → first 16 bytes → base64.
  const PBKDF2_ITERATIONS = 600_000;
  function configSalt(name: string): string {
    return deterministicSalt(cat, name);
  }

  const positives: { name: string; description: string; inner: Record<string, unknown> }[] = [
    {
      name: "positive-aws",
      description: "VSYNC_CONFIG for AWS S3 (us-east-1) — typical cloud shape; carries salt+iterations per v0.12 §2.1",
      inner: {
        v: 1,
        endpoint: "https://s3.amazonaws.com",
        region: "us-east-1",
        bucket: "acme-secrets",
        accessKeyId: "AKIAEXAMPLE0000000000",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        prefix: "myapp/",
        env: "prod",
        salt: configSalt("positive-aws"),
        iterations: PBKDF2_ITERATIONS,
      },
    },
    {
      name: "positive-r2",
      description: "VSYNC_CONFIG for Cloudflare R2 — explicit endpoint, region=auto; carries salt+iterations per v0.12 §2.1",
      inner: {
        v: 1,
        endpoint: "https://abc123.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "acme-vault",
        accessKeyId: "r2_access_key_id_example",
        secretAccessKey: "r2_secret_access_key_example",
        prefix: "web/",
        env: "staging",
        salt: configSalt("positive-r2"),
        iterations: PBKDF2_ITERATIONS,
      },
    },
    {
      name: "positive-minio",
      description: "VSYNC_CONFIG for self-hosted MinIO — http endpoint, no prefix; carries salt+iterations per v0.12 §2.1",
      inner: {
        v: 1,
        endpoint: "http://minio.internal:9000",
        region: "us-east-1",
        bucket: "secrets",
        accessKeyId: "minioadmin",
        secretAccessKey: "minioadmin",
        prefix: "",
        env: "dev",
        salt: configSalt("positive-minio"),
        iterations: PBKDF2_ITERATIONS,
      },
    },
  ];

  for (const c of positives) {
    const bin = buildConfigBlob(c.inner);
    writeVector(
      outDir,
      cat,
      c.name,
      {
        category: cat,
        description: c.description,
        inputs: {},
        expected: { config_json: c.inner, error: null },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      bin,
    );
  }

  // Negative 1 — wrong magic prefix (raw JSON, no "vsync-cfg-v1:"). Inner
  // shape doesn't need salt/iterations because this vector tests the magic-
  // prefix check, not the inner JSON.
  {
    const negativeInner = {
      v: 1,
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "acme-secrets",
      accessKeyId: "AKIAEXAMPLE0000000000",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      prefix: "myapp/",
      env: "prod",
    };
    const bin = new TextEncoder().encode(JSON.stringify(negativeInner));
    writeVector(
      outDir,
      cat,
      "negative-wrong-magic",
      {
        category: cat,
        description: "Raw JSON pasted without the vsync-cfg-v1: prefix → ConfigMissingError",
        inputs: {},
        expected: { config_json: null, error: "ConfigMissingError" },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      bin,
    );
  }

  // Negative 2 — magic OK but the base64url body decodes to non-gzip bytes.
  {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
    const bin = new TextEncoder().encode(`vsync-cfg-v1:${base64urlNoPad(garbage)}`);
    writeVector(
      outDir,
      cat,
      "negative-malformed-gzip",
      {
        category: cat,
        description: "Correct magic, base64url-no-pad body decodes to non-gzip bytes → BundleCorruptError",
        inputs: {},
        expected: { config_json: null, error: "BundleCorruptError" },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      bin,
    );
  }

  // Negative 3 — magic OK, inner JSON has v: 99.
  {
    const bin = buildConfigBlob({
      v: 99,
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "acme",
      accessKeyId: "k",
      secretAccessKey: "s",
      prefix: "",
      env: "prod",
    });
    writeVector(
      outDir,
      cat,
      "negative-unknown-version",
      {
        category: cat,
        description: "Magic + gzip + base64url all valid but inner v=99 → ConfigUnsupportedVersionError",
        inputs: {},
        expected: { config_json: null, error: "ConfigUnsupportedVersionError" },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      bin,
    );
  }
}

// --- fallback-chain -------------------------------------------------------
//
// JSON-only (no .bin). v0.12 §5: vault → env → defaults → missing.
// 4 vectors covering one win per source plus a "missing" probe.

interface FallbackResult {
  key: string;
  value: string | null;
  source: "vault" | "env" | "default" | "missing";
  has: boolean;
}

interface FallbackInputs {
  bin: null;
  vault: Record<string, string>;
  env: Record<string, string>;
  defaults: Record<string, string>;
  queries: string[];
}

function emitFallbackChain(outDir: string, tag: string): void {
  const cat: Category = "fallback-chain";

  const cases: { name: string; description: string; inputs: FallbackInputs; expected: FallbackResult[] }[] = [
    {
      name: "vault-hit",
      description: "Key present in vault, env, AND defaults → vault wins",
      inputs: {
        bin: null,
        vault: { DATABASE_URL: "postgres://vault" },
        env: { DATABASE_URL: "postgres://env" },
        defaults: { DATABASE_URL: "postgres://default" },
        queries: ["DATABASE_URL"],
      },
      expected: [
        { key: "DATABASE_URL", value: "postgres://vault", source: "vault", has: true },
      ],
    },
    {
      name: "env-hit",
      description: "Key absent from vault, present in env and defaults → env wins",
      inputs: {
        bin: null,
        vault: {},
        env: { STRIPE_KEY: "sk_live_env" },
        defaults: { STRIPE_KEY: "sk_test_default" },
        queries: ["STRIPE_KEY"],
      },
      expected: [
        { key: "STRIPE_KEY", value: "sk_live_env", source: "env", has: true },
      ],
    },
    {
      name: "default-hit",
      description: "Key absent from vault and env → defaults are the floor",
      inputs: {
        bin: null,
        vault: {},
        env: {},
        defaults: { PORT: "8080" },
        queries: ["PORT"],
      },
      expected: [
        { key: "PORT", value: "8080", source: "default", has: true },
      ],
    },
    {
      name: "missing",
      description: "Key nowhere; value is null, source is 'missing', has is false",
      inputs: {
        bin: null,
        vault: { OTHER: "x" },
        env: { ANOTHER: "y" },
        defaults: { THIRD: "z" },
        queries: ["DATABASE_URL"],
      },
      expected: [
        { key: "DATABASE_URL", value: null, source: "missing", has: false },
      ],
    },
  ];

  for (const c of cases) {
    writeVector(
      outDir,
      cat,
      c.name,
      {
        category: cat,
        description: c.description,
        inputs: c.inputs,
        expected: { results: c.expected, error: null },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      null,
    );
  }
}

// --- asset-path -----------------------------------------------------------
//
// 2 vectors. Binary content the lib must materialize at mode 0600.

function emitAssetPath(outDir: string, tag: string): void {
  const cat: Category = "asset-path";

  const pemBytes = new TextEncoder().encode(
    "-----BEGIN PRIVATE KEY-----\n" +
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDFAKEKEYBYTESxx\n" +
      "-----END PRIVATE KEY-----\n",
  );
  writeVector(
    outDir,
    cat,
    "pem-key",
    {
      category: cat,
      description: "Materialize a fake PEM private key to a 0600 tempfile; bytes match exactly",
      inputs: { key: "TLS_PRIVATE_KEY_PEM", vault: { TLS_PRIVATE_KEY_PEM: "<binary — see .bin>" } },
      expected: { bytes_hex: toHex(pemBytes), mode_octal: "0600", error: null },
      generated_by: tag,
      spec_version: SPEC_VERSION,
    },
    pemBytes,
  );

  const jsonBytes = new TextEncoder().encode(
    JSON.stringify(
      {
        type: "service_account",
        project_id: "example-project",
        private_key_id: "abc123",
        client_email: "svc@example.iam.gserviceaccount.com",
      },
      null,
      2,
    ),
  );
  writeVector(
    outDir,
    cat,
    "service-account-json",
    {
      category: cat,
      description: "Materialize a GCP-shaped service-account JSON to a 0600 tempfile",
      inputs: { key: "GOOGLE_APPLICATION_CREDENTIALS_JSON", vault: { GOOGLE_APPLICATION_CREDENTIALS_JSON: "<binary — see .bin>" } },
      expected: { bytes_hex: toHex(jsonBytes), mode_octal: "0600", error: null },
      generated_by: tag,
      spec_version: SPEC_VERSION,
    },
    jsonBytes,
  );
}

// --- error-taxonomy -------------------------------------------------------
//
// One vector per canonical error class from v0.12 §11. Mixes byte-driven
// negatives (carry .bin) and purely-API negatives (no .bin).

async function emitErrorTaxonomy(outDir: string, tag: string): Promise<void> {
  const cat: Category = "error-taxonomy";

  // ConfigMissingError — no magic prefix (purely API-driven; the .bin would
  // be the same blob already in config-blob/negative-wrong-magic, so we
  // mark this one bin-less and let loaders simulate the env-var-missing
  // case directly).
  writeVector(
    outDir,
    cat,
    "config-missing",
    {
      category: cat,
      description: "VSYNC_CONFIG and VSYNC_PASSPHRASE both unset at Open() → ConfigMissingError",
      inputs: { bin: null, env: {} },
      expected: { error: "ConfigMissingError" },
      generated_by: tag,
      spec_version: SPEC_VERSION,
    },
    null,
  );

  // ConfigUnsupportedVersionError — reuse the v=99 shape with a .bin.
  {
    const bin = buildConfigBlob({ v: 99, endpoint: "https://s3.example.com" });
    writeVector(
      outDir,
      cat,
      "config-unsupported-version",
      {
        category: cat,
        description: "Inner JSON v=99; loader must surface ConfigUnsupportedVersionError, not a generic decode error",
        inputs: { bin: "see-bin" },
        expected: { error: "ConfigUnsupportedVersionError" },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      bin,
    );
  }

  // S3UnreachableError — purely API-driven (the lib must classify network
  // / 403 failures as this class).
  writeVector(
    outDir,
    cat,
    "s3-unreachable",
    {
      category: cat,
      description: "Open() fails when S3 endpoint is unreachable / IAM rejects (4xx/5xx) → S3UnreachableError",
      inputs: { bin: null, scenario: "network-error-or-iam-403" },
      expected: { error: "S3UnreachableError" },
      generated_by: tag,
      spec_version: SPEC_VERSION,
    },
    null,
  );

  // ManifestNotFoundError — bucket reachable, latest.manifest absent.
  writeVector(
    outDir,
    cat,
    "manifest-not-found",
    {
      category: cat,
      description: "Bucket reachable but <prefix><env>/latest.manifest is 404 → ManifestNotFoundError",
      inputs: { bin: null, scenario: "manifest-404" },
      expected: { error: "ManifestNotFoundError" },
      generated_by: tag,
      spec_version: SPEC_VERSION,
    },
    null,
  );

  // WrongPassphraseError — byte-driven, mirrors rqe1-decrypt-error.
  {
    const name = "wrong-passphrase";
    const salt = deterministicSalt(cat, name);
    const iv = deterministicIV(cat, name);
    const bin = await encryptWithIV(
      new TextEncoder().encode("real-secret"),
      "real-passphrase",
      salt,
      iv,
    );
    writeVector(
      outDir,
      cat,
      name,
      {
        category: cat,
        description: "Class identity: same wrong-passphrase blob must surface WrongPassphraseError in every lib",
        inputs: { passphrase: "wrong-passphrase", salt },
        expected: { error: "WrongPassphraseError" },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      bin,
    );
  }

  // BundleCorruptError — byte-driven (corrupt magic on RQE1).
  {
    const name = "bundle-corrupt";
    const salt = deterministicSalt(cat, name);
    const iv = deterministicIV(cat, name);
    const ok = await encryptWithIV(
      new TextEncoder().encode("payload"),
      "passphrase",
      salt,
      iv,
    );
    const bad = new Uint8Array(ok);
    bad[0] = 0x58; // 'X'
    writeVector(
      outDir,
      cat,
      "bundle-corrupt",
      {
        category: cat,
        description: "Magic flipped on the inner bundle → BundleCorruptError (not WrongPassphraseError)",
        inputs: { passphrase: "passphrase", salt },
        expected: { error: "BundleCorruptError" },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      bad,
    );
  }

  // UnsupportedSpecVersionError — wrong RQE1 magic byte 3 (1 → 2).
  {
    const name = "unsupported-spec-version";
    const salt = deterministicSalt(cat, name);
    const iv = deterministicIV(cat, name);
    const ok = await encryptWithIV(
      new TextEncoder().encode("payload"),
      "passphrase",
      salt,
      iv,
    );
    const bumped = new Uint8Array(ok);
    bumped[3] = 0x32; // '2'
    writeVector(
      outDir,
      cat,
      "unsupported-spec-version",
      {
        category: cat,
        description: "RQE1 envelope advertised as v2 — lib understands v1 only → UnsupportedSpecVersionError",
        inputs: { passphrase: "passphrase", salt },
        expected: { error: "UnsupportedSpecVersionError" },
        generated_by: tag,
        spec_version: SPEC_VERSION,
      },
      bumped,
    );
  }
}

// ---------- CLI entry ------------------------------------------------------

if (import.meta.main) {
  let outDir: string | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--out=")) outDir = arg.slice("--out=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: bun scripts/generate-test-vectors.ts [--out=<dir>]");
      console.log("env: VSYNC_VECTOR_SHA — pin the generated_by sha (default: git HEAD)");
      process.exit(0);
    }
  }
  await generateAllVectors({ outDir });
  console.log(`wrote vectors to ${outDir ?? DEFAULT_OUT}`);
}
