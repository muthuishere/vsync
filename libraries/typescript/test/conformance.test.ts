// Cross-language conformance suite — walks the shared corpus at
// `docs/specs/test-vectors/<category>/*.json` and runs a category-
// specific assertion. Mirrors libraries/python/tests/conformance/.
//
// v0.11 §7 / §5: error class identity matches on the `name` property
// (not on a generic Error catch).

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decryptRqe1 } from "../src/crypto.js";
import { unwrapRqem0001, verifyAgainstRemoteTs } from "../src/manifest.js";
import { decodeConfigBlob } from "../src/config-blob.js";
import {
  __setS3Fetcher,
  __resetSingleton,
  open,
  Vsync,
} from "../src/client.js";
import { resolveBootstrapInputs } from "../src/sources.js";
import {
  BundleCorruptError,
  ConfigMissingError,
  ConfigUnsupportedVersionError,
  ManifestNotFoundError,
  S3UnreachableError,
  UnsupportedSpecVersionError,
  VSyncError,
  WrongPassphraseError,
} from "../src/errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// libraries/typescript/test/conformance.test.ts → repo root is 3 up.
const VECTORS_DIR = process.env.VSYNC_TEST_VECTORS_DIR
  ? resolve(process.env.VSYNC_TEST_VECTORS_DIR)
  : resolve(__dirname, "..", "..", "..", "docs", "specs", "test-vectors");

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

interface VectorMeta {
  category: Category;
  description: string;
  inputs: Record<string, unknown>;
  expected: Record<string, unknown>;
  generated_by: string;
  spec_version: string;
}

interface Vector {
  category: Category;
  name: string;
  meta: VectorMeta;
  bin: Buffer | null;
}

function iterCategory(cat: Category): Vector[] {
  const dir = join(VECTORS_DIR, cat);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: Vector[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const jsonPath = join(dir, entry);
    const meta = JSON.parse(readFileSync(jsonPath, "utf8")) as VectorMeta;
    const binPath = join(dir, entry.replace(/\.json$/, ".bin"));
    const bin = existsSync(binPath) ? readFileSync(binPath) : null;
    out.push({
      category: cat,
      name: entry.replace(/\.json$/, ""),
      meta,
      bin,
    });
  }
  return out;
}

function iterAll(): Vector[] {
  return CATEGORIES.flatMap(iterCategory);
}

// Class identity table — names match v0.12 §11 exactly.
const ERROR_CLASS: Record<string, typeof VSyncError> = {
  ConfigMissingError,
  ConfigUnsupportedVersionError,
  S3UnreachableError,
  ManifestNotFoundError,
  WrongPassphraseError,
  BundleCorruptError,
  UnsupportedSpecVersionError,
};

async function assertRaisesNamed(
  expectedName: string,
  fn: () => unknown,
): Promise<void> {
  const cls = ERROR_CLASS[expectedName];
  if (cls === undefined) {
    throw new Error(`unknown canonical error name ${JSON.stringify(expectedName)} in vector`);
  }
  let caught: unknown = null;
  try {
    const r = fn();
    if (r instanceof Promise) await r;
  } catch (e) {
    caught = e;
  }
  if (caught === null) {
    throw new Error(`expected ${expectedName}, no exception raised`);
  }
  if (!(caught instanceof VSyncError)) {
    throw new Error(
      `expected ${expectedName}, got non-VSyncError ${String((caught as Error).constructor?.name ?? typeof caught)}: ${(caught as Error).message}`,
    );
  }
  if (caught.name !== expectedName) {
    throw new Error(
      `expected ${expectedName}, got ${caught.name}: ${caught.message}`,
    );
  }
}

// ─── Category dispatchers ───────────────────────────────────────────────

async function runRqe1Positive(v: Vector): Promise<void> {
  expect(v.bin, `${v.category}/${v.name}: .bin required for positive RQE1`).not.toBeNull();
  const passphrase = v.meta.inputs.passphrase as string;
  const salt = v.meta.inputs.salt as string;
  const out = await decryptRqe1(v.bin!, passphrase, salt);
  const expectedHex = v.meta.expected.plaintext_hex as string;
  expect(Buffer.from(out).toString("hex")).toBe(expectedHex);
}

