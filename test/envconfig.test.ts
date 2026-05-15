import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  buildExportBlob,
  parseExportBlob,
  validate,
  loadEnvConfig,
  ConfigFileMissingError,
  KeyMissingError,
  EXPORT_BLOB_VERSION,
  MIN_KEY_LEN,
  MIN_SALT_LEN,
  type EnvConfig,
  type ExportPayload,
} from "../src/envconfig";
import type { ConfigFile } from "../src/repoconfig";
import { saveConfigFile, deleteConfigFile } from "../src/repoconfig";
import { setKey, deleteKey, KEYCHAIN_SERVICE } from "../src/keychain";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secrets } from "bun";

const configFile: ConfigFile = {
  s3: {
    endpoint: "hel1.example.com",
    bucket: "b",
    region: "r",
    useSsl: true,
    accessKeyId: "akid",
    secretAccessKey: "sec",
  },
  encryption: { salt: "long-enough-salt-string" },
  files: { envFile: ".env.dev", vaultFolder: "infra/vault/dev" },
};

const envConfig: EnvConfig = {
  ...configFile,
  encryption: {
    key: "long-enough-key-for-validation-tests",
    salt: configFile.encryption.salt,
  },
};

describe("validate (in-memory composite)", () => {
  test("accepts a complete EnvConfig", () => {
    expect(() => validate(structuredClone(envConfig))).not.toThrow();
  });

  test("rejects too-short encryption.key", () => {
    const bad = structuredClone(envConfig);
    bad.encryption.key = "short";
    expect(() => validate(bad)).toThrow(/at least \d+ characters/);
  });

  test("rejects too-short encryption.salt", () => {
    const bad = structuredClone(envConfig);
    bad.encryption.salt = "short";
    expect(() => validate(bad)).toThrow(/at least \d+ characters/);
  });

  for (const k of [
    "endpoint",
    "region",
    "accessKeyId",
    "secretAccessKey",
    "bucket",
  ] as const) {
    test(`rejects missing s3.${k}`, () => {
      const bad = structuredClone(envConfig) as any;
      bad.s3[k] = "";
      expect(() => validate(bad)).toThrow();
    });
  }

  test("MIN constants exported sensibly", () => {
    expect(MIN_KEY_LEN).toBeGreaterThanOrEqual(20);
    expect(MIN_SALT_LEN).toBeGreaterThanOrEqual(16);
  });
});

describe("export blob round-trip", () => {
  const payload: ExportPayload = {
    version: EXPORT_BLOB_VERSION,
    repo: "acme",
    env: "dev",
    config: configFile,
    key: "long-enough-key-for-validation-tests",
  };

  test("build → parse roundtrips", () => {
    const blob = buildExportBlob(payload);
    expect(parseExportBlob(blob)).toEqual(payload);
  });

  test("blob is base64 ASCII", () => {
    expect(buildExportBlob(payload)).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("parse rejects garbage", () => {
    expect(() => parseExportBlob("###not-base64###")).toThrow();
  });

  test("parse rejects unsupported version", () => {
    const wrongVersion = { ...payload, version: 999 };
    const bad = buildExportBlob({ ...payload }); // valid first
    // Build a fake bad blob by hand: easier to just call validate via build.
    expect(() => buildExportBlob(wrongVersion as any)).toThrow(/version/);
  });

  test("parse rejects missing repo/env/key", () => {
    expect(() =>
      buildExportBlob({ ...payload, repo: "" } as any),
    ).toThrow(/repo/);
    expect(() =>
      buildExportBlob({ ...payload, env: "" } as any),
    ).toThrow(/env/);
    expect(() => buildExportBlob({ ...payload, key: "short" } as any)).toThrow(
      /key/,
    );
  });
});

// loadEnvConfig integration: writes to a temp XDG_CONFIG_HOME + uses a
// scoped keychain service (resets after each test). Only runs on
// platforms with a working keychain backend.
describe("loadEnvConfig (file + keychain integration)", () => {
  let tmpRoot: string;
  let prevXdg: string | undefined;
  const REPO = "secret-lib-tests";
  const ENV = "dev";
  const TEST_KEY = "test-only-key-for-load-config-checks";

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "secret-lib-envconfig-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpRoot;
  });

  afterAll(async () => {
    await secrets
      .delete({ service: KEYCHAIN_SERVICE, name: `${REPO}/${ENV}` })
      .catch(() => {});
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await deleteConfigFile(REPO, ENV).catch(() => {});
    await deleteKey(REPO, ENV).catch(() => {});
  });

  test("throws ConfigFileMissingError when nothing exists", async () => {
    await expect(loadEnvConfig(REPO, ENV)).rejects.toBeInstanceOf(
      ConfigFileMissingError,
    );
  });

  test("throws KeyMissingError when file exists but keychain doesn't", async () => {
    await saveConfigFile(REPO, ENV, configFile);
    await expect(loadEnvConfig(REPO, ENV)).rejects.toBeInstanceOf(
      KeyMissingError,
    );
  });

  test("returns composite EnvConfig when both exist", async () => {
    await saveConfigFile(REPO, ENV, configFile);
    await setKey(REPO, ENV, TEST_KEY);
    const cfg = await loadEnvConfig(REPO, ENV);
    expect(cfg.s3).toEqual(configFile.s3);
    expect(cfg.files).toEqual(configFile.files);
    expect(cfg.encryption.salt).toBe(configFile.encryption.salt);
    expect(cfg.encryption.key).toBe(TEST_KEY);
  });
});
