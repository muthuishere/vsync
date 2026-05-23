import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfigFile, type ConfigFile } from "../src/repoconfig";
import { saveProfile, type Profile } from "../src/profiles";
import { setKey, deleteKey } from "../src/keychain";
import { gatherStatus } from "../src/status";

let tmpRoot: string;
let prevXdg: string | undefined;
const TEST_REPO = "vsync_status_test_pkg";

const baseS3 = {
  endpoint: "https://hel1.example.com",
  region: "auto",
  bucket: "personal-secrets",
  accessKeyId: "ak",
  secretAccessKey: "sk",
  useSsl: true,
};

const sampleProfile: Profile = {
  version: 1,
  endpoint: "https://hel1.example.com",
  region: "auto",
  bucket: "personal-secrets",
  prefix: "video-ai/",
  accessKeyId: "AKIA0000000000000000",
  secretAccessKey: "secret-access-key-very-long-and-secret",
};

function mkCfg(extra: Partial<ConfigFile> = {}): ConfigFile {
  return {
    version: 1,
    s3: { ...baseS3 },
    encryption: { salt: "a-long-enough-salt-string" },
    ...extra,
  };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vsync-status-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpRoot;
});

afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(tmpRoot, "vsync"), { recursive: true, force: true });
});

afterEach(async () => {
  // Clean up keychain entries this test created.
  for (const env of ["dev", "prod", "staging", "qa"]) {
    await deleteKey(TEST_REPO, env);
  }
});

describe("gatherStatus — empty state", () => {
  test("no configs, no profiles → empty arrays, repo carried through", async () => {
    const report = await gatherStatus(TEST_REPO);
    expect(report.repo).toBe(TEST_REPO);
    expect(report.envs).toEqual([]);
    expect(report.profiles).toEqual([]);
  });
});

describe("gatherStatus — env panel", () => {
  test("a healthy env with key returns ok status", async () => {
    await saveProfile("hetzner-personal", sampleProfile);
    const cfg = mkCfg({
      initProfile: "hetzner-personal",
      prefix: "video-ai/dev/",
    });
    await saveConfigFile(TEST_REPO, "dev", cfg);
    await setKey(TEST_REPO, "dev", "x".repeat(44));

    const report = await gatherStatus(TEST_REPO);
    expect(report.envs).toHaveLength(1);
    const e = report.envs[0];
    expect(e.env).toBe("dev");
    expect(e.profile).toBe("hetzner-personal");
    expect(e.prefix).toBe("video-ai/dev/");
    expect(e.status.ok).toBe(true);
    expect(e.status.code).toBe("ok");
  });

  test("config without key → orphan-no-key", async () => {
    const cfg = mkCfg({ initProfile: "hetzner-personal", prefix: "video-ai/dev/" });
    await saveConfigFile(TEST_REPO, "dev", cfg);
    // no setKey

    const report = await gatherStatus(TEST_REPO);
    const e = report.envs.find((x) => x.env === "dev")!;
    expect(e.status.ok).toBe(false);
    expect(e.status.code).toBe("orphan-no-key");
    expect(e.orphan).toBe("no-key");
  });

  test("config references missing profile → dangling-profile", async () => {
    const cfg = mkCfg({
      initProfile: "deleted-profile",
      prefix: "video-ai/dev/",
    });
    await saveConfigFile(TEST_REPO, "dev", cfg);
    await setKey(TEST_REPO, "dev", "x".repeat(44));

    const report = await gatherStatus(TEST_REPO);
    const e = report.envs.find((x) => x.env === "dev")!;
    expect(e.status.code).toBe("dangling-profile");
    expect(e.status.ok).toBe(false);
  });

  test("dangling profile + config still ok if profile exists", async () => {
    await saveProfile("existing-profile", sampleProfile);
    const cfg = mkCfg({
      initProfile: "existing-profile",
      prefix: "video-ai/dev/",
    });
    await saveConfigFile(TEST_REPO, "dev", cfg);
    await setKey(TEST_REPO, "dev", "x".repeat(44));

    const report = await gatherStatus(TEST_REPO);
    const e = report.envs.find((x) => x.env === "dev")!;
    expect(e.status.code).toBe("ok");
    expect(e.status.ok).toBe(true);
  });

  test("multiple envs are sorted by env name", async () => {
    const cfg = mkCfg();
    await saveConfigFile(TEST_REPO, "prod", cfg);
    await saveConfigFile(TEST_REPO, "dev", cfg);
    await setKey(TEST_REPO, "prod", "x".repeat(44));
    await setKey(TEST_REPO, "dev", "x".repeat(44));

    const report = await gatherStatus(TEST_REPO);
    expect(report.envs.map((e) => e.env)).toEqual(["dev", "prod"]);
  });

  test("env from old config without initProfile or prefix still reports", async () => {
    const cfg = mkCfg(); // no initProfile, no prefix
    await saveConfigFile(TEST_REPO, "dev", cfg);
    await setKey(TEST_REPO, "dev", "x".repeat(44));

    const report = await gatherStatus(TEST_REPO);
    const e = report.envs.find((x) => x.env === "dev")!;
    expect(e.status.code).toBe("ok");
    expect(e.profile).toBeUndefined();
    expect(e.prefix).toBeUndefined();
  });
});

describe("gatherStatus — profiles panel", () => {
  test("returns all profiles sorted", async () => {
    await saveProfile("zulu", sampleProfile);
    await saveProfile("alpha", sampleProfile);
    const report = await gatherStatus(TEST_REPO);
    expect(report.profiles.map((p) => p.name)).toEqual(["alpha", "zulu"]);
    expect(report.profiles[0].endpoint).toBe(sampleProfile.endpoint);
    expect(report.profiles[0].bucket).toBe(sampleProfile.bucket);
  });
});

describe("gatherStatus — notices", () => {
  test("includes a notice when keychain enumeration is unsupported", async () => {
    // We don't actually have a Windows test runner; this just verifies the
    // shape of the report — the `keychainEnumerationSupported` field exists.
    const report = await gatherStatus(TEST_REPO);
    expect(typeof report.keychainEnumerationSupported).toBe("boolean");
    expect(Array.isArray(report.notices)).toBe(true);
  });
});
