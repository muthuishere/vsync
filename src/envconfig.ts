// envconfig.ts — the in-memory composite used by push / pull / sync.
// Glues two on-disk sources together:
//
//   1. `~/.config/vsync/<repo>/env_<env>` — self-contained per-(repo, env)
//      config (S3 creds + salt + paths + sync routing). gzipped JSON,
//      chmod 0600. See repoconfig.ts.
//   2. OS keychain (macOS Keychain / Linux libsecret / Windows Credential
//      Manager) — the AES encryption key. See keychain.ts.
//
// `loadEnvConfig(repo, env)` reads both and returns the combined config.
// Missing file → returns null. Missing key → throws a "key not found"
// error so push/pull can surface it cleanly.
//
// Export/import blob:
//   `buildExportBlob` zips config+key+metadata into a single string the
//   user can share with teammates. `parseExportBlob` is the inverse.
//   Both go through codec.ts for gzip+base64 framing.

import type { S3Credentials } from "./s3";
import { encodeGzipBase64, decodeGzipBase64 } from "./codec";
import type { ConfigFile } from "./repoconfig";
import { loadConfigFile, validateConfigFile } from "./repoconfig";
import { getKey } from "./keychain";

export const MIN_KEY_LEN = 20;
export const MIN_SALT_LEN = 16;
export const EXPORT_BLOB_VERSION = 2;

/**
 * Runtime composite used by every push / pull / sync code path. Same
 * shape as ConfigFile, with the keychain key spliced in.
 */
export type EnvConfig = {
  s3: S3Credentials;
  encryption: { key: string; salt: string };
  files?: { vaultFolder?: string };
  sync?: ConfigFile["sync"];
};

/**
 * Resolve the effective vault folder for a (repo, env). Defaults to
 * `infra/vault/<env>` when the per-repo file doesn't override.
 */
export function resolveVaultFolder(cfg: EnvConfig | ConfigFile, env: string): string {
  return cfg.files?.vaultFolder ?? `infra/vault/${env.toLowerCase()}`;
}

/** Wire shape of the share blob exchanged between teammates. */
export type ExportPayload = {
  version: number;
  repo: string;
  env: string;
  config: ConfigFile; // file contents (no key)
  key: string; // base64-encoded AES key
};

export class ConfigFileMissingError extends Error {
  constructor(repo: string, env: string, filePath: string) {
    super(
      `no config file for ${repo}/${env} at ${filePath}.\n` +
        `Run 'vsync init ${env} --repo=${repo}' to create one, or 'vsync import ${env} <share-file>' if a teammate sent you one.`,
    );
    this.name = "ConfigFileMissingError";
  }
}

export class KeyMissingError extends Error {
  constructor(repo: string, env: string) {
    super(
      `encryption key for ${repo}/${env} not found in OS keychain.\n` +
        `Run 'vsync import ${env} <share-file>' if a teammate sent you the share file (it carries the key),\n` +
        `or 'vsync init ${env} --repo=${repo}' to generate a fresh one.`,
    );
    this.name = "KeyMissingError";
  }
}

/**
 * Load and assemble the full EnvConfig for a (repo, env). Throws
 * ConfigFileMissingError if the on-disk file is absent, KeyMissingError
 * if the file exists but the keychain entry is gone.
 */
export async function loadEnvConfig(
  repo: string,
  env: string,
): Promise<EnvConfig> {
  const { configFilePath } = await import("./repoconfig");
  const cfg = await loadConfigFile(repo, env);
  if (!cfg) {
    throw new ConfigFileMissingError(repo, env, configFilePath(repo, env));
  }
  const key = await getKey(repo, env);
  if (!key) {
    throw new KeyMissingError(repo, env);
  }
  const composite: EnvConfig = {
    s3: cfg.s3,
    encryption: { key, salt: cfg.encryption.salt },
    ...(cfg.files !== undefined ? { files: cfg.files } : {}),
    ...(cfg.sync !== undefined ? { sync: cfg.sync } : {}),
  };
  validate(composite);
  return composite;
}

/** Build a share-blob string (the inverse of parseExportBlob). */
export function buildExportBlob(payload: ExportPayload): string {
  validateExportPayload(payload);
  return encodeGzipBase64(JSON.stringify(payload));
}

/** Parse a share-blob string. Throws on bad gzip / JSON / shape. */
export function parseExportBlob(blob: string): ExportPayload {
  const json = decodeGzipBase64(blob.trim());
  const parsed = JSON.parse(json);
  validateExportPayload(parsed);
  return parsed;
}

/** Validate a runtime composite EnvConfig (key included). */
export function validate(cfg: unknown): asserts cfg is EnvConfig {
  const c = cfg as Partial<EnvConfig> | null;
  const s3 = c?.s3;
  for (const k of [
    "endpoint",
    "region",
    "accessKeyId",
    "secretAccessKey",
    "bucket",
  ] as const) {
    if (!s3?.[k]) throw new Error(`s3.${k} missing`);
  }
  if (typeof s3?.useSsl !== "boolean") {
    throw new Error("s3.useSsl missing or not a boolean");
  }
  const enc = c?.encryption;
  for (const k of ["key", "salt"] as const) {
    if (!enc?.[k]) throw new Error(`encryption.${k} missing`);
  }
  if (typeof enc.key !== "string" || enc.key.length < MIN_KEY_LEN) {
    throw new Error(
      `encryption.key must be at least ${MIN_KEY_LEN} characters (got ${enc.key?.length ?? 0}).`,
    );
  }
  if (typeof enc.salt !== "string" || enc.salt.length < MIN_SALT_LEN) {
    throw new Error(
      `encryption.salt must be at least ${MIN_SALT_LEN} characters (got ${enc.salt?.length ?? 0}).`,
    );
  }
  if (c.files !== undefined) {
    if (typeof c.files !== "object" || c.files === null) {
      throw new Error("files must be an object if present");
    }
    if (
      c.files.vaultFolder !== undefined &&
      typeof c.files.vaultFolder !== "string"
    ) {
      throw new Error("files.vaultFolder must be a string if present");
    }
  }
}

function validateExportPayload(p: unknown): asserts p is ExportPayload {
  const x = p as Partial<ExportPayload> | null;
  if (!x || typeof x !== "object") throw new Error("export blob is not an object");
  if (x.version !== EXPORT_BLOB_VERSION) {
    throw new Error(
      `unsupported export blob version: ${x.version} (this CLI handles ${EXPORT_BLOB_VERSION})`,
    );
  }
  if (!x.repo || typeof x.repo !== "string") throw new Error("export blob: repo missing");
  if (!x.env || typeof x.env !== "string") throw new Error("export blob: env missing");
  if (!x.key || typeof x.key !== "string" || x.key.length < MIN_KEY_LEN) {
    throw new Error(
      `export blob: key missing or shorter than ${MIN_KEY_LEN} chars`,
    );
  }
  validateConfigFile(x.config);
}
