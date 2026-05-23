import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../bin/init";
import { saveProfile, type Profile } from "../src/profiles";
import { loadConfigFile } from "../src/repoconfig";
import { getKey, deleteKey } from "../src/keychain";

const TEST_REPO = "vsync_init_bin_test";

const sampleProfile: Profile = {
  version: 1,
  endpoint: "https://hel1.example.com",
  region: "auto",
  bucket: "personal-secrets",
  prefix: "video-ai/",
  accessKeyId: "AKIAEXAMPLE000000000",
  secretAccessKey: "very-secret-key",
};

const noPrefixProfile: Profile = { ...sampleProfile };
delete (noPrefixProfile as any).prefix;

let tmpRoot: string;
let prevXdg: string | undefined;
let prevSecretsRepo: string | undefined;
let prevCwd: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vsync-init-bin-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpRoot;
  prevSecretsRepo = process.env.SECRETS_SYNC_REPO;
  process.env.SECRETS_SYNC_REPO = TEST_REPO;
  prevCwd = process.cwd();
  // Run inside an isolated worktree so init's vault-folder creation and
  // .gitignore checks don't touch the actual vsync repo we're testing in.
  const workdir = mkdtempSync(join(tmpdir(), "vsync-init-cwd-"));
  process.chdir(workdir);
});

afterAll(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  if (prevSecretsRepo === undefined) delete process.env.SECRETS_SYNC_REPO;
  else process.env.SECRETS_SYNC_REPO = prevSecretsRepo;
  for (const env of ["dev", "prod", "staging", "qa", "anothe"]) {
    await deleteKey(TEST_REPO, env);
  }
  try {
    process.chdir(prevCwd);
  } catch {
    // tolerate cleanup race
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  rmSync(join(tmpRoot, "vsync"), { recursive: true, force: true });
  for (const env of ["dev", "prod", "staging", "qa", "anothe"]) {
    await deleteKey(TEST_REPO, env);
  }
});

// Common test harness for capturing process.exit/console output.
let originalExit: any;
let originalLog: any;
let originalErr: any;
let originalTty: any;
let logBuf: string[];
let errBuf: string[];
let exitCalls: number[];

function captureSetup() {
  originalExit = process.exit;
  originalLog = console.log;
  originalErr = console.error;
  originalTty = (process.stdin as any).isTTY;
  logBuf = [];
  errBuf = [];
  exitCalls = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`__exit:${code ?? 0}`);
  }) as any;
  console.log = (msg?: unknown) => {
    logBuf.push(String(msg ?? ""));
  };
  console.error = (msg?: unknown) => {
    errBuf.push(String(msg ?? ""));
  };
}

function captureRestore() {
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalErr;
  (process.stdin as any).isTTY = originalTty;
}

describe("init — missing --profile flag", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("non-TTY without --profile exits 1 with hint", async () => {
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["dev"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    }
    expect(threw).toBe(true);
    const out = errBuf.join("\n");
    expect(out).toContain("--profile");
    expect(out).toMatch(/vsync profile list|profile add/);
  });

  test("non-TTY with --profile=missing exits 1 with profile-not-found message", async () => {
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["dev", "--profile=ghost"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    }
    expect(threw).toBe(true);
    const out = errBuf.join("\n");
    expect(out).toContain("ghost");
    expect(out.toLowerCase()).toContain("not found");
  });
});