async function runRqe1Negative(v: Vector): Promise<void> {
  expect(v.bin, `${v.category}/${v.name}: .bin required for negative RQE1`).not.toBeNull();
  const passphrase = v.meta.inputs.passphrase as string;
  const salt = v.meta.inputs.salt as string;
  const err = v.meta.expected.error as string;
  await assertRaisesNamed(err, () => decryptRqe1(v.bin!, passphrase, salt));
}

async function runManifest(v: Vector): Promise<void> {
  expect(v.bin).not.toBeNull();
  const expected = v.meta.expected;
  const err = expected.error as string | undefined;
  const remoteTs = v.meta.inputs.remote_ts as string | undefined;
  if (err) {
    if (remoteTs !== undefined) {
      await assertRaisesNamed(err, () => verifyAgainstRemoteTs(v.bin!, remoteTs));
    } else {
      await assertRaisesNamed(err, () => unwrapRqem0001(v.bin!));
    }
    return;
  }
  const { ts, payload } = verifyAgainstRemoteTs(v.bin!, remoteTs as string);
  expect(ts).toBe(expected.embedded_ts);
  expect(Buffer.from(payload).toString("hex")).toBe(expected.payload_hex);
}

async function runConfigBlob(v: Vector): Promise<void> {
  expect(v.bin).not.toBeNull();
  const err = v.meta.expected.error as string | undefined;
  if (err) {
    await assertRaisesNamed(err, () => decodeConfigBlob(v.bin!));
    return;
  }
  const cfg = decodeConfigBlob(v.bin!);
  const want = v.meta.expected.config_json as Record<string, unknown>;
  const got: Record<string, unknown> = {
    v: cfg.v,
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    prefix: cfg.prefix,
    env: cfg.env,
    salt: cfg.salt,
    iterations: cfg.iterations,
  };
  expect(got).toEqual(want);
}

interface FallbackQueryResult {
  key: string;
  value: string | null;
  source: string;
  has: boolean;
}

