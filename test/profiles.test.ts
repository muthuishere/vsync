import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  loadProfile,
  saveProfile,
  listProfiles,
  removeProfile,
  profileExists,
  profilePath,
  getProfilesDir,
  ProfileNotFoundError,
  ProfileAlreadyExistsError,
  validateProfile,
  isValidProfileName,
  type Profile,
} from "../src/profiles";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let prevXdg: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vsync-profiles-"));
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

const sample: Profile = {
  version: 1,
  endpoint: "https://hel1.your-objectstorage.com",
  region: "auto",
  bucket: "personal-secrets",
  prefix: "video-ai/",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("paths", () => {
  test("getProfilesDir honours XDG_CONFIG_HOME", () => {
    expect(getProfilesDir()).toBe(join(tmpRoot, "vsync", "profiles"));
  });

  test("profilePath joins dir + <name>.json", () => {
    expect(profilePath("hetzner-personal")).toBe(
      join(tmpRoot, "vsync", "profiles", "hetzner-personal.json"),
    );
  });
});

describe("isValidProfileName", () => {
  test("accepts letters, digits, dots, underscores, hyphens", () => {
    expect(isValidProfileName("hetzner-personal")).toBe(true);
    expect(isValidProfileName("aws_video.ai")).toBe(true);
    expect(isValidProfileName("a")).toBe(true);
    expect(isValidProfileName("a1.b-c_d")).toBe(true);
  });

  test("rejects empty", () => {
    expect(isValidProfileName("")).toBe(false);
  });

  test("rejects slash, space, special chars", () => {
    expect(isValidProfileName("foo/bar")).toBe(false);
    expect(isValidProfileName("foo bar")).toBe(false);
    expect(isValidProfileName("foo@bar")).toBe(false);
    expect(isValidProfileName("foo$")).toBe(false);
  });

  test("rejects names longer than 64 chars", () => {
    expect(isValidProfileName("x".repeat(64))).toBe(true);
    expect(isValidProfileName("x".repeat(65))).toBe(false);
  });
});

describe("save / load round-trip", () => {
  test("save then load returns the same shape", async () => {
    await saveProfile("hetzner", sample);
    const got = await loadProfile("hetzner");
    expect(got).toEqual(sample);
  });

  test("load throws ProfileNotFoundError for missing", async () => {
    await expect(loadProfile("missing")).rejects.toThrow(ProfileNotFoundError);
  });

  test("save creates the parent dir with 0700", async () => {
    await saveProfile("hetzner", sample);
    const dir = getProfilesDir();
    expect(existsSync(dir)).toBe(true);
    if (process.platform !== "win32") {
      const mode = statSync(dir).mode & 0o777;
      expect(mode).toBe(0o700);
    }
  });

  test("save writes the file with 0600", async () => {
    await saveProfile("hetzner", sample);
    if (process.platform !== "win32") {
      const mode = statSync(profilePath("hetzner")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("save refuses to overwrite by default", async () => {
    await saveProfile("hetzner", sample);
    await expect(saveProfile("hetzner", sample)).rejects.toThrow(
      ProfileAlreadyExistsError,
    );
  });

  test("save with { overwrite: true } replaces existing", async () => {
    await saveProfile("hetzner", sample);
    const updated: Profile = { ...sample, bucket: "different-bucket" };
    await saveProfile("hetzner", updated, { overwrite: true });
    const got = await loadProfile("hetzner");
    expect(got.bucket).toBe("different-bucket");
  });

  test("save rejects invalid name", async () => {
    await expect(saveProfile("foo/bar", sample)).rejects.toThrow(/name/i);
  });

  test("load rejects invalid name", async () => {
    await expect(loadProfile("foo/bar")).rejects.toThrow(/name/i);
  });

  test("file content is plain JSON (not gzipped)", async () => {
    await saveProfile("hetzner", sample);
    const raw = readFileSync(profilePath("hetzner"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.endpoint).toBe(sample.endpoint);
  });

  test("save without optional prefix works", async () => {
    const { prefix: _prefix, ...sansPrefix } = sample;
    await saveProfile("aws-staging", sansPrefix as Profile);
    const got = await loadProfile("aws-staging");
    expect(got.prefix).toBeUndefined();
    expect(got.bucket).toBe(sample.bucket);
  });
});

describe("profileExists", () => {
  test("returns false when missing", async () => {
    expect(await profileExists("ghost")).toBe(false);
  });

  test("returns true after save", async () => {
    await saveProfile("hetzner", sample);
    expect(await profileExists("hetzner")).toBe(true);
  });

  test("returns false for invalid name (does not throw)", async () => {
    expect(await profileExists("foo/bar")).toBe(false);
  });
});

describe("listProfiles", () => {
  test("returns empty array when dir missing", async () => {
    expect(await listProfiles()).toEqual([]);
  });

  test("returns names sorted ascending", async () => {
    await saveProfile("zebra", sample);
    await saveProfile("alpha", sample);
    await saveProfile("middle", sample);
    const names = (await listProfiles()).map((p) => p.name);
    expect(names).toEqual(["alpha", "middle", "zebra"]);
  });

  test("returns Profile data with name attached", async () => {
    await saveProfile("hetzner", sample);
    const all = await listProfiles();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("hetzner");
    expect(all[0].endpoint).toBe(sample.endpoint);
    expect(all[0].bucket).toBe(sample.bucket);
  });

  test("ignores non-JSON files", async () => {
    await saveProfile("hetzner", sample);
    // sneak in a stray non-profile file
    writeFileSync(join(getProfilesDir(), "README.txt"), "not a profile\n");
    const names = (await listProfiles()).map((p) => p.name);
    expect(names).toEqual(["hetzner"]);
  });

  test("skips files with invalid JSON without aborting the listing", async () => {
    await saveProfile("good", sample);
    writeFileSync(join(getProfilesDir(), "broken.json"), "{ not json");
    const names = (await listProfiles()).map((p) => p.name);
    expect(names).toEqual(["good"]);
  });
});

describe("removeProfile", () => {
  test("throws ProfileNotFoundError when missing", async () => {
    await expect(removeProfile("ghost")).rejects.toThrow(ProfileNotFoundError);
  });

  test("removes existing file", async () => {
    await saveProfile("hetzner", sample);
    await removeProfile("hetzner");
    expect(await profileExists("hetzner")).toBe(false);
  });

  test("rejects invalid name", async () => {
    await expect(removeProfile("foo/bar")).rejects.toThrow(/name/i);
  });
});

describe("validateProfile", () => {
  test("accepts a valid profile", () => {
    expect(() => validateProfile(structuredClone(sample))).not.toThrow();
  });

  test("rejects unsupported version", () => {
    const bad = { ...sample, version: 2 } as any;
    expect(() => validateProfile(bad)).toThrow(/version/);
  });

  test("rejects missing version", () => {
    const bad: any = { ...sample };
    delete bad.version;
    expect(() => validateProfile(bad)).toThrow(/version/);
  });

  for (const field of [
    "endpoint",
    "region",
    "bucket",
    "accessKeyId",
    "secretAccessKey",
  ] as const) {
    test(`rejects missing ${field}`, () => {
      const bad: any = { ...sample };
      delete bad[field];
      expect(() => validateProfile(bad)).toThrow(new RegExp(field));
    });

    test(`rejects empty ${field}`, () => {
      const bad: any = { ...sample, [field]: "" };
      expect(() => validateProfile(bad)).toThrow(new RegExp(field));
    });
  }

  test("rejects non-string prefix", () => {
    const bad: any = { ...sample, prefix: 42 };
    expect(() => validateProfile(bad)).toThrow(/prefix/);
  });

  test("rejects null", () => {
    expect(() => validateProfile(null)).toThrow(/not an object/);
  });
});

describe("atomic write — no partial files", () => {
  test("file content is well-formed JSON immediately after save", async () => {
    await saveProfile("hetzner", sample);
    const raw = readFileSync(profilePath("hetzner"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
