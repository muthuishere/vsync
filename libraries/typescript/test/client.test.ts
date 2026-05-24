import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { gzipSync } from "node:zlib";
import {
  Vsync,
  open,
  __setS3Fetcher,
  __resetSingleton,
  type S3FetchResult,
  type VsyncConfigSnapshot,
} from "../src/client.js";
import { encryptRqe1ForTest } from "../src/crypto.js";
import {
  BundleCorruptError,
  ConfigMissingError,
  ManifestNotFoundError,
  S3UnreachableError,
  WrongPassphraseError,
} from "../src/errors.js";

const SALT = "20ZiDJFKLLkDsDUiWSMn3g==";
const PASSPHRASE = "the-passphrase";

function buildManifest(ts: string): Uint8Array {
  const magic = Buffer.from("RQEM0001", "ascii");
  return new Uint8Array(Buffer.concat([magic, Buffer.from(ts, "ascii"), Buffer.from("ignored", "ascii")]));
}

async function buildBundle(pt: Buffer): Promise<Uint8Array> {
  return await encryptRqe1ForTest(pt, PASSPHRASE, SALT);
}

function base64urlNoPad(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mintConfigBlob(env: string, extra: Record<string, unknown> = {}): string {
  const inner = {
    v: 1,
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "b",
    accessKeyId: "k",
    secretAccessKey: "s",
    prefix: "myapp/dev/",
    env,
    salt: SALT,
    iterations: 600000,
    ...extra,
  };
  return "vsync-cfg-v1:" + base64urlNoPad(gzipSync(Buffer.from(JSON.stringify(inner), "utf8")));
}

const prevEnv = {
  VSYNC_CONFIG: process.env.VSYNC_CONFIG,
  VSYNC_PASSPHRASE: process.env.VSYNC_PASSPHRASE,
};

beforeEach(() => {
  __setS3Fetcher(null);
  __resetSingleton();
});

afterEach(() => {
  __setS3Fetcher(null);
  __resetSingleton();
  if (prevEnv.VSYNC_CONFIG === undefined) delete process.env.VSYNC_CONFIG;
  else process.env.VSYNC_CONFIG = prevEnv.VSYNC_CONFIG;
  if (prevEnv.VSYNC_PASSPHRASE === undefined) delete process.env.VSYNC_PASSPHRASE;
  else process.env.VSYNC_PASSPHRASE = prevEnv.VSYNC_PASSPHRASE;
});

function fromVault(opts: Parameters<typeof Vsync._fromVault>[0]): Vsync {
  return Vsync._fromVault(opts);
}

describe("Vsync — fallback chain (v0.12 §5)", () => {
  test("vault hit: get returns vault value; source = 'vault'", () => {
    const v = fromVault({ kv: { DATABASE_URL: "postgres://vault" } });
    try {
      expect(v.get("DATABASE_URL")).toBe("postgres://vault");
      expect(v.source("DATABASE_URL")).toBe("vault");
      expect(v.has("DATABASE_URL")).toBe(true);
    } finally {
      v.close();
    }
  });

  test("env hit: vault miss, env var present; source = 'env'", () => {
    const prev = process.env.HOST;
    try {
      process.env.HOST = "from-env";
      const v = fromVault({ kv: {} });
      expect(v.get("HOST")).toBe("from-env");
      expect(v.source("HOST")).toBe("env");
      expect(v.has("HOST")).toBe(true);
      v.close();
    } finally {
      if (prev === undefined) delete process.env.HOST;
      else process.env.HOST = prev;
    }
  });

  test("default hit: vault + env miss, defaults present; source = 'default'", () => {
    const prev = process.env.PORT;
    delete process.env.PORT;
    try {
      const v = fromVault({ kv: {}, defaults: { PORT: "8080" } });
      expect(v.get("PORT")).toBe("8080");
      expect(v.source("PORT")).toBe("default");
      expect(v.has("PORT")).toBe(true);
      v.close();
    } finally {
      if (prev !== undefined) process.env.PORT = prev;
    }
  });

  test("missing: nothing matches; get→null, source='missing', has=false", () => {
    const v = fromVault({});
    const key = "NEVER_SET_THIS_KEY_XYZ123";
    delete process.env[key];
    expect(v.get(key)).toBeNull();
    expect(v.source(key)).toBe("missing");
    expect(v.has(key)).toBe(false);
    v.close();
  });

  test("vault wins over env over default for the same key", () => {
    const key = "OVERRIDE_CHAIN";
    const prev = process.env[key];
    try {
      process.env[key] = "env";
      const v = fromVault({ kv: { [key]: "vault" }, defaults: { [key]: "default" } });
      expect(v.source(key)).toBe("vault");
      v.close();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });
});

describe("Vsync — assets", () => {
  test("assetBytes returns the raw bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const v = fromVault({ assets: { "svc.json": bytes } });
    try {
      const out = v.assetBytes("svc.json");
      expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    } finally {
      v.close();
    }
  });

  test("assetBytes throws when key absent", () => {
    const v = fromVault({});
    expect(() => v.assetBytes("nope")).toThrow();
    v.close();
  });

  test("assetBytes falls back to kv (utf8-encoded) when not in assets", () => {
    const v = fromVault({ kv: { CERT: "-----BEGIN CERT-----\n" } });
    try {
      const out = v.assetBytes("CERT");
      expect(Buffer.from(out).toString("utf8")).toBe("-----BEGIN CERT-----\n");
    } finally {
      v.close();
    }
  });

  test("assetPath materializes to a 0600 file, repeat calls cache", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const v = fromVault({ assets: { x: bytes } });
    try {
      const path1 = await v.assetPath("x");
      const path2 = await v.assetPath("x");
      expect(path2).toBe(path1);
      const { readFileSync, statSync } = await import("node:fs");
      expect(Array.from(readFileSync(path1))).toEqual([9, 8, 7]);
      if (process.platform !== "win32") {
        expect(statSync(path1).mode & 0o777).toBe(0o600);
      }
    } finally {
      await v.close();
    }
  });
});

