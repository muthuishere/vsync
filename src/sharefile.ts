// sharefile.ts — build / parse the passphrase-encrypted share file that
// teammates pass between machines.
//
// Wire format (file bytes, written verbatim — no base64 wrapper):
//   bytes  0..3   "SLS1"           — magic for the share file itself
//   bytes  4      saltLen (1 byte) — length of the salt that follows
//   bytes  5..5+L salt (L bytes)   — base64-string bytes, used by PBKDF2
//   bytes  rest                    — output of src/crypto.ts encrypt()
//                                    (which has its own RQE1 magic + IV + ct)
//
// The encrypted payload is the ExportPayload JSON (config + key + repo + env).

import { encrypt, decrypt } from "./crypto";
import {
  EXPORT_BLOB_VERSION,
  type ExportPayload,
  parseExportBlob,
  buildExportBlob,
} from "./envconfig";

const SHARE_MAGIC = new Uint8Array([0x53, 0x4c, 0x53, 0x31]); // "SLS1"
const SALT_BYTES = 16;

/** Encrypt + frame the payload into a single byte sequence suitable for
 * writing to a `.share` file. */
export async function buildShareFile(
  payload: ExportPayload,
  passphrase: string,
): Promise<Uint8Array> {
  if (payload.version !== EXPORT_BLOB_VERSION) {
    throw new Error(
      `buildShareFile: payload.version ${payload.version} not supported`,
    );
  }
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const saltStr = Buffer.from(saltBytes).toString("base64");

  // Re-use envconfig.buildExportBlob so the JSON+gzip+base64 framing
  // matches what was the env-var-era export. The result is one base64
  // ASCII string; we encrypt those bytes.
  const blobStr = buildExportBlob(payload);
  const blobBytes = new TextEncoder().encode(blobStr);
  const encrypted = await encrypt(blobBytes, passphrase, saltStr);

  const saltAscii = new TextEncoder().encode(saltStr);
  if (saltAscii.length > 0xff) {
    throw new Error("internal: salt too long for 1-byte length prefix");
  }
  const out = new Uint8Array(
    SHARE_MAGIC.length + 1 + saltAscii.length + encrypted.length,
  );
  let offset = 0;
  out.set(SHARE_MAGIC, offset);
  offset += SHARE_MAGIC.length;
  out[offset] = saltAscii.length;
  offset += 1;
  out.set(saltAscii, offset);
  offset += saltAscii.length;
  out.set(encrypted, offset);
  return out;
}

/** Decrypt + unframe — the inverse of buildShareFile. */
export async function parseShareFile(
  bytes: Uint8Array,
  passphrase: string,
): Promise<ExportPayload> {
  if (bytes.length < SHARE_MAGIC.length + 1) {
    throw new Error("share file is too short");
  }
  for (let i = 0; i < SHARE_MAGIC.length; i++) {
    if (bytes[i] !== SHARE_MAGIC[i]) {
      throw new Error(
        "not a secret-lib share file (magic header missing). " +
          "Check that you passed the file produced by `secret-lib export`.",
      );
    }
  }
  let offset = SHARE_MAGIC.length;
  const saltLen = bytes[offset]!;
  offset += 1;
  if (bytes.length < offset + saltLen) {
    throw new Error("share file truncated (salt header)");
  }
  const saltStr = new TextDecoder().decode(bytes.subarray(offset, offset + saltLen));
  offset += saltLen;
  const ciphertext = bytes.subarray(offset);

  let decrypted: Uint8Array;
  try {
    decrypted = await decrypt(ciphertext, passphrase, saltStr);
  } catch (e) {
    throw new Error(
      "failed to decrypt share file — passphrase wrong or file corrupt. " +
        "Ask the sender to re-share both.",
    );
  }
  const blobStr = new TextDecoder().decode(decrypted);
  return parseExportBlob(blobStr);
}
