// vsync-s3-client — read-side runtime library for the vsync ecosystem.
//
// Spec: docs/specs/v0.12-vsync-s3-client.md. The CLI (@muthuishere/vsync)
// is the canonical writer; this library reads. Two process inputs
// (VSYNC_CONFIG + VSYNC_PASSPHRASE), one S3 round trip, in-memory
// accessor with a deterministic fallback chain. No daemon. No refresh.
// No filesystem cache.

export { open, get, Vsync, __setS3Fetcher, __resetSingleton } from "./client.js";
export type { Source, S3FetchResult, S3Fetcher, OpenOptions, VsyncConfigSnapshot } from "./client.js";
export type { VsyncConfig } from "./config-blob.js";
export {
  VSyncError,
  ConfigMissingError,
  ConfigUnsupportedVersionError,
  S3UnreachableError,
  ManifestNotFoundError,
  WrongPassphraseError,
  BundleCorruptError,
  UnsupportedSpecVersionError,
} from "./errors.js";

export const VERSION = "0.1.0";
