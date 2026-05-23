// Tests for `vsync rotate-passphrase` (v0.10 spec §3).
//
// The CLI walks the atomic flow:
//   1. decrypt current bundle with old passphrase
//   2. re-encrypt with new passphrase
//   3. PUT new bundle
//   4. PUT new pointer + manifest meta (ETag-conditional)
//   5. append audit row (action="rotate")
//
// Each step has a documented exit code. We mock S3 + audit via injectable
// hooks so the test never hits the network.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  main,
  __setS3Mock,
  __setAuditMock,
  type RotateS3Mock,
  type RotateAuditMock,
} from "../bin/rotate-passphrase";
import { saveConfigFile, type ConfigFile } from "../src/repoconfig";
import { setKey, deleteKey, generateKey } from "../src/keychain";
import { encrypt } from "../src/crypto";
import { wrap, serializeManifestMeta } from "../src/manifest";

const TEST_REPO = "vsync_rotate_pass_test";

const sampleConfig: ConfigFile = {
  version: 1,
  s3: {
    endpoint: "https://hel1.example.com",
    region: "auto",
    bucket: "personal-secrets",
    accessKeyId: "AKIA00000000",
    secretAccessKey: "secret",
    useSsl: true,
  },
  encryption: { salt: "abcdefghijklmnop" },
  prefix: "myapp/dev/",
  audit: { enabled: true },
};

let tmpRoot: string;
let prevXdg: string | undefined;
let prevSecretsRepo: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vsync-rotate-pass-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpRoot;
  prevSecretsRepo = process.env.SECRETS_SYNC_REPO;
  process.env.SECRETS_SYNC_REPO = TEST_REPO;
});

afterAll(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  if (prevSecretsRepo === undefined) delete process.env.SECRETS_SYNC_REPO;
  else process.env.SECRETS_SYNC_REPO = prevSecretsRepo;
  for (const env of ["dev"]) await deleteKey(TEST_REPO, env);
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  rmSync(join(tmpRoot, "vsync"), { recursive: true, force: true });
  for (const env of ["dev"]) await deleteKey(TEST_REPO, env);
  __setS3Mock(null);
  __setAuditMock(null);
});

// Capture
let originalExit: any;
let originalLog: any;
let originalErr: any;
let originalWrite: any;
let originalTty: any;
let stdoutBuf: string[];
let stderrBuf: string[];
let exitCalls: number[];

function captureSetup() {
  originalExit = process.exit;
  originalLog = console.log;
  originalErr = console.error;
  originalWrite = process.stdout.write;
  originalTty = (process.stdin as any).isTTY;
  stdoutBuf = [];
  stderrBuf = [];
  exitCalls = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`__exit:${code ?? 0}`);
  }) as any;
  console.log = (msg?: unknown) => {
    stdoutBuf.push(String(msg ?? ""));
  };
  console.error = (msg?: unknown) => {
    stderrBuf.push(String(msg ?? ""));
  };
  (process.stdout as any).write = (chunk: any) => {
    stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
}

function captureRestore() {
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalErr;
  (process.stdout as any).write = originalWrite;
  (process.stdin as any).isTTY = originalTty;
}

const joinStderr = () => stderrBuf.join("\n");

/**
 * Build an in-memory S3 mock pre-seeded with one bundle (encrypted under
 * `oldPassphrase` + the keychain key). The mock tracks all PUT calls so
 * tests can introspect what happened.
 */
