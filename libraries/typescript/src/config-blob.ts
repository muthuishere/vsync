// `VSYNC_CONFIG` bootstrap blob decoder.
//
// Wire format (v0.12 §2.1):
//   vsync-cfg-v1:<base64url-no-pad(gzip(JSON))>
//
// The magic prefix is also the schema-version handle:
//   - absent / non-`vsync-cfg-v1:`               → ConfigMissingError
//   - body uses the standard base64 alphabet     → ConfigUnsupportedVersionError
//     (`+` / `/` / `=` — reader can't tell intended url-safe vs intended
//     standard, so we refuse both)
//   - body decodes but isn't gzip                → BundleCorruptError
//   - gzip ok, JSON inner `v != 1`               → ConfigUnsupportedVersionError
//   - JSON ok but root is not an object          → BundleCorruptError
//   - required field missing / malformed         → BundleCorruptError

import { gunzipSync } from "node:zlib";
import {
  BundleCorruptError,
  ConfigMissingError,
  ConfigUnsupportedVersionError,
} from "./errors.js";

export const BLOB_MAGIC = "vsync-cfg-v1:";
export const SUPPORTED_INNER_V = 1;

/** Decoded inner JSON of the `VSYNC_CONFIG` blob (v0.12 §2.1). */
export type VsyncConfig = {
  readonly v: 1;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly prefix: string;
  readonly env: string;
  /**
   * Salt STRING. Readers feed its UTF-8 bytes to PBKDF2 (NOT base64-
   * decoded bytes). See v0.12 §2.1 and src/crypto.ts header comment.
   */
  readonly salt: string;
  readonly iterations: number;
};

function asString(blob: Uint8Array | string): string {
  if (typeof blob === "string") return blob;
  return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).toString("ascii");
}

/**
 * Decode a `VSYNC_CONFIG` blob → typed config. See file header for the
 * error taxonomy mapping.
 */
export function decodeConfigBlob(blob: Uint8Array | string): VsyncConfig {
  const data = asString(blob);
  if (!data.startsWith(BLOB_MAGIC)) {
    throw new ConfigMissingError(
      "VSYNC_CONFIG: missing 'vsync-cfg-v1:' prefix — did you paste raw JSON, or are you holding a newer (v2+) blob?",
    );
  }
  const body = data.slice(BLOB_MAGIC.length);

  // Strict base64url-no-pad: any `+`, `/`, or `=` is an operator who
  // reached for `base64` instead of `base64url`. Surface loudly.
  if (/[+/=]/.test(body)) {
    throw new ConfigUnsupportedVersionError(
      "VSYNC_CONFIG: body must be base64url-no-pad per v0.12 §2.1; found a disallowed character (use '-' and '_' instead of '+' and '/'; drop padding '=')",
    );
  }

  let decoded: Buffer;
  try {
    // Node's "base64url" decoder accepts no-pad input verbatim.
    decoded = Buffer.from(body, "base64url");
  } catch (e) {
    throw new BundleCorruptError(
      `VSYNC_CONFIG: base64url body failed to decode: ${(e as Error).message}`,
    );
  }
  if (decoded.byteLength === 0) {
    throw new BundleCorruptError("VSYNC_CONFIG: decoded body is empty");
  }

  let json: string;
  try {
    json = gunzipSync(decoded).toString("utf8");
  } catch (e) {
    throw new BundleCorruptError(
      `VSYNC_CONFIG: gzip decompress failed — body is not a gzip stream: ${(e as Error).message}`,
    );
  }

  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new BundleCorruptError(
      `VSYNC_CONFIG: inner JSON failed to parse: ${(e as Error).message}`,
    );
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new BundleCorruptError(
      `VSYNC_CONFIG: inner JSON must be an object, got ${Array.isArray(obj) ? "array" : typeof obj}`,
    );
  }
  const o = obj as Record<string, unknown>;

  if (o.v !== SUPPORTED_INNER_V) {
    throw new ConfigUnsupportedVersionError(
      `VSYNC_CONFIG: inner v=${JSON.stringify(o.v)}; this library understands v=1 only — upgrade vsync-s3-client`,
    );
  }

  // Required scalar string fields per §2.1.
  const stringFields = [
    "endpoint",
    "region",
    "bucket",
    "accessKeyId",
    "secretAccessKey",
    "prefix",
    "env",
    "salt",
  ] as const;
  for (const field of stringFields) {
    if (typeof o[field] !== "string") {
      throw new BundleCorruptError(
        `VSYNC_CONFIG: inner JSON missing or malformed required field ${JSON.stringify(field)} (got ${typeof o[field]})`,
      );
    }
  }
  // Salt length sanity. The on-disk salts the CLI mints are 24 chars
  // (base64url-no-pad of 18 random bytes); anything < 16 chars is either
  // a hand-rolled blob with a too-short salt or a wire format we don't
  // understand. Per Convention A locked in v0.12 §2.1 — the floor is on
  // the STRING length (utf-8 bytes fed to PBKDF2), not on a decoded
  // byte count.
  if ((o.salt as string).length < 16) {
    throw new ConfigUnsupportedVersionError(
      `VSYNC_CONFIG: salt too short (${(o.salt as string).length} chars; need ≥ 16). The CLI mints 24-char salts; a shorter value suggests an older blob or hand-rolled config.`,
    );
  }
  if (
    typeof o.iterations !== "number" ||
    !Number.isInteger(o.iterations) ||
    o.iterations <= 0
  ) {
    throw new BundleCorruptError(
      `VSYNC_CONFIG: iterations must be a positive integer, got ${JSON.stringify(o.iterations)}`,
    );
  }

  return Object.freeze({
    v: 1 as const,
    endpoint: o.endpoint as string,
    region: o.region as string,
    bucket: o.bucket as string,
    accessKeyId: o.accessKeyId as string,
    secretAccessKey: o.secretAccessKey as string,
    prefix: o.prefix as string,
    env: o.env as string,
    salt: o.salt as string,
    iterations: o.iterations,
  });
}
