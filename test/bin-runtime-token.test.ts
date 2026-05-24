// Tests for `vsync runtime-token` (v0.10 spec §2).
//
// The mint path produces a `vsync-cfg-v1:<base64url-no-pad(gzip(JSON))>` blob
// on stdout, validates creds against S3 by default, and supports
// --no-validate / --json. Tests mock S3 via the injectable validator hook
// (`__setValidator`) so they don't hit the network.

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
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

import { main, __setValidator } from "../bin/runtime-token";
import { saveProfile, type Profile } from "../src/profiles";
import { saveConfigFile, type ConfigFile } from "../src/repoconfig";
import { setKey, deleteKey, generateKey } from "../src/keychain";

const TEST_REPO = "vsync_runtime_token_test";
const CFG_BLOB_PREFIX = "vsync-cfg-v1:";

const sampleProfile: Profile = {
  version: 1,
  endpoint: "https://hel1.example.com",
  region: "auto",
  bucket: "personal-secrets",
  prefix: "myapp/",
  accessKeyId: "AKIAPROFILE000000000",
  secretAccessKey: "profile-secret-key",
};

const sampleConfig: ConfigFile = {
  version: 1,
  s3: {
    endpoint: "https://hel1.example.com",
    region: "auto",
    bucket: "personal-secrets",
    accessKeyId: "AKIACONFIG0000000000",
    secretAccessKey: "config-secret-key",
    useSsl: true,
  },
  encryption: { salt: "abcdefghijklmnop" },
  initProfile: "hetzner",
  prefix: "myapp/dev/",
};

let tmpRoot: string;
let prevXdg: string | undefined;
let prevSecretsRepo: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vsync-runtime-token-"));
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
  for (const env of ["dev", "prod"]) await deleteKey(TEST_REPO, env);
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  rmSync(join(tmpRoot, "vsync"), { recursive: true, force: true });
  for (const env of ["dev", "prod"]) await deleteKey(TEST_REPO, env);
  __setValidator(null);
});

// Output capture
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

function joinStdout(): string {
  return stdoutBuf.join("");
}

function joinStderr(): string {
  return stderrBuf.join("\n");
}

function decodeBlob(out: string): {
  v: number;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  env: string;
  salt: string;
  iterations: number;
} {
  const trimmed = out.trim();
  expect(trimmed.startsWith(CFG_BLOB_PREFIX)).toBe(true);
  const b64 = trimmed.slice(CFG_BLOB_PREFIX.length);
  // base64url, no padding — reject standard base64 alphabet
  expect(/^[A-Za-z0-9_-]+$/.test(b64)).toBe(true);
  expect(b64.endsWith("=")).toBe(false);
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const gz = Buffer.from(std, "base64");
  const json = gunzipSync(gz).toString("utf8");
  return JSON.parse(json);
}