describe("init — fresh setup with --profile=<name>", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("writes the per-(repo, env) config with initProfile + prefix from profile", async () => {
    await saveProfile("hetzner", sampleProfile);
    (process.stdin as any).isTTY = false;

    try {
      await main(["dev", "--profile=hetzner", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      // init may not call process.exit on success — re-raise unexpected
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }

    const cfg = await loadConfigFile(TEST_REPO, "dev");
    expect(cfg).not.toBeNull();
    expect(cfg!.initProfile).toBe("hetzner");
    expect(cfg!.prefix).toBe("video-ai/dev/"); // profile.prefix + env + "/"
    expect(cfg!.s3.endpoint).toBe(sampleProfile.endpoint);
    expect(cfg!.s3.bucket).toBe(sampleProfile.bucket);
    expect(cfg!.s3.accessKeyId).toBe(sampleProfile.accessKeyId);
    expect(cfg!.s3.secretAccessKey).toBe(sampleProfile.secretAccessKey);
    expect(cfg!.s3.useSsl).toBe(true); // derived from https:// endpoint
    expect(cfg!.audit?.enabled).toBe(false);

    const key = await getKey(TEST_REPO, "dev");
    expect(key).toBeTruthy();
    expect(key!.length).toBeGreaterThan(20);
  });

  test("useSsl is false when endpoint is http://", async () => {
    const plain: Profile = { ...sampleProfile, endpoint: "http://minio.local:9000" };
    await saveProfile("minio", plain);
    (process.stdin as any).isTTY = false;
    try {
      await main(["dev", "--profile=minio", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const cfg = await loadConfigFile(TEST_REPO, "dev");
    expect(cfg!.s3.useSsl).toBe(false);
    expect(cfg!.s3.endpoint).toBe("http://minio.local:9000");
  });

  test("S3 flags from 0.9.x are no longer recognised — pass them and they're ignored", async () => {
    await saveProfile("hetzner", sampleProfile);
    (process.stdin as any).isTTY = false;
    try {
      await main([
        "dev",
        "--profile=hetzner",
        "--bucket=ignored-bucket",
        "--endpoint=https://ignored.example.com",
        "--no-migrate",
        "--audit=off",
      ]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const cfg = await loadConfigFile(TEST_REPO, "dev");
    expect(cfg!.s3.bucket).toBe(sampleProfile.bucket);
    expect(cfg!.s3.endpoint).toBe(sampleProfile.endpoint);
  });

  test("--profile=<missing> in non-TTY exits 1 listing existing profiles", async () => {
    await saveProfile("alpha", sampleProfile);
    await saveProfile("bravo", sampleProfile);
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["dev", "--profile=ghost"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    }
    expect(threw).toBe(true);
    const out = errBuf.join("\n");
    expect(out).toContain("ghost");
    expect(out).toMatch(/alpha|bravo/);
  });
});

describe("init — prefix combination matrix", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("profile.prefix='video-ai/' + env='dev' → prefix 'video-ai/dev/'", async () => {
    await saveProfile("p", { ...sampleProfile, prefix: "video-ai/" });
    (process.stdin as any).isTTY = false;
    try {
      await main(["dev", "--profile=p", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const cfg = await loadConfigFile(TEST_REPO, "dev");
    expect(cfg!.prefix).toBe("video-ai/dev/");
  });

  test("profile.prefix='video-ai/' + env='prod' → prefix 'video-ai/prod/'", async () => {
    await saveProfile("p", { ...sampleProfile, prefix: "video-ai/" });
    (process.stdin as any).isTTY = false;
    try {
      await main(["prod", "--profile=p", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const cfg = await loadConfigFile(TEST_REPO, "prod");
    expect(cfg!.prefix).toBe("video-ai/prod/");
  });

  test("profile with no prefix, non-TTY → defaults to <repo>/<env>/", async () => {
    await saveProfile("p", noPrefixProfile);
    (process.stdin as any).isTTY = false;
    try {
      await main(["dev", "--profile=p", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const cfg = await loadConfigFile(TEST_REPO, "dev");
    expect(cfg!.prefix).toBe(`${TEST_REPO}/dev/`);
  });
});

describe("init — existing-config four-way prompt (non-TTY branch)", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("non-TTY with existing config exits 1 explaining the path forward", async () => {
    await saveProfile("hetzner", sampleProfile);
    (process.stdin as any).isTTY = false;
    // First init creates the config.
    try {
      await main(["dev", "--profile=hetzner", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }

    // Second init in non-TTY should refuse.
    logBuf.length = 0;
    errBuf.length = 0;
    let threw = false;
    try {
      await main(["dev", "--profile=hetzner", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    }
    expect(threw).toBe(true);
    const out = errBuf.join("\n");
    expect(out.toLowerCase()).toMatch(/config exists|already/);
    expect(out).toContain("--interactive");
  });
});

describe("init — TTY prompts (mocked)", () => {
  let originalPrompt: any;

  beforeEach(() => {
    captureSetup();
    originalPrompt = (globalThis as any).prompt;
  });

  afterEach(() => {
    captureRestore();
    (globalThis as any).prompt = originalPrompt;
  });

  test("TTY missing --profile + no profiles → picker shows empty-state and exits 1", async () => {
    (process.stdin as any).isTTY = true;
    (globalThis as any).prompt = () => null;
    let threw = false;
    try {
      await main(["dev"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    }
    expect(threw).toBe(true);
    const out = errBuf.join("\n");
    expect(out.toLowerCase()).toContain("no profiles");
  });

  test("TTY picker accepts numeric selection", async () => {
    await saveProfile("alpha", sampleProfile);
    await saveProfile("bravo", { ...sampleProfile, bucket: "another" });
    (process.stdin as any).isTTY = true;
    // First prompt: picker. The picker should ask for a number.
    (globalThis as any).prompt = () => "1";

    try {
      await main(["dev", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const cfg = await loadConfigFile(TEST_REPO, "dev");
    expect(cfg!.initProfile).toBe("alpha");
  });

  test("TTY picker 'q' aborts without writing config", async () => {
    await saveProfile("alpha", sampleProfile);
    (process.stdin as any).isTTY = true;
    (globalThis as any).prompt = () => "q";
    // q means exit 0 without changes.
    try {
      await main(["dev"]);
    } catch (e: any) {
      // either exits 0 or returns; both fine
      if (!String(e.message).startsWith("__exit:0")) {
        // anything else means we didn't honor "q"
        throw e;
      }
    }
    const cfg = await loadConfigFile(TEST_REPO, "dev");
    expect(cfg).toBeNull();
  });

  test("existing-config 'keep' (default Enter) leaves config untouched", async () => {
    await saveProfile("hetzner", sampleProfile);
    (process.stdin as any).isTTY = false;
    try {
      await main(["dev", "--profile=hetzner", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const before = await loadConfigFile(TEST_REPO, "dev");
    const beforeSalt = before!.encryption.salt;
    const beforeKey = await getKey(TEST_REPO, "dev");

    // Now flip to TTY and answer Enter → keep.
    (process.stdin as any).isTTY = true;
    (globalThis as any).prompt = () => ""; // bare Enter
    try {
      await main(["dev", "--profile=hetzner", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const after = await loadConfigFile(TEST_REPO, "dev");
    expect(after!.encryption.salt).toBe(beforeSalt);
    expect(await getKey(TEST_REPO, "dev")).toBe(beforeKey);
  });

  test("existing-config 'a' (abort) leaves config untouched", async () => {
    await saveProfile("hetzner", sampleProfile);
    (process.stdin as any).isTTY = false;
    try {
      await main(["dev", "--profile=hetzner", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const beforeSalt = (await loadConfigFile(TEST_REPO, "dev"))!.encryption.salt;

    (process.stdin as any).isTTY = true;
    (globalThis as any).prompt = () => "a";
    try {
      await main(["dev", "--profile=hetzner", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    expect((await loadConfigFile(TEST_REPO, "dev"))!.encryption.salt).toBe(beforeSalt);
  });

  test("existing-config 'o' overwrites — produces a fresh salt and key", async () => {
    await saveProfile("hetzner", sampleProfile);
    (process.stdin as any).isTTY = false;
    try {
      await main(["dev", "--profile=hetzner", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }
    const beforeSalt = (await loadConfigFile(TEST_REPO, "dev"))!.encryption.salt;
    const beforeKey = await getKey(TEST_REPO, "dev");

    (process.stdin as any).isTTY = true;
    (globalThis as any).prompt = () => "o";
    try {
      await main(["dev", "--profile=hetzner", "--no-migrate", "--audit=off"]);
    } catch (e: any) {
      if (!String(e.message).startsWith("__exit:0")) throw e;
    }

    const afterSalt = (await loadConfigFile(TEST_REPO, "dev"))!.encryption.salt;
    const afterKey = await getKey(TEST_REPO, "dev");
    expect(afterSalt).not.toBe(beforeSalt);
    expect(afterKey).not.toBe(beforeKey);
  });
});
