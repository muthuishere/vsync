// profiles.ts — named S3-credential profiles under ~/.config/vsync/profiles/.
//
// One JSON file per profile, mode 0600, parent dir 0700. `XDG_CONFIG_HOME`
// respected (same convention as repoconfig.ts / defaults.ts). Profile
// content is plain JSON — readable for `vsync profile show` and for
// scripts that want to mint them by hand. See docs/specs/v0.13-profiles-init-status.md.
//
// A profile is the named bag of S3 creds that `vsync init` binds to a
// (repo, env) pair. The single-default mechanism (defaults.ts) is being
// retired in favour of this module.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { vsyncBaseDir } from "./defaults";

/** On-disk shape. Plain JSON; never gzipped. */
export type Profile = {
  version: 1;
  endpoint: string;
  region: string;
  bucket: string;
  /** Optional. Trailing slash required when present. */
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** Profile augmented with its on-disk name (returned by listProfiles). */
export type NamedProfile = Profile & { name: string };

/** Profile name grammar: [A-Za-z0-9._-]+, max 64 chars. Case-sensitive. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const NAME_MAX_LEN = 64;

export class ProfileNotFoundError extends Error {
  constructor(name: string, dir: string) {
    super(`profile "${name}" not found in ${dir}`);
    this.name = "ProfileNotFoundError";
  }
}

export class ProfileAlreadyExistsError extends Error {
  constructor(name: string, p: string) {
    super(
      `profile "${name}" already exists at ${p}.\n` +
        `To replace it: vsync profile remove ${name} && vsync profile add ${name}`,
    );
    this.name = "ProfileAlreadyExistsError";
  }
}

export class InvalidProfileNameError extends Error {
  constructor(name: string) {
    super(
      `invalid profile name "${name}". Allowed: letters, digits, '.', '_', '-' ` +
        `(max ${NAME_MAX_LEN} chars).`,
    );
    this.name = "InvalidProfileNameError";
  }
}

/** Check a profile name against the grammar. Pure predicate; never throws. */
export function isValidProfileName(name: string): boolean {
  if (!name) return false;
  if (name.length > NAME_MAX_LEN) return false;
  return NAME_RE.test(name);
}

function assertValidName(name: string): void {
  if (!isValidProfileName(name)) throw new InvalidProfileNameError(name);
}

/** Profiles directory path. Honours XDG_CONFIG_HOME. */
export function getProfilesDir(): string {
  return path.join(vsyncBaseDir(), "profiles");
}

/** Full path for a named profile (`<dir>/<name>.json`). */
export function profilePath(name: string): string {
  assertValidName(name);
  return path.join(getProfilesDir(), `${name}.json`);
}

/** Does the file exist? Returns false (no throw) for invalid names. */
export async function profileExists(name: string): Promise<boolean> {
  if (!isValidProfileName(name)) return false;
  try {
    await fs.stat(path.join(getProfilesDir(), `${name}.json`));
    return true;
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return false;
    throw err;
  }
}

async function ensureDir(): Promise<string> {
  const dir = getProfilesDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Non-fatal; some filesystems don't honour chmod (Windows).
  }
  return dir;
}

/**
 * Persist a profile. Atomic — writes to `<file>.tmp.<pid>.<rand>` then
 * renames in place. Refuses to overwrite unless `{ overwrite: true }`.
 */
export async function saveProfile(
  name: string,
  profile: Profile,
  opts: { overwrite?: boolean } = {},
): Promise<string> {
  assertValidName(name);
  validateProfile(profile);
  await ensureDir();
  const file = profilePath(name);
  if (!opts.overwrite && (await profileExists(name))) {
    throw new ProfileAlreadyExistsError(name, file);
  }
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const json = JSON.stringify(profile, null, 2) + "\n";
  await fs.writeFile(tmp, json, { mode: 0o600 });
  try {
    await fs.chmod(tmp, 0o600);
  } catch {
    // Same caveat as above.
  }
  await fs.rename(tmp, file);
  return file;
}

/**
 * Read a profile by name. Throws ProfileNotFoundError if absent (callers
 * can catch and produce a friendly message that lists existing names).
 */
export async function loadProfile(name: string): Promise<Profile> {
  assertValidName(name);
  const file = profilePath(name);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      throw new ProfileNotFoundError(name, getProfilesDir());
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  validateProfile(parsed);
  return parsed;
}

/**
 * List every profile, sorted by name ascending. Files that don't parse or
 * don't pass validation are silently skipped (so a single broken file
 * doesn't break `vsync profile list`).
 */
export async function listProfiles(): Promise<NamedProfile[]> {
  const dir = getProfilesDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
    throw err;
  }
  const out: NamedProfile[] = [];
  for (const fname of entries) {
    if (!fname.endsWith(".json")) continue;
    const name = fname.slice(0, -5);
    if (!isValidProfileName(name)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, fname), "utf8");
      const parsed = JSON.parse(raw);
      validateProfile(parsed);
      out.push({ name, ...parsed });
    } catch {
      // Skip unreadable / malformed profiles.
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Remove a profile. Throws ProfileNotFoundError if absent. */
export async function removeProfile(name: string): Promise<void> {
  assertValidName(name);
  const file = profilePath(name);
  try {
    await fs.unlink(file);
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      throw new ProfileNotFoundError(name, getProfilesDir());
    }
    throw err;
  }
}

/** Defensive shape check. */
export function validateProfile(p: unknown): asserts p is Profile {
  const x = p as Partial<Profile> | null;
  if (!x || typeof x !== "object") throw new Error("profile: not an object");
  if (x.version !== 1) {
    throw new Error(`profile: unsupported version ${x.version} (expected 1)`);
  }
  for (const field of [
    "endpoint",
    "region",
    "bucket",
    "accessKeyId",
    "secretAccessKey",
  ] as const) {
    const v = x[field];
    if (typeof v !== "string" || !v) {
      throw new Error(`profile: ${field} missing or not a non-empty string`);
    }
  }
  if (x.prefix !== undefined && typeof x.prefix !== "string") {
    throw new Error("profile: prefix must be a string if present");
  }
}