async function makeS3Mock(opts: {
  oldPassphrase: string;
  key: string;
  salt: string;
  currentTs: string;
  /** Optional existing manifest meta (defaults to {gen:0}). */
  manifestMeta?: { gen?: number; prev_gen?: number; rotated_at?: string };
  /** Throw on a specific operation. */
  failOn?:
    | "putBundle"
    | "putPointer"
    | "putPointer-412"
    | "putManifestMeta"
    | "putManifestMeta-412";
}): Promise<RotateS3Mock & { puts: Array<{ key: string; bytes: number }> }> {
  const prefixKey = "myapp/dev/";
  const versionKey = `${prefixKey}versions/${opts.currentTs}.enc`;
  const pointerKey = `${prefixKey}latest`;
  const manifestMetaKey = `${prefixKey}latest.manifest`;

  // Pre-encrypt the current bundle
  const zipBytes = new TextEncoder().encode("pretend-zip-payload");
  const wrapped = wrap(opts.currentTs, zipBytes);
  // Bundle uses passphrase-derived envelope on top of AES key. The current
  // CLI uses the keychain key as the envelope password. For rotation, the
  // "passphrase" we rotate is also the keychain key (passphrase = the AES
  // key string from Bun.secrets). The spec calls it "passphrase".
  const encrypted = await encrypt(wrapped, opts.oldPassphrase, opts.salt);

  const store = new Map<string, Uint8Array | string>();
  store.set(versionKey, encrypted);
  store.set(pointerKey, opts.currentTs);
  // Default to gen=0 (pre-0.10 had no manifest meta — gen treated as 0)
  if (opts.manifestMeta !== undefined) {
    store.set(manifestMetaKey, serializeManifestMeta(opts.manifestMeta));
  }
  let etagSeq = 100;
  const etags = new Map<string, string>();
  etags.set(pointerKey, `etag-${etagSeq++}`);
  if (store.has(manifestMetaKey)) {
    etags.set(manifestMetaKey, `etag-${etagSeq++}`);
  }
  const puts: Array<{ key: string; bytes: number }> = [];

  return {
    async readPointer() {
      const v = store.get(pointerKey);
      if (v === undefined) return null;
      return { text: String(v), etag: etags.get(pointerKey) ?? "" };
    },
    async readManifestMeta() {
      const v = store.get(manifestMetaKey);
      if (v === undefined) return null;
      return { text: String(v), etag: etags.get(manifestMetaKey) ?? "" };
    },
    async readBundle(versionTs: string) {
      const k = `${prefixKey}versions/${versionTs}.enc`;
      const v = store.get(k);
      if (v === undefined) throw new Error(`mock S3: not found ${k}`);
      return v as Uint8Array;
    },
    async putBundle(versionTs, bytes) {
      if (opts.failOn === "putBundle") {
        throw Object.assign(new Error("mock: S3 PUT bundle failed"), { kind: "putBundle" });
      }
      const k = `${prefixKey}versions/${versionTs}.enc`;
      store.set(k, bytes);
      puts.push({ key: k, bytes: bytes.byteLength });
    },
    async putPointer(newTs, condition) {
      if (opts.failOn === "putPointer-412") {
        const err: any = new Error("mock: precondition failed");
        err.status = 412;
        throw err;
      }
      if (opts.failOn === "putPointer") {
        const err: any = new Error("mock: S3 PUT pointer failed");
        err.status = 500;
        throw err;
      }
      const cur = etags.get(pointerKey);
      if (condition?.ifMatch && condition.ifMatch !== cur) {
        const err: any = new Error("mock: pointer etag mismatch");
        err.status = 412;
        throw err;
      }
      store.set(pointerKey, newTs);
      etags.set(pointerKey, `etag-${etagSeq++}`);
      puts.push({ key: pointerKey, bytes: newTs.length });
    },
    async putManifestMeta(json, condition) {
      if (opts.failOn === "putManifestMeta-412") {
        const err: any = new Error("mock: manifest meta precondition failed");
        err.status = 412;
        throw err;
      }
      if (opts.failOn === "putManifestMeta") {
        const err: any = new Error("mock: S3 PUT manifest meta failed");
        err.status = 500;
        throw err;
      }
      const cur = etags.get(manifestMetaKey);
      if (condition?.ifMatch && condition.ifMatch !== cur) {
        const err: any = new Error("mock: manifest meta etag mismatch");
        err.status = 412;
        throw err;
      }
      if (condition?.ifNoneMatch === "*" && cur) {
        const err: any = new Error("mock: object already exists");
        err.status = 412;
        throw err;
      }
      store.set(manifestMetaKey, json);
      etags.set(manifestMetaKey, `etag-${etagSeq++}`);
      puts.push({ key: manifestMetaKey, bytes: json.length });
    },
    puts,
  };
}

function makeAuditMock(opts: { failWith?: Error } = {}): RotateAuditMock & {
  appended: Array<{ action: string; meta: string }>;
} {
  const appended: Array<{ action: string; meta: string }> = [];
  return {
    async append(row) {
      if (opts.failWith) throw opts.failWith;
      appended.push({ action: row.action, meta: row.meta });
    },
    appended,
  };
}

