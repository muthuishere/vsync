#!/usr/bin/env bun
// Usage:
//   vsync runtime-token --env=<env>
//     [--access-key=...] [--secret-key=...]
//     [--bucket=...] [--endpoint=...] [--region=...] [--prefix=...]
//     [--profile=<name>]
//     [--no-validate]
//     [--json]
//     [--interactive]
//     [--repo=<name>]
//
// Mints the `VSYNC_CONFIG` bootstrap blob the runtime library reads.
// Stdout is the blob (and ONLY the blob, for `| pbcopy` / pipe friendliness);
// stderr carries progress and warnings. See docs/specs/v0.10-runtime-token-cli.md §2.

import { gzipSync } from "node:zlib";

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { loadConfigFile } from "../src/repoconfig";
import { ConfigFileMissingError } from "../src/envconfig";
import { configFilePath } from "../src/repoconfig";
import { loadProfile, ProfileNotFoundError, type Profile } from "../src/profiles";
import { askSecret, isTty } from "../src/prompt";
import type { S3Credentials } from "../src/s3";

const BLOB_PREFIX = "vsync-cfg-v1:";

// ─── Validator hook (injectable for tests) ──────────────────────────────
//
// The real validator HEADs `<prefix>manifest` using the supplied creds and
// classifies the response into one of four buckets. Tests swap it via
// `__setValidator(...)` so they don't need network.

export type ValidatorResult =
  | { kind: "ok" }
  | { kind: "notfound" }
  | { kind: "forbidden" }
  | { kind: "unreachable"; message?: string };

export type Validator = (
  creds: S3Credentials,
  prefix: string,
) => Promise<ValidatorResult>;

let injectedValidator: Validator | null = null;

/** Test hook — set to null to restore the real validator. */
export function __setValidator(v: Validator | null): void {
  injectedValidator = v;
}

