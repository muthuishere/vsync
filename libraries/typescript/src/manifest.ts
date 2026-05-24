// RQEM0001 manifest pointer-seal — read path only (v0.2 §3 / v0.12).
//
//   bytes 0..7    magic "RQEM0001"
//   bytes 8..22   15-char ASCII timestamp "YYYYMMDD-HHmmss"
//   bytes 23..N   payload (opaque)
//
// `verifyAgainstRemoteTs` is the load-bearing anti-rollback check — an
// attacker with bucket-write but no decryption key cannot swing the
// `<prefix>manifest` pointer at a renamed older bundle without the
// embedded ts disagreeing with the remote ts.

import { BundleCorruptError } from "./errors.js";

const MAGIC = Buffer.from("RQEM0001", "ascii");
const TS_LEN = 15;
const HEADER_LEN = MAGIC.length + TS_LEN; // 23

export type ManifestParts = {
  ts: string;
  payload: Uint8Array;
};

/**
 * Parse the RQEM0001 envelope; return {ts, payload}.
 * Throws BundleCorruptError on missing magic or truncated input.
 * Does NOT verify against a remote ts — caller does that via
 * verifyAgainstRemoteTs.
 */
export function unwrapRqem0001(blob: Uint8Array): ManifestParts {
  if (blob.byteLength < HEADER_LEN) {
    throw new BundleCorruptError(
      `RQEM0001 manifest too short: ${blob.byteLength} bytes (need at least ${HEADER_LEN})`,
    );
  }
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BundleCorruptError(
      "RQEM0001 manifest: magic prefix mismatch — not a vsync manifest",
    );
  }
  const ts = buf.subarray(MAGIC.length, HEADER_LEN).toString("ascii");
  const payload = new Uint8Array(
    buf.subarray(HEADER_LEN).buffer,
    buf.subarray(HEADER_LEN).byteOffset,
    buf.subarray(HEADER_LEN).byteLength,
  );
  return { ts, payload };
}

/**
 * Unwrap + verify the embedded ts equals `remoteTs`. A pointer-rollback
 * attack will fail this check.
 */
export function verifyAgainstRemoteTs(
  blob: Uint8Array,
  remoteTs: string,
): ManifestParts {
  const { ts, payload } = unwrapRqem0001(blob);
  if (ts !== remoteTs) {
    throw new BundleCorruptError(
      `RQEM0001 manifest: embedded ts ${JSON.stringify(ts)} != remote ts ${JSON.stringify(remoteTs)} — possible pointer-rollback attack or torn bucket write`,
    );
  }
  return { ts, payload };
}
