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
  };
  // Optional audit-log block. Absent on disk → defaults to `{ enabled: true }`
  // (audit is on by default — see SPEC-v0.4 §9). Explicit `{ enabled: false }`
  // round-trips through save/load unchanged.
  audit?: { enabled: boolean };
};

/** Per-(repo, env) audit preference, defaulted. Source of truth for callers. */
export const DEFAULT_AUDIT_ENABLED = true;

/** Full path for a given (repo, env). env is lowercased; repo is taken as-is. */
export function configFilePath(repo: string, env: string): string {
  if (!repo) throw new Error("repo is required");
  if (!env) throw new Error("env is required");
  return path.join(vsyncBaseDir(), repo, `env_${env.toLowerCase()}`);
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
  }
  if (c.audit !== undefined) {
    if (typeof c.audit !== "object" || c.audit === null) {
      throw new Error("config: audit must be an object if present");
    }
    if (typeof c.audit.enabled !== "boolean") {
      throw new Error("config: audit.enabled must be a boolean");
    }
  }
}
