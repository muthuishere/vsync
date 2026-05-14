// configfile.ts — the on-disk half of a secret-lib config. Stores the
// non-key portion of an EnvConfig (S3 bucket creds + salt + which files
// to sync) as gzipped JSON at:
//
//   ${XDG_CONFIG_HOME:-$HOME/.config}/deemwar/config/<repo>/env_<env>
//
// Directory chmod 0700, file chmod 0600. The companion encryption key
// lives in the OS keychain (see keychain.ts) so this file alone is not
// enough to decrypt any S3-stored bundle.

import { gunzipSync, gzipSync } from "node:zlib";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import type { S3Credentials } from "./s3";

/**
 * ConfigFile is the on-disk shape — everything an EnvConfig has except
 * `encryption.key`. The key is held separately in the OS keychain and
 * spliced back in at load time by loadEnvConfig.
 */
export type ConfigFile = {
  s3: S3Credentials;
  encryption: { salt: string };
  files: { envFile: string; vaultFolder: string };
};

const ROOT_DIRNAME = "deemwar";
const CONFIG_SUBDIR = "config";

/** Base directory for all secret-lib config files. Honours XDG_CONFIG_HOME. */
export function configBaseDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, ROOT_DIRNAME, CONFIG_SUBDIR);
}

/** Full path for a given (repo, env). env is lowercased; repo is taken as-is. */
export function configFilePath(repo: string, env: string): string {
  if (!repo) throw new Error("repo is required");
  if (!env) throw new Error("env is required");
  return path.join(configBaseDir(), repo, `env_${env.toLowerCase()}`);
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
  // Ensure mode even if the directory already existed.
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
  const s3 = c?.s3;
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
  const enc = c?.encryption;
  if (!enc?.salt) throw new Error("config: encryption.salt missing");
  const files = c?.files;
  for (const k of ["envFile", "vaultFolder"] as const) {
    if (!files?.[k]) throw new Error(`config: files.${k} missing`);
  }
}
