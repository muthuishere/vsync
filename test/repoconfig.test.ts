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
  saveConfigFile,
  loadConfigFile,
  deleteConfigFile,
  validateConfigFile,
  type ConfigFile,
} from "../src/repoconfig";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sample: ConfigFile = {
  version: 1,
  s3: {
    endpoint: "hel1.example.com",
    bucket: "b",
    region: "r",
    useSsl: true,
    accessKeyId: "akid",
    secretAccessKey: "sec",
  },
  encryption: { salt: "long-enough-salt-string" },
};

const sampleWithOverrides: ConfigFile = {
  ...sample,
  files: { vaultFolder: "apps/foo/infra/vault/dev" },
  sync: {
    gh: { repo: "muthuishere/reqsume" },
    gcp: { project: "reqsume-dev" },
  },
};

let tmpRoot: string;
let prevXdg: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vsync-repoconfig-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpRoot;
});

afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("paths", () => {
  test("configFilePath sits at vsync/<repo>/env_<env>, env lowercased", () => {
    expect(configFilePath("reqsume", "DEV")).toBe(
      join(tmpRoot, "vsync", "reqsume", "env_dev"),
    );
  });

  test("rejects missing repo/env", () => {
    expect(() => configFilePath("", "dev")).toThrow(/repo is required/);
    expect(() => configFilePath("r", "")).toThrow(/env is required/);
  });
});

describe("save / load roundtrip", () => {
  beforeEach(() => {
    rmSync(join(tmpRoot, "vsync"), { recursive: true, force: true });
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
  test("accepts a minimal config", () => {
    expect(() => validateConfigFile(structuredClone(sample))).not.toThrow();
  });

  test("accepts a config with overrides", () => {
    expect(() => validateConfigFile(structuredClone(sampleWithOverrides))).not.toThrow();
  });

  test("rejects unsupported version", () => {
    const bad = { ...structuredClone(sample), version: 2 } as any;
    expect(() => validateConfigFile(bad)).toThrow(/version/);
  });

  test("rejects missing version", () => {
    const bad = structuredClone(sample) as any;
    delete bad.version;
    expect(() => validateConfigFile(bad)).toThrow(/version/);
  });

  for (const path of [
    ["s3", "endpoint"],
    ["s3", "region"],
    ["s3", "accessKeyId"],
    ["s3", "secretAccessKey"],
    ["s3", "bucket"],
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

  test("rejects non-string vaultFolder", () => {
    const bad = { ...structuredClone(sample), files: { vaultFolder: 42 } } as any;
    expect(() => validateConfigFile(bad)).toThrow(/vaultFolder/);
  });

  test("rejects sync.gh missing repo string", () => {
    const bad = { ...structuredClone(sample), sync: { gh: { repo: "" } } } as any;
    expect(() => validateConfigFile(bad)).toThrow(/sync\.gh\.repo/);
  });

  test("rejects sync.gcp missing project string", () => {
    const bad = { ...structuredClone(sample), sync: { gcp: { project: "" } } } as any;
    expect(() => validateConfigFile(bad)).toThrow(/sync\.gcp\.project/);
  });
});