async function runFallbackChain(v: Vector): Promise<void> {
  const inputs = v.meta.inputs;
  const vault = (inputs.vault as Record<string, string> | null) ?? {};
  const envOverrides = (inputs.env as Record<string, string> | null) ?? {};
  const defaults = (inputs.defaults as Record<string, string> | null) ?? {};
  const queries = (inputs.queries as string[]) ?? [];
  const expected = (v.meta.expected.results as FallbackQueryResult[]) ?? [];

  // Apply the simulated process env. Capture + restore.
  const restore: Record<string, string | undefined> = {};
  const touchedKeys = new Set<string>([
    ...Object.keys(envOverrides),
    ...expected.map((r) => r.key),
  ]);
  for (const k of touchedKeys) {
    restore[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, val] of Object.entries(envOverrides)) {
    process.env[k] = val;
  }
  try {
    const handle = Vsync._fromVault({ kv: vault, defaults });
    try {
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const w = expected[i];
        expect(handle.get(q), `${v.name}: get(${q})`).toBe(w.value);
        expect(handle.source(q), `${v.name}: source(${q})`).toBe(w.source);
        expect(handle.has(q), `${v.name}: has(${q})`).toBe(w.has);
      }
    } finally {
      await handle.close();
    }
  } finally {
    for (const [k, prev] of Object.entries(restore)) {
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

async function runAssetPath(v: Vector): Promise<void> {
  expect(v.bin, `${v.name}: asset bytes (.bin) required`).not.toBeNull();
  const inputs = v.meta.inputs;
  const key = inputs.key as string;
  const handle = Vsync._fromVault({ assets: { [key]: new Uint8Array(v.bin!) } });
  let path: string | null = null;
  try {
    const back = handle.assetBytes(key);
    expect(Buffer.from(back).toString("hex")).toBe(v.meta.expected.bytes_hex);
    path = await handle.assetPath(key);
    const onDisk = readFileSync(path);
    expect(onDisk.equals(v.bin!)).toBe(true);
    if (process.platform !== "win32") {
      const expectedOctal = (v.meta.expected.mode_octal as string).padStart(4, "0");
      const got = (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
      expect(got).toBe(expectedOctal);
    }
  } finally {
    await handle.close();
    // close() must have unlinked the tempdir.
    if (path !== null) expect(existsSync(path)).toBe(false);
  }
}

function mintMinimalConfigBlob(): string {
  const inner = {
    v: 1,
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "b",
    accessKeyId: "k",
    secretAccessKey: "s",
    prefix: "p/",
    env: "test",
    salt: "AAAAAAAAAAAAAAAAAAAAAA==",
    iterations: 600000,
  };
  const body = gzipSync(Buffer.from(JSON.stringify(inner), "utf8"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `vsync-cfg-v1:${body}`;
}

async function runErrorTaxonomy(v: Vector): Promise<void> {
  const err = v.meta.expected.error as string;
  const name = v.name;

  if (name === "config-missing") {
    // Drive via the bootstrap layer with an explicit empty env.
    await assertRaisesNamed(err, () => resolveBootstrapInputs({}));
    return;
  }

  if (name === "s3-unreachable" || name === "manifest-not-found") {
    // Inject a fetcher that raises the right error and exercise open().
    const prev = {
      VSYNC_CONFIG: process.env.VSYNC_CONFIG,
      VSYNC_PASSPHRASE: process.env.VSYNC_PASSPHRASE,
    };
    process.env.VSYNC_CONFIG = mintMinimalConfigBlob();
    process.env.VSYNC_PASSPHRASE = "pp";
    __setS3Fetcher(async () => {
      if (name === "manifest-not-found") {
        throw new ManifestNotFoundError("simulated 404 on <prefix>manifest");
      }
      throw new S3UnreachableError("simulated network failure");
    });
    __resetSingleton();
    try {
      await assertRaisesNamed(err, () => open());
    } finally {
      __setS3Fetcher(null);
      __resetSingleton();
      if (prev.VSYNC_CONFIG === undefined) delete process.env.VSYNC_CONFIG;
      else process.env.VSYNC_CONFIG = prev.VSYNC_CONFIG;
      if (prev.VSYNC_PASSPHRASE === undefined) delete process.env.VSYNC_PASSPHRASE;
      else process.env.VSYNC_PASSPHRASE = prev.VSYNC_PASSPHRASE;
    }
    return;
  }

  if (name === "config-unsupported-version") {
    expect(v.bin).not.toBeNull();
    await assertRaisesNamed(err, () => decodeConfigBlob(v.bin!));
    return;
  }

  if (
    name === "wrong-passphrase" ||
    name === "bundle-corrupt" ||
    name === "unsupported-spec-version"
  ) {
    expect(v.bin).not.toBeNull();
    const passphrase = v.meta.inputs.passphrase as string;
    const salt = v.meta.inputs.salt as string;
    await assertRaisesNamed(err, () => decryptRqe1(v.bin!, passphrase, salt));
    return;
  }

  throw new Error(`error-taxonomy: no dispatcher branch for name ${JSON.stringify(name)}`);
}

// ─── Vitest entry points ────────────────────────────────────────────────

beforeEach(() => {
  __setS3Fetcher(null);
  __resetSingleton();
});

afterEach(() => {
  __setS3Fetcher(null);
  __resetSingleton();
});

describe("conformance — corpus discovery", () => {
  test("corpus is non-empty", () => {
    expect(iterAll().length).toBeGreaterThanOrEqual(20);
  });

  test("all categories present", () => {
    for (const cat of CATEGORIES) {
      const list = iterCategory(cat);
      expect(list.length, `category ${cat} should have at least one vector`).toBeGreaterThan(0);
    }
  });
});

for (const cat of CATEGORIES) {
  describe(`conformance — ${cat}`, () => {
    const vectors = iterCategory(cat);
    for (const v of vectors) {
      test(v.name, async () => {
        if (cat === "rqe1-decrypt") return runRqe1Positive(v);
        if (cat === "rqe1-decrypt-error") return runRqe1Negative(v);
        if (cat === "rqem0001-manifest") return runManifest(v);
        if (cat === "config-blob") return runConfigBlob(v);
        if (cat === "fallback-chain") return runFallbackChain(v);
        if (cat === "asset-path") return runAssetPath(v);
        if (cat === "error-taxonomy") return runErrorTaxonomy(v);
      });
    }
  });
}
