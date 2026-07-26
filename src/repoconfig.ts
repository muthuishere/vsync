// repoconfig.ts — the on-disk per-(repo, env) half of a vsync config.
// Self-contained: holds everything push / pull / sync need at runtime,
// minus the encryption key (which lives in the OS keychain — see
// keychain.ts).
//
// Path: ${XDG_CONFIG_HOME:-$HOME/.config}/vsync/<repo>/env_<env>
//
// File mode 0600, parent dir 0700. Stored as gzip(JSON) — raw bytes,
// no base64 wrapper.

import { gunzipSync, gzipSync } from "node:zlib";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { S3Credentials } from "./s3";
import { vsyncBaseDir } from "./defaults";

/**
 * On-disk shape. Self-contained — push / pull / sync read this file and
 * the keychain entry, nothing else. `loadEnvConfig` (envconfig.ts) just
 * splices in the keychain key.
 *
 * `files.vaultFolder` overrides the default `infra/vault/<env>` for
 * monorepos. `sync.gh.repo` / `sync.gcp.project` are routing config
 * for the `vsync sync` fanout, written on first invocation.
 */
export type ConfigFile = {
  version: 1;
  s3: S3Credentials;
  encryption: { salt: string };
  files?: { vaultFolder?: string };
  sync?: {
    gh?: { repo: string };
    gcp?: { project: string };
    aws?: { region: string; secretPrefix?: string };
    azure?: { vaultName: string };
    vault?: { addr: string; mount: string; secretPath: string };
  };
  // Optional audit-log block. Absent on disk → defaults to `{ enabled: true }`
  // (audit is on by default — see SPEC-v0.4 §9). Explicit `{ enabled: false }`
  // round-trips through save/load unchanged.
  audit?: { enabled: boolean };
  /** Name of the profile init was bound to. v0.13+. Optional on old configs. */
  initProfile?: string;
  /** Resolved S3 prefix for this (repo, env). v0.13+. Optional on old configs. */
  prefix?: string;
};

/** Per-(repo, env) audit preference, defaulted. Source of truth for callers. */
export const DEFAULT_AUDIT_ENABLED = true;

/**
 * Directory names that already exist as siblings of the per-repo dirs under
 * `vsyncBaseDir()`. A repo with one of these names would write its config
 * *inside* that directory — `<base>/profiles/env_dev` landing next to
 * `<base>/profiles/myprofile.json` — silently colliding with vsync's own
 * state and disappearing from `vsync keystore list`.
 *
 * Refuse the name rather than corrupt the layout.
 */
const RESERVED_REPO_NAMES = new Set(["profiles", "backups"]);

/** Throws if `repo` would collide with vsync's own directories. */
export function assertUsableRepoName(repo: string): void {
  if (RESERVED_REPO_NAMES.has(repo.toLowerCase())) {
    throw new Error(
      `repo name "${repo}" is reserved — vsync stores its own ${repo.toLowerCase()} there.\n` +
        `  Pass a different name with --repo=<name>, or set one in the committed .vsync file.`,
    );
  }
}

/** Full path for a given (repo, env). env is lowercased; repo is taken as-is. */
export function configFilePath(repo: string, env: string): string {
  if (!repo) throw new Error("repo is required");
  if (!env) throw new Error("env is required");
  assertUsableRepoName(repo);
  return path.join(vsyncBaseDir(), repo, `env_${env.toLowerCase()}`);
}

/**
 * Every (repo, env) pair this machine knows about, sorted.
 *
 * The config tree IS the index: `Bun.secrets` exposes only get/set/delete
 * with no enumeration, so the keychain cannot be listed directly. Walking
 * `<base>/<repo>/env_<env>` is the only way to discover what exists — which
 * is why `vsync status` already does the per-repo version of this walk.
 *
 * Presence of a config file does NOT imply the keychain still holds the
 * matching key; callers that care must probe with `getKey()`. That gap is
 * exactly what an orphan check would report.
 */
export async function listAllPairs(): Promise<
  Array<{ repo: string; env: string }>
> {
  const base = vsyncBaseDir();
  let repoDirs: import("node:fs").Dirent[];
  try {
    repoDirs = await fs.readdir(base, { withFileTypes: true });
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
    throw err;
  }

  // The profiles directory is a sibling of the repo dirs. Compare it by
  // resolved PATH, not by name: skipping any dir literally called "profiles"
  // would make a repo of that name silently invisible to list and export.
  const { getProfilesDir } = await import("./profiles");
  const profilesDir = getProfilesDir();

  const out: Array<{ repo: string; env: string }> = [];
  for (const d of repoDirs) {
    // Plain files (e.g. the legacy defaults file) aren't repos either.
    if (!d.isDirectory()) continue;
    if (path.resolve(base, d.name) === path.resolve(profilesDir)) continue;
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(base, d.name));
    } catch {
      continue; // unreadable dir — skip rather than fail the whole listing
    }
    for (const f of entries) {
      if (!f.startsWith("env_")) continue;
      const env = f.slice(4);
      if (!/^[a-z0-9._-]+$/i.test(env)) continue;
      out.push({ repo: d.name, env });
    }
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo) || a.env.localeCompare(b.env));
  return out;
}

/**
 * Persist a ConfigFile. Creates the directory tree if missing. Uses 0700
 * on directories and 0600 on the file so other local users on the
 * machine can't read it.
 */