describe("rotate-passphrase — happy path", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("atomic flow: decrypt → re-encrypt → put bundle → put pointer → audit", async () => {
    const key = generateKey(); // base64 AES key — used as the envelope password
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const oldTs = "20260523-100000";
    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: oldTs,
    });
    const audit = makeAuditMock();
    __setS3Mock(s3);
    __setAuditMock(audit);

    (process.stdin as any).isTTY = false;
    try {
      await main([
        "--env=dev",
        `--old-passphrase=${key}`,
        "--new-passphrase=abrandnewpassphrase",
      ]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }

    // PUT bundle was called with a new ts (not the old one)
    const bundlePut = s3.puts.find((p) => p.key.includes("/versions/"));
    expect(bundlePut).toBeDefined();
    expect(bundlePut!.key).not.toContain(oldTs);

    // PUT pointer was called
    expect(s3.puts.some((p) => p.key.endsWith("/latest"))).toBe(true);

    // PUT manifest meta was called
    expect(s3.puts.some((p) => p.key.endsWith("/latest.manifest"))).toBe(true);

    // Audit row for "rotate" was appended
    expect(audit.appended.length).toBe(1);
    expect(audit.appended[0].action).toBe("rotate");
    const meta = JSON.parse(audit.appended[0].meta);
    expect(meta.event).toBe("rotate");
    expect(meta.gen).toBe(1);
    expect(meta.prev_gen).toBe(0);

    // Stderr has next-steps message
    const err = joinStderr();
    expect(err).toMatch(/Bundle re-encrypted|gen=/);
    expect(err).toMatch(/Next steps|VSYNC_PASSPHRASE/);
    expect(err).toMatch(/race window|operator/i);
  });

  test("--note and --meta are merged into the rotation audit meta", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: "20260523-100000",
    });
    const audit = makeAuditMock();
    __setS3Mock(s3);
    __setAuditMock(audit);

    (process.stdin as any).isTTY = false;
    try {
      await main([
        "--env=dev",
        `--old-passphrase=${key}`,
        "--new-passphrase=abrandnewpassphrase",
        "--note=quarterly rotation",
        "--meta=ticket=SEC-42",
      ]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }

    expect(audit.appended.length).toBe(1);
    const meta = JSON.parse(audit.appended[0].meta);
    expect(meta.event).toBe("rotate");
    expect(meta.gen).toBe(1);
    expect(meta.prev_gen).toBe(0);
    expect(meta.note).toBe("quarterly rotation");
    expect(meta.ticket).toBe("SEC-42");
  });

  test("--no-audit skips audit append entirely (still exit 0)", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: "20260523-100000",
    });
    const audit = makeAuditMock();
    __setS3Mock(s3);
    __setAuditMock(audit);

    (process.stdin as any).isTTY = false;
    try {
      await main([
        "--env=dev",
        `--old-passphrase=${key}`,
        "--new-passphrase=abrandnewpassphrase",
        "--no-audit",
      ]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    expect(audit.appended.length).toBe(0);
  });
});

describe("rotate-passphrase — gen counter", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("first rotation on a pre-0.10 bundle (no manifest meta) → gen=1, prev_gen=0", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: "20260523-100000",
      // No manifestMeta — pre-0.10 bundle
    });
    const audit = makeAuditMock();
    __setS3Mock(s3);
    __setAuditMock(audit);

    (process.stdin as any).isTTY = false;
    try {
      await main([
        "--env=dev",
        `--old-passphrase=${key}`,
        "--new-passphrase=newpassphrase!",
      ]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const meta = JSON.parse(audit.appended[0].meta);
    expect(meta.gen).toBe(1);
    expect(meta.prev_gen).toBe(0);
  });

  test("subsequent rotation with existing gen=3 → gen=4, prev_gen=3", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: "20260523-100000",
      manifestMeta: { gen: 3, prev_gen: 2, rotated_at: "2026-01-01T00:00:00Z" },
    });
    const audit = makeAuditMock();
    __setS3Mock(s3);
    __setAuditMock(audit);

    (process.stdin as any).isTTY = false;
    try {
      await main([
        "--env=dev",
        `--old-passphrase=${key}`,
        "--new-passphrase=newpassphrase!",
      ]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const meta = JSON.parse(audit.appended[0].meta);
    expect(meta.gen).toBe(4);
    expect(meta.prev_gen).toBe(3);
  });
});

