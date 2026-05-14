import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  configFilePath,
  configBaseDir,
  saveConfigFile,
  loadConfigFile,
  deleteConfigFile,
  validateConfigFile,
  type ConfigFile,
} from "../src/configfile";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sample: ConfigFile = {
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

let tmpRoot: string;
let prevXdg: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "secret-lib-configfile-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpRoot;
});

afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("paths", () => {
  test("configBaseDir respects XDG_CONFIG_HOME", () => {
    expect(configBaseDir()).toBe(join(tmpRoot, "deemwar", "config"));
  });

  test("configFilePath is repo + env scoped, env is lowercased", () => {
    expect(configFilePath("reqsume", "DEV")).toBe(
      join(tmpRoot, "deemwar", "config", "reqsume", "env_dev"),
    );
  });

  test("rejects missing repo/env", () => {
    expect(() => configFilePath("", "dev")).toThrow(/repo is required/);
    expect(() => configFilePath("r", "")).toThrow(/env is required/);
  });
});

describe("save / load roundtrip", () => {
  beforeEach(() => {
    rmSync(join(tmpRoot, "deemwar"), { recursive: true, force: true });
  });

  test("save writes gzipped JSON; load parses it back", async () => {
    const path = await saveConfigFile("acme", "dev", sample);
    expect(existsSync(path)).toBe(true);
    expect(await loadConfigFile("acme", "dev")).toEqual(sample);
  });

  test("file has 0600 mode", async () => {
    const path = await saveConfigFile("acme", "dev", sample);
    const stat = statSync(path);
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });

  test("load returns null for a missing file", async () => {
    expect(await loadConfigFile("ghost", "dev")).toBeNull();
  });

  test("save throws on invalid config", async () => {
    const bad = { ...sample, s3: { ...sample.s3, bucket: "" } };
    // @ts-expect-error intentional
    await expect(saveConfigFile("acme", "dev", bad)).rejects.toThrow(/bucket/);
  });

  test("delete removes the file (idempotent)", async () => {
    await saveConfigFile("acme", "dev", sample);
    expect(await deleteConfigFile("acme", "dev")).toBe(true);
    expect(await deleteConfigFile("acme", "dev")).toBe(false);
    expect(await loadConfigFile("acme", "dev")).toBeNull();
  });
});

describe("validateConfigFile", () => {
  test("accepts a complete config", () => {
    expect(() => validateConfigFile(structuredClone(sample))).not.toThrow();
  });

  for (const path of [
    ["s3", "endpoint"],
    ["s3", "region"],
    ["s3", "accessKeyId"],
    ["s3", "secretAccessKey"],
    ["s3", "bucket"],
    ["files", "envFile"],
    ["files", "vaultFolder"],
  ]) {
    test(`rejects when ${path.join(".")} is missing`, () => {
      const bad = structuredClone(sample);
      // @ts-expect-error dynamic test access
      bad[path[0]][path[1]] = "";
      expect(() => validateConfigFile(bad)).toThrow();
    });
  }

  test("rejects when useSsl is not a boolean", () => {
    const bad = structuredClone(sample) as any;
    bad.s3.useSsl = "yes";
    expect(() => validateConfigFile(bad)).toThrow(/useSsl/);
  });

  test("rejects when encryption.salt is missing", () => {
    const bad = structuredClone(sample);
    // @ts-expect-error
    bad.encryption.salt = "";
    expect(() => validateConfigFile(bad)).toThrow(/salt/);
  });
});
