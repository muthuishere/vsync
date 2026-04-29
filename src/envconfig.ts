// EnvConfig is the JSON shape that lives inside the gzip+base64 string
// stored as <PREFIX>_<NAME>. The whole config — bucket creds + encryption
// key/salt + which files to sync — travels in one env var so a fresh
// machine only needs to set that single variable.
//
// The prefix is supplied by the caller (CLI flag or env var) so the same
// library serves multiple repos:
//   video-ai uses --prefix=VIDEO_AI_ENV → VIDEO_AI_ENV_<NAME>
//   reqsume  uses --prefix=REQSUME_ENV  → REQSUME_ENV_<NAME>
//
// Resolution order:
//   1. explicit `prefix` arg (e.g. CLI --prefix=)
//   2. SECRETS_SYNC_PREFIX env var
//   3. FALLBACK_PREFIX ("SECRETS_ENV")

import type { S3Credentials } from "./s3";
import { encodeGzipBase64, decodeGzipBase64 } from "./codec";

export const MIN_KEY_LEN = 20;
export const MIN_SALT_LEN = 16;
export const FALLBACK_PREFIX = "SECRETS_ENV";

export type EnvConfig = {
  s3: S3Credentials;
  encryption: { key: string; salt: string };
  files: { envFile: string; vaultFolder: string };
};

export function resolvePrefix(prefix?: string): string {
  const p = prefix || process.env.SECRETS_SYNC_PREFIX || FALLBACK_PREFIX;
  if (!/^[A-Z][A-Z0-9_]*$/.test(p)) {
    throw new Error(
      `prefix must be UPPER_SNAKE_CASE (got "${p}"). e.g. VIDEO_AI_ENV, REQSUME_ENV`,
    );
  }
  return p;
}

export function envVarName(name: string, prefix?: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new Error(
      `name must be UPPER_SNAKE_CASE (got "${name}"). e.g. LOCAL, DEV, STAGING`,
    );
  }
  return `${resolvePrefix(prefix)}_${name}`;
}

export function loadFromEnv(name: string, prefix?: string): EnvConfig {
  const varName = envVarName(name, prefix);
  const v = process.env[varName];
  if (!v) {
    throw new Error(
      `${varName} is not set. Run 'init-env ${name}' to generate it.`,
    );
  }
  return decode(v);
}

export function encode(cfg: EnvConfig): string {
  validate(cfg);
  return encodeGzipBase64(JSON.stringify(cfg));
}

export function decode(blob: string): EnvConfig {
  const json = decodeGzipBase64(blob);
  const parsed = JSON.parse(json);
  validate(parsed);
  return parsed;
}

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
      `encryption.key must be at least ${MIN_KEY_LEN} characters (got ${enc.key?.length ?? 0}). Use a long passphrase or a generated random string.`,
    );
  }
  if (typeof enc.salt !== "string" || enc.salt.length < MIN_SALT_LEN) {
    throw new Error(
      `encryption.salt must be at least ${MIN_SALT_LEN} characters (got ${enc.salt?.length ?? 0}). Use a deployment-specific random string.`,
    );
  }
  const files = c?.files;
  for (const k of ["envFile", "vaultFolder"] as const) {
    if (!files?.[k]) throw new Error(`files.${k} missing`);
  }
}