describe("rotate-passphrase — failure modes", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("missing config → exit 5 with init/import hint", async () => {
    __setS3Mock({} as any); // never called
    __setAuditMock(makeAuditMock());
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main([
        "--env=dev",
        "--old-passphrase=x",
        "--new-passphrase=newpassphrase!",
      ]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:5");
    }
    expect(threw).toBe(true);
    expect(joinStderr()).toMatch(/no config|missing config/i);
  });

  test("missing --env → exit 1", async () => {
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main([
        "--old-passphrase=x",
        "--new-passphrase=newpassphrase!",
      ]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    }
    expect(threw).toBe(true);
    expect(joinStderr()).toMatch(/--env/);
  });

  test("missing --old-passphrase on non-TTY → exit 1", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main([
        "--env=dev",
        "--new-passphrase=newpassphrase!",
      ]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    }
    expect(threw).toBe(true);
    expect(joinStderr()).toMatch(/old.passphrase|TTY/i);
  });

  test("wrong old passphrase → exit 1, no S3 writes", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: "20260523-100000",
    });
    const audit = makeAuditMock();
    __setS3Mock(s3);
    __setAuditMock(audit);

    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main([
        "--env=dev",
        "--old-passphrase=totallywrong",
        "--new-passphrase=newpassphrase!",
      ]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    }
    expect(threw).toBe(true);
    // No PUT to S3 should have happened
    expect(s3.puts.length).toBe(0);
    expect(audit.appended.length).toBe(0);
    expect(joinStderr()).toMatch(/old passphrase|decrypt/i);
  });

  test("new passphrase too short (<12 chars) → exit 1", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: "20260523-100000",
    });
    __setS3Mock(s3);
    __setAuditMock(makeAuditMock());

    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main([
        "--env=dev",
        `--old-passphrase=${key}`,
        "--new-passphrase=short",
      ]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    }
    expect(threw).toBe(true);
    expect(s3.puts.length).toBe(0);
  });

  test("S3 PUT bundle fails → exit 2", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: "20260523-100000",
      failOn: "putBundle",
    });
    __setS3Mock(s3);
    __setAuditMock(makeAuditMock());

    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main([
        "--env=dev",
        `--old-passphrase=${key}`,
        "--new-passphrase=newpassphrase!",
      ]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:2");
    }
    expect(threw).toBe(true);
    expect(joinStderr()).toMatch(/bundle|S3|upload/i);
  });

  test("manifest swap 412 conflict → exit 3 with concurrent-rotation hint", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: "20260523-100000",
      failOn: "putPointer-412",
    });
    __setS3Mock(s3);
    __setAuditMock(makeAuditMock());

    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main([
        "--env=dev",
        `--old-passphrase=${key}`,
        "--new-passphrase=newpassphrase!",
      ]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:3");
    }
    expect(threw).toBe(true);
    expect(joinStderr()).toMatch(/another rotation|in flight|412|concurrent/i);
  });

  test("manifest swap non-412 failure → exit 3 with retry hint", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: "20260523-100000",
      failOn: "putPointer",
    });
    __setS3Mock(s3);
    __setAuditMock(makeAuditMock());

    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main([
        "--env=dev",
        `--old-passphrase=${key}`,
        "--new-passphrase=newpassphrase!",
      ]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:3");
    }
    expect(threw).toBe(true);
    expect(joinStderr()).toMatch(/safe to retry|old passphrase still|manifest swap/i);
  });

  test("audit append failure after rotation success → exit 4 with manual-row block", async () => {
    const key = generateKey();
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", key);

    const s3 = await makeS3Mock({
      oldPassphrase: key,
      key,
      salt: sampleConfig.encryption.salt,
      currentTs: "20260523-100000",
    });
    const audit = makeAuditMock({ failWith: new Error("audit S3 down") });
    __setS3Mock(s3);
    __setAuditMock(audit);

    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main([
        "--env=dev",
        `--old-passphrase=${key}`,
        "--new-passphrase=newpassphrase!",
      ]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:4");
    }
    expect(threw).toBe(true);

    // Manifest swap DID happen (bundle and pointer are PUT)
    expect(s3.puts.some((p) => p.key.endsWith("/latest"))).toBe(true);

    // Stderr has manual-row block to copy-paste
    const err = joinStderr();
    expect(err).toMatch(/manual audit|copy.paste|append.*manually/i);
    // The CSV line should include 'rotate' as the action
    expect(err).toContain("rotate");
  });
});