describe("Vsync — generation + lifecycle", () => {
  test("generation returns the integer passed in", () => {
    const v = fromVault({ generation: 7 });
    expect(v.generation()).toBe(7);
    v.close();
  });

  test("close is idempotent", async () => {
    const v = fromVault({ kv: { K: "v" } });
    await v.close();
    await v.close();
  });

  test("operations after close throw", async () => {
    const v = fromVault({ kv: { K: "v" } });
    await v.close();
    expect(() => v.get("K")).toThrow(/closed/i);
    expect(() => v.has("K")).toThrow(/closed/i);
    expect(() => v.source("K")).toThrow(/closed/i);
  });

  test("toJSON/util.inspect return a redacted form", () => {
    const v = fromVault({ kv: { SECRET: "p@ss" }, generation: 3, env: "prod" });
    try {
      const j = JSON.stringify(v);
      expect(j).not.toContain("p@ss");
      expect(j).toMatch(/redacted|vsync/i);
    } finally {
      v.close();
    }
  });
});

describe("open() — end-to-end with mocked S3 fetcher", () => {
  async function setup(payload: Buffer, env = "dev"): Promise<{ ts: string }> {
    const ts = "20260524-101010";
    const manifest = buildManifest(ts);
    // The bundle's plaintext is the JSON vault payload, NOT a wrapped
    // RQEM0001 envelope. Matches Python's _parse_vault_payload contract
    // and the v0.12 §6 wire-format description.
    const bundle = await encryptRqe1ForTest(payload, PASSPHRASE, SALT);
    const fetcher = async (_cfg: VsyncConfigSnapshot): Promise<S3FetchResult> => ({
      manifestBytes: manifest,
      bundleBytes: bundle,
      generation: 5,
    });
    __setS3Fetcher(fetcher);
    process.env.VSYNC_CONFIG = mintConfigBlob(env);
    process.env.VSYNC_PASSPHRASE = PASSPHRASE;
    return { ts };
  }

  test("end-to-end: open → get vault key", async () => {
    const payload = Buffer.from(JSON.stringify({ kv: { DATABASE_URL: "postgres://x" } }));
    await setup(payload);
    const v = await open();
    try {
      expect(v.get("DATABASE_URL")).toBe("postgres://x");
      expect(v.source("DATABASE_URL")).toBe("vault");
      expect(v.generation()).toBe(5);
    } finally {
      await v.close();
    }
  });

  test("end-to-end: flat-object vault is treated as kv", async () => {
    const payload = Buffer.from(JSON.stringify({ FLAT_KEY: "flat-value" }));
    await setup(payload);
    const v = await open();
    try {
      expect(v.get("FLAT_KEY")).toBe("flat-value");
    } finally {
      await v.close();
    }
  });

  test("end-to-end: with defaults option", async () => {
    // Padded so envelope clears the 48-byte structural floor.
    const payload = Buffer.from(JSON.stringify({ kv: { _padding: "x".repeat(48) } }));
    await setup(payload);
    const v = await open({ defaults: { PORT: "8080" } });
    try {
      delete process.env.PORT;
      expect(v.get("PORT")).toBe("8080");
      expect(v.source("PORT")).toBe("default");
    } finally {
      await v.close();
    }
  });

  test("fetcher raising ManifestNotFoundError → surfaces verbatim", async () => {
    process.env.VSYNC_CONFIG = mintConfigBlob("dev");
    process.env.VSYNC_PASSPHRASE = PASSPHRASE;
    __setS3Fetcher(async () => {
      throw new ManifestNotFoundError("simulated 404");
    });
    await expect(open()).rejects.toBeInstanceOf(ManifestNotFoundError);
  });

  test("fetcher raising S3UnreachableError → surfaces verbatim", async () => {
    process.env.VSYNC_CONFIG = mintConfigBlob("dev");
    process.env.VSYNC_PASSPHRASE = PASSPHRASE;
    __setS3Fetcher(async () => {
      throw new S3UnreachableError("simulated network");
    });
    await expect(open()).rejects.toBeInstanceOf(S3UnreachableError);
  });

  test("fetcher raising a plain Error → wrapped as S3UnreachableError", async () => {
    process.env.VSYNC_CONFIG = mintConfigBlob("dev");
    process.env.VSYNC_PASSPHRASE = PASSPHRASE;
    __setS3Fetcher(async () => {
      throw new Error("random failure");
    });
    await expect(open()).rejects.toBeInstanceOf(S3UnreachableError);
  });

  test("wrong passphrase → WrongPassphraseError", async () => {
    // Payload large enough that envelope ≥ 48-byte structural floor.
    const payload = Buffer.from(JSON.stringify({ kv: { K: "v".repeat(48) } }));
    await setup(payload);
    process.env.VSYNC_PASSPHRASE = "WRONG";
    await expect(open()).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  test("malformed manifest envelope → BundleCorruptError", async () => {
    // Anti-rollback for the manifest itself: a manifest blob with a
    // wrong magic prefix must be rejected before we trust its ts.
    const garbage = Buffer.alloc(40, 0); // 40 zeros — no RQEM0001 magic
    const bundle = await encryptRqe1ForTest(Buffer.from(JSON.stringify({})), PASSPHRASE, SALT);
    __setS3Fetcher(async () => ({
      manifestBytes: new Uint8Array(garbage),
      bundleBytes: bundle,
      generation: 0,
    }));
    process.env.VSYNC_CONFIG = mintConfigBlob("dev");
    process.env.VSYNC_PASSPHRASE = PASSPHRASE;
    await expect(open()).rejects.toBeInstanceOf(BundleCorruptError);
  });

  test("missing VSYNC_CONFIG → ConfigMissingError", async () => {
    delete process.env.VSYNC_CONFIG;
    process.env.VSYNC_PASSPHRASE = "x";
    await expect(open()).rejects.toBeInstanceOf(ConfigMissingError);
  });

  test("vault payload not valid JSON → BundleCorruptError", async () => {
    const payload = Buffer.from("not json at all — and padded to clear the 48-byte envelope floor");
    await setup(payload);
    await expect(open()).rejects.toBeInstanceOf(BundleCorruptError);
  });
});
