import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  defaultsFilePath,
  vsyncBaseDir,
  loadDefaults,
  saveDefaults,
  validateDefaults,
  type Defaults,
} from "../src/defaults";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let prevXdg: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vsync-defaults-"));
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

const sample: Defaults = {
  version: 1,
  s3: {
    endpoint: "hel1.example.com",
    region: "hel1",
    bucket: "personal-bucket",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    useSsl: true,
  },
};

describe("paths", () => {
  test("vsyncBaseDir honours XDG_CONFIG_HOME", () => {
    expect(vsyncBaseDir()).toBe(join(tmpRoot, "vsync"));
  });

  test("defaultsFilePath sits at vsync/defaults", () => {
    expect(defaultsFilePath()).toBe(join(tmpRoot, "vsync", "defaults"));
  });
});

describe("save / load round-trip", () => {
  test("save then load returns the same shape", async () => {
    await saveDefaults(sample);
    const got = await loadDefaults();
    expect(got).toEqual(sample);
  });

  test("load returns null when the file is absent", async () => {
    expect(await loadDefaults()).toBeNull();
  });

  test("save creates the parent dir with 0700", async () => {
    await saveDefaults(sample);
    const dir = vsyncBaseDir();
    expect(existsSync(dir)).toBe(true);
    if (process.platform !== "win32") {
      const mode = statSync(dir).mode & 0o777;
      expect(mode).toBe(0o700);
    }
  });

  test("save writes the file with 0600", async () => {
    await saveDefaults(sample);
    if (process.platform !== "win32") {
      const mode = statSync(defaultsFilePath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("save overwrites an existing file", async () => {
    await saveDefaults(sample);
    const updated: Defaults = { version: 1, s3: { bucket: "another-bucket" } };
    await saveDefaults(updated);
    expect(await loadDefaults()).toEqual(updated);
  });

  test("partial s3 (just one field) is allowed", async () => {
    const partial: Defaults = { version: 1, s3: { bucket: "only-this" } };
    await saveDefaults(partial);
    expect(await loadDefaults()).toEqual(partial);
  });

  test("no s3 at all is allowed", async () => {
    const empty: Defaults = { version: 1 };
    await saveDefaults(empty);
    expect(await loadDefaults()).toEqual(empty);
  });
});

describe("validation", () => {
  test("rejects unsupported version", () => {
    expect(() => validateDefaults({ version: 2 })).toThrow(/version/);
  });

  test("rejects null", () => {
    expect(() => validateDefaults(null)).toThrow(/not an object/);
  });

  test("rejects non-object s3", () => {
    expect(() => validateDefaults({ version: 1, s3: "x" })).toThrow(/s3/);
  });

  test("accepts well-formed minimal object", () => {
    expect(() => validateDefaults({ version: 1 })).not.toThrow();
  });
});