export async function saveConfigFile(
  repo: string,
  env: string,
  cfg: ConfigFile,
): Promise<string> {
  validateConfigFile(cfg);
  const file = configFilePath(repo, env);
  const dir = path.dirname(file);

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Non-fatal; some filesystems (e.g. Windows) don't honour chmod.
  }

  const json = JSON.stringify(cfg);
  const gz = gzipSync(Buffer.from(json, "utf8"));
  await fs.writeFile(file, gz, { mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Same caveat as above.
  }
  return file;
}

/**
 * Read the on-disk config back. Returns null when the file doesn't exist
 * (so callers can produce a "no config for <repo>/<env>" message). Any
 * other error — corrupt gzip, malformed JSON, validation failure — is
 * thrown.
 */
export async function loadConfigFile(
  repo: string,
  env: string,
): Promise<ConfigFile | null> {
  const file = configFilePath(repo, env);
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
    throw err;
  }
  const json = gunzipSync(buf).toString("utf8");
  const parsed = JSON.parse(json);
  validateConfigFile(parsed);
  // Default-on for `audit` — absent block means "enabled" per spec §9.
  if (parsed.audit === undefined) {
    parsed.audit = { enabled: DEFAULT_AUDIT_ENABLED };
  }
  return parsed;
}

/**
 * Delete the on-disk config (no-op if missing). Doesn't touch the
 * keychain — use keychain.deleteKey for that.
 */
export async function deleteConfigFile(
  repo: string,
  env: string,
): Promise<boolean> {
  const file = configFilePath(repo, env);
  try {
    await fs.unlink(file);
    return true;
  } catch (err: any) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

/** Defensive shape check; mirrors validate() in envconfig.ts but key-free. */
export function validateConfigFile(cfg: unknown): asserts cfg is ConfigFile {
  const c = cfg as Partial<ConfigFile> | null;
  if (!c || typeof c !== "object") throw new Error("config: not an object");
  if (c.version !== 1) {
    throw new Error(`config: unsupported version ${c.version} (expected 1)`);
  }
  const s3 = c.s3;
  for (const k of [
    "endpoint",
    "region",
    "accessKeyId",
    "secretAccessKey",
    "bucket",
  ] as const) {
    if (!s3?.[k]) throw new Error(`config: s3.${k} missing`);
  }
  if (typeof s3?.useSsl !== "boolean") {
    throw new Error("config: s3.useSsl missing or not a boolean");
  }
  const enc = c.encryption;
  if (!enc?.salt) throw new Error("config: encryption.salt missing");
  if (c.files !== undefined) {
    if (typeof c.files !== "object" || c.files === null) {
      throw new Error("config: files must be an object if present");
    }
    if (
      c.files.vaultFolder !== undefined &&
      typeof c.files.vaultFolder !== "string"
    ) {
      throw new Error("config: files.vaultFolder must be a string if present");
    }
  }
  if (c.sync !== undefined) {
    if (typeof c.sync !== "object" || c.sync === null) {
      throw new Error("config: sync must be an object if present");
    }
    if (c.sync.gh !== undefined && (!c.sync.gh.repo || typeof c.sync.gh.repo !== "string")) {
      throw new Error("config: sync.gh.repo must be a string if sync.gh is present");
    }
    if (c.sync.gcp !== undefined && (!c.sync.gcp.project || typeof c.sync.gcp.project !== "string")) {
      throw new Error("config: sync.gcp.project must be a string if sync.gcp is present");
    }
    if (c.sync.aws !== undefined) {
      if (typeof c.sync.aws !== "object" || c.sync.aws === null) {
        throw new Error("config: sync.aws must be an object if present");
      }
      if (!c.sync.aws.region || typeof c.sync.aws.region !== "string") {
        throw new Error("config: sync.aws.region must be a string if sync.aws is present");
      }
      if (
        c.sync.aws.secretPrefix !== undefined &&
        typeof c.sync.aws.secretPrefix !== "string"
      ) {
        throw new Error("config: sync.aws.secretPrefix must be a string if present");
      }
    }
    if (c.sync.azure !== undefined) {
      if (typeof c.sync.azure !== "object" || c.sync.azure === null) {
        throw new Error("config: sync.azure must be an object if present");
      }
      if (!c.sync.azure.vaultName || typeof c.sync.azure.vaultName !== "string") {
        throw new Error("config: sync.azure.vaultName must be a string if sync.azure is present");
      }
    }
    if (c.sync.vault !== undefined) {
      if (typeof c.sync.vault !== "object" || c.sync.vault === null) {
        throw new Error("config: sync.vault must be an object if present");
      }
      if (!c.sync.vault.addr || typeof c.sync.vault.addr !== "string") {
        throw new Error("config: sync.vault.addr must be a string if sync.vault is present");
      }
      if (!c.sync.vault.mount || typeof c.sync.vault.mount !== "string") {
        throw new Error("config: sync.vault.mount must be a string if sync.vault is present");
      }
      if (!c.sync.vault.secretPath || typeof c.sync.vault.secretPath !== "string") {
        throw new Error("config: sync.vault.secretPath must be a string if sync.vault is present");
      }
    }
  }
  if (c.audit !== undefined) {
    if (typeof c.audit !== "object" || c.audit === null) {
      throw new Error("config: audit must be an object if present");
    }
    if (typeof c.audit.enabled !== "boolean") {
      throw new Error("config: audit.enabled must be a boolean");
    }
  }
  if (c.initProfile !== undefined && typeof c.initProfile !== "string") {
    throw new Error("config: initProfile must be a string if present");
  }
  if (c.prefix !== undefined && typeof c.prefix !== "string") {
    throw new Error("config: prefix must be a string if present");
  }
}