async function defaultValidator(
  creds: S3Credentials,
  prefix: string,
): Promise<ValidatorResult> {
  const protocol = creds.useSsl ? "https://" : "http://";
  const endpoint = creds.endpoint.startsWith("http")
    ? creds.endpoint
    : protocol + creds.endpoint;
  try {
    const client = new Bun.S3Client({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      region: creds.region,
      bucket: creds.bucket,
      endpoint,
    });
    await client.file(`${prefix}manifest`).stat();
    return { kind: "ok" };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const code = e?.code ?? e?.status;
    if (code === 404 || code === "NoSuchKey" || /NoSuchKey|not found|404|does not exist/i.test(msg)) {
      return { kind: "notfound" };
    }
    if (code === 403 || code === 401 || /\b40[13]\b|Forbidden|Unauthor/i.test(msg)) {
      return { kind: "forbidden" };
    }
    return { kind: "unreachable", message: msg };
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

type BlobJson = {
  v: 1;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  env: string;
  /**
   * Standard base64 of the UTF-8 bytes the CLI's PBKDF2 sees as salt input —
   * i.e. `Buffer.from(cfg.encryption.salt, "utf8").toString("base64")`.
   * Readers MUST base64-decode and feed the raw bytes to PBKDF2 (see v0.10 §4).
   */
  salt: string;
  /** PBKDF2 iteration count. Reference value is 600000 (v0.2 spec). */
  iterations: number;
};

const DEFAULT_PBKDF2_ITERATIONS = 600_000;

export async function main(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const env = flags.env;
  if (!env || env === "true") {
    console.error("usage: vsync runtime-token --env=<env> [flags]");
    console.error("  see `vsync runtime-token --help` for full flag set");
    process.exit(1);
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(env)) {
    console.error(
      `--env must be lowercase letters/digits/underscore/hyphen (got "${env}")`,
    );
    process.exit(1);
  }

  const repo = await getRepoName({ override: flags.repo });

  // Load the on-disk config — required (we need its s3 block + prefix).
  const cfg = await loadConfigFile(repo, env);
  if (!cfg) {
    const err = new ConfigFileMissingError(repo, env, configFilePath(repo, env));
    console.error(err.message);
    process.exit(4);
  }

  // Optional profile that fills defaults for endpoint/region/bucket/prefix/creds.
  let profile: Profile | null = null;
  if (flags.profile && flags.profile !== "true") {
    try {
      profile = await loadProfile(flags.profile);
    } catch (e) {
      if (e instanceof ProfileNotFoundError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
  }

  // Resolution chain: flag → profile → config.
  const endpoint = pick(flags.endpoint, profile?.endpoint, cfg.s3.endpoint);
  const region = pick(flags.region, profile?.region, cfg.s3.region);
  const bucket = pick(flags.bucket, profile?.bucket, cfg.s3.bucket);
  const prefix = await resolvePrefix(flags.prefix, profile?.prefix, cfg.prefix, repo, env);

  // Creds: flag → profile → config; if everything absent and we have a TTY,
  // prompt. On non-TTY with missing creds → exit 1.
  const interactive = flags.interactive === "true";
  const accessKeyId = await resolveAccessKey(
    flags["access-key"],
    profile?.accessKeyId,
    cfg.s3.accessKeyId,
    interactive,
  );
  const secretAccessKey = await resolveSecret(
    flags["secret-key"],
    profile?.secretAccessKey,
    cfg.s3.secretAccessKey,
    interactive,
  );

  const useSsl = !endpoint.toLowerCase().startsWith("http://");

  const creds: S3Credentials = {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    useSsl,
  };

  // ─── Validation ─────────────────────────────────────────────────────
  if (flags["no-validate"] !== "true") {
    const validator = injectedValidator ?? defaultValidator;
    const result = await validator(creds, prefix);
    if (result.kind === "forbidden") {
      console.error(
        `credentials accepted by S3 but cannot read ${prefix}manifest — check IAM policy.`,
      );
      process.exit(2);
    }
    if (result.kind === "unreachable") {
      console.error(
        `could not reach ${endpoint} — check network / endpoint URL.` +
          (result.message ? `\n(${result.message})` : ""),
      );
      process.exit(3);
    }
    if (result.kind === "notfound") {
      console.error(
        `warning: ${prefix}manifest does not exist yet — run \`vsync push ${env}\` before booting apps.`,
      );
      // Fall through — emit blob anyway.
    }
  }

  // ─── Build + emit blob ──────────────────────────────────────────────
  // Salt: the on-disk `cfg.encryption.salt` is the ASCII string the CLI's
  // PBKDF2 sees as salt input (`enc.encode(salt)` in src/crypto.ts). Wire
  // format is standard base64 of those UTF-8 bytes; readers base64-decode
  // and feed the raw bytes to PBKDF2 (v0.10 §4).
  const saltB64 = Buffer.from(cfg.encryption.salt, "utf8").toString("base64");

  const blob: BlobJson = {
    v: 1,
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix,
    env,
    salt: saltB64,
    iterations: DEFAULT_PBKDF2_ITERATIONS,
  };

  if (flags.json === "true") {
    console.error(
      "⚠ --json: the JSON below contains your AWS secret key in cleartext.",
    );
    console.error(
      "⚠ Do not paste this into Slack / tickets / logs. Use only for local debugging.",
    );
    console.error(JSON.stringify(blob, null, 2));
  }

  const encoded = encodeBlob(blob);
  process.stdout.write(BLOB_PREFIX + encoded + "\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────

function pick(
  flagVal: string | undefined,
  profileVal: string | undefined,
  cfgVal: string,
): string {
  if (flagVal !== undefined && flagVal !== "true" && flagVal !== "") return flagVal;
  if (profileVal !== undefined && profileVal !== "") return profileVal;
  return cfgVal;
}

async function resolvePrefix(
  flagPrefix: string | undefined,
  profilePrefix: string | undefined,
  cfgPrefix: string | undefined,
  repo: string,
  env: string,
): Promise<string> {
  if (flagPrefix !== undefined && flagPrefix !== "true" && flagPrefix !== "") {
    return flagPrefix.endsWith("/") ? flagPrefix : flagPrefix + "/";
  }
  if (profilePrefix !== undefined && profilePrefix !== "") {
    // Profile prefix is a bucket-level prefix; compose with env.
    const base = profilePrefix.endsWith("/") ? profilePrefix : profilePrefix + "/";
    return `${base}${env}/`;
  }
  if (cfgPrefix !== undefined && cfgPrefix !== "") {
    return cfgPrefix.endsWith("/") ? cfgPrefix : cfgPrefix + "/";
  }
  return `${repo}/${env}/`;
}

async function resolveAccessKey(
  flagVal: string | undefined,
  profileVal: string | undefined,
  cfgVal: string,
  interactive: boolean,
): Promise<string> {
  if (flagVal !== undefined && flagVal !== "true" && flagVal !== "") return flagVal;
  if (!interactive && profileVal) return profileVal;
  if (!interactive && cfgVal) return cfgVal;
  if (isTty()) {
    const v = await askSecret("access key");
    if (v) return v;
  }
  if (profileVal) return profileVal;
  if (cfgVal) return cfgVal;
  console.error(
    "missing access key. Pass --access-key=… or set it interactively.",
  );
  process.exit(1);
}

async function resolveSecret(
  flagVal: string | undefined,
  profileVal: string | undefined,
  cfgVal: string,
  interactive: boolean,
): Promise<string> {
  if (flagVal !== undefined && flagVal !== "true" && flagVal !== "") return flagVal;
  if (!interactive && profileVal) return profileVal;
  if (!interactive && cfgVal) return cfgVal;
  if (isTty()) {
    const v = await askSecret("secret key");
    if (v) return v;
  }
  if (profileVal) return profileVal;
  if (cfgVal) return cfgVal;
  console.error(
    "missing secret key. Pass --secret-key=… or set it interactively.",
  );
  process.exit(1);
}

/**
 * Canonical JSON → gzip (deterministic: level 6, no mtime/filename header) →
 * base64url (no padding).
 */
function encodeBlob(blob: BlobJson): string {
  const json = JSON.stringify(blob);
  // gzipSync with mtime=0 keeps the output byte-stable across runs.
  const gz = gzipSync(Buffer.from(json, "utf8"), { level: 6 });
  // Zero the mtime field (offset 4..7) to guarantee determinism. Node's
  // zlib already sets it to 0 when called via the sync wrapper without an
  // options.dictionary, but we strip it defensively.
  if (gz.length >= 8) {
    gz[4] = 0;
    gz[5] = 0;
    gz[6] = 0;
    gz[7] = 0;
  }
  return Buffer.from(gz)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