describe("runtime-token — config resolution", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("missing config → exit 4 with init/import hint", async () => {
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["--env=dev", "--no-validate"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:4");
    }
    expect(threw).toBe(true);
    const err = joinStderr();
    expect(err).toMatch(/no config file|missing config/i);
    expect(err).toMatch(/vsync init|vsync import/);
  });

  test("missing --env → exit 1 with usage hint", async () => {
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["--no-validate"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    }
    expect(threw).toBe(true);
    expect(joinStderr()).toMatch(/--env/);
  });

  test("config + key + --no-validate → emits blob with config values", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    (process.stdin as any).isTTY = false;
    try {
      await main(["--env=dev", "--no-validate"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }

    const blob = decodeBlob(joinStdout());
    expect(blob.v).toBe(1);
    expect(blob.endpoint).toBe(sampleConfig.s3.endpoint);
    expect(blob.region).toBe(sampleConfig.s3.region);
    expect(blob.bucket).toBe(sampleConfig.s3.bucket);
    expect(blob.accessKeyId).toBe(sampleConfig.s3.accessKeyId);
    expect(blob.secretAccessKey).toBe(sampleConfig.s3.secretAccessKey);
    expect(blob.prefix).toBe("myapp/dev/");
    expect(blob.env).toBe("dev");
  });

  test("explicit flags override config values", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    (process.stdin as any).isTTY = false;
    try {
      await main([
        "--env=dev",
        "--access-key=AKIAFLAG000000000000",
        "--secret-key=flag-secret",
        "--bucket=flag-bucket",
        "--endpoint=https://flag.example.com",
        "--region=us-east-2",
        "--prefix=flag/dev/",
        "--no-validate",
      ]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }

    const blob = decodeBlob(joinStdout());
    expect(blob.endpoint).toBe("https://flag.example.com");
    expect(blob.region).toBe("us-east-2");
    expect(blob.bucket).toBe("flag-bucket");
    expect(blob.accessKeyId).toBe("AKIAFLAG000000000000");
    expect(blob.secretAccessKey).toBe("flag-secret");
    expect(blob.prefix).toBe("flag/dev/");
    expect(blob.env).toBe("dev");
  });

  test("--profile=<name> fills defaults; flags still win over profile", async () => {
    await saveProfile("hetzner", sampleProfile);
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    (process.stdin as any).isTTY = false;
    try {
      await main([
        "--env=dev",
        "--profile=hetzner",
        "--bucket=override-bucket",
        "--no-validate",
      ]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }

    const blob = decodeBlob(joinStdout());
    // Profile values for endpoint/region/keys
    expect(blob.endpoint).toBe(sampleProfile.endpoint);
    expect(blob.accessKeyId).toBe(sampleProfile.accessKeyId);
    expect(blob.secretAccessKey).toBe(sampleProfile.secretAccessKey);
    // Flag wins for bucket
    expect(blob.bucket).toBe("override-bucket");
  });
});

describe("runtime-token — blob encoding (deterministic, base64url-no-pad)", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("output is exactly one line and starts with the magic prefix", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    (process.stdin as any).isTTY = false;
    try {
      await main(["--env=dev", "--no-validate"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const out = joinStdout();
    expect(out.startsWith(CFG_BLOB_PREFIX)).toBe(true);
    // Only one trailing newline.
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n").filter((s) => s !== "").length).toBe(1);
  });

  test("the base64 portion is URL-safe (no +/=) and decodes to gzipped JSON", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    (process.stdin as any).isTTY = false;
    try {
      await main(["--env=dev", "--no-validate"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const out = joinStdout().trim();
    const b64 = out.slice(CFG_BLOB_PREFIX.length);
    expect(/[+/=]/.test(b64)).toBe(false);
    // Decode end-to-end
    const blob = decodeBlob(joinStdout());
    expect(blob.env).toBe("dev");
  });

  test("encoding is deterministic across runs for the same inputs", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    (process.stdin as any).isTTY = false;
    const runs: string[] = [];
    for (let i = 0; i < 2; i++) {
      stdoutBuf = [];
      stderrBuf = [];
      try {
        await main(["--env=dev", "--no-validate"]);
      } catch (e: any) {
        if (!String(e.message).startsWith("__exit:0")) throw e;
      }
      runs.push(joinStdout().trim());
    }
    expect(runs[0]).toBe(runs[1]);
  });
});

describe("runtime-token — validation exit codes", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("200 → success, blob emitted", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    __setValidator(async () => ({ kind: "ok" }));
    (process.stdin as any).isTTY = false;
    try {
      await main(["--env=dev"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    expect(decodeBlob(joinStdout()).env).toBe("dev");
  });

  test("404 → exit 0 with stderr warning (manifest absent)", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    __setValidator(async () => ({ kind: "notfound" }));
    (process.stdin as any).isTTY = false;
    try {
      await main(["--env=dev"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    expect(joinStderr()).toMatch(/manifest.*not exist|vsync push/i);
    expect(decodeBlob(joinStdout()).env).toBe("dev");
  });

  test("403 → exit 2", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    __setValidator(async () => ({ kind: "forbidden" }));
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["--env=dev"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:2");
    }
    expect(threw).toBe(true);
    expect(joinStderr()).toMatch(/IAM|policy|credentials/i);
  });

  test("network error → exit 3", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    __setValidator(async () => ({ kind: "unreachable", message: "ENOTFOUND" }));
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["--env=dev"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:3");
    }
    expect(threw).toBe(true);
    expect(joinStderr()).toMatch(/reach|network|endpoint/i);
  });

  test("--no-validate skips the validator entirely", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    let called = false;
    __setValidator(async () => {
      called = true;
      return { kind: "forbidden" };
    });
    (process.stdin as any).isTTY = false;
    try {
      await main(["--env=dev", "--no-validate"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    expect(called).toBe(false);
    // Blob still emitted
    expect(decodeBlob(joinStdout()).env).toBe("dev");
  });
});

describe("runtime-token — --json secret-warning path", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("--json dumps JSON to stderr behind a loud warning banner", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    (process.stdin as any).isTTY = false;
    try {
      await main(["--env=dev", "--no-validate", "--json"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }

    const err = joinStderr();
    expect(err).toMatch(/secret|cleartext|warning|do not paste/i);
    // The JSON dump must include the access key field (so the warning is real).
    expect(err).toContain(sampleConfig.s3.accessKeyId);

    // Blob still on stdout
    expect(decodeBlob(joinStdout()).env).toBe("dev");
  });
});

describe("runtime-token — salt + iterations (v0.10 §4)", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("emits salt verbatim from cfg.encryption.salt (string pass-through, no base64 wrap)", async () => {
    await saveConfigFile(TEST_REPO, "dev", sampleConfig);
    await setKey(TEST_REPO, "dev", generateKey());

    (process.stdin as any).isTTY = false;
    try {
      await main(["--env=dev", "--no-validate"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }

    const blob = decodeBlob(joinStdout());

    // Per v0.10 §4 / v0.12 §2.1: salt is emitted verbatim from
    // cfg.encryption.salt. Readers feed its UTF-8 bytes to PBKDF2 — they
    // do NOT base64-decode first. This is the string-utf8 convention that
    // matches src/crypto.ts::deriveKey and the test-vector corpus.
    expect(typeof blob.salt).toBe("string");
    expect(blob.salt.length).toBeGreaterThan(0);
    expect(blob.salt).toBe(sampleConfig.encryption.salt);

    // Iterations: stock CLI uses 600000 (v0.2 spec reference value).
    expect(blob.iterations).toBe(600000);
    expect(Number.isInteger(blob.iterations)).toBe(true);
  });
});
