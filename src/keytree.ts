// keytree.ts — build / parse the passphrase-encrypted *keytree* file: a
// selected set of (repo, env) pairs with their configs and keychain keys,
// sealed into one artifact so a whole dev environment can be reproduced on
// another machine in a single `vsync keychain import`.
//
// Wire format (file bytes, written verbatim — no base64 wrapper):
//   bytes  0..3   "VKT1"           — magic for the keytree file itself
//   bytes  4      saltLen (1 byte) — length of the salt that follows
//   bytes  5..5+L salt (L bytes)   — base64-string bytes, used by PBKDF2
//   bytes  rest                    — output of src/crypto.ts encrypt()
//                                    (which has its own RQE1 magic + IV + ct)
//
// Deliberately a NEW magic rather than a reuse of `SLS1`: a keytree holds
// many envs where a share file holds exactly one, so feeding one to the
// other's parser must fail loudly on the magic rather than confusingly on
// the JSON. Nothing here changes the existing RQE1 / RQEM0001 / SLS1
// formats — this is purely additive.
//
// SECURITY: one keytree can hold every key on the machine. That is a far
// bigger blast radius than a single `.share`, which is why the CLI requires
// an explicit selection or `--all`, and why the passphrase is mandatory.

import { encrypt, decrypt } from "./crypto";
import { validateConfigFile, type ConfigFile } from "./repoconfig";
import { validateProfile, type NamedProfile } from "./profiles";

const KEYTREE_MAGIC = new Uint8Array([0x56, 0x4b, 0x54, 0x31]); // "VKT1"
const SALT_BYTES = 16;

export const KEYTREE_VERSION = 1;

export type KeytreeEntry = {
  repo: string;
  env: string;
  config: ConfigFile;
  /** base64 AES key — the same value the OS keychain holds for this pair. */
  key: string;
};

export type KeytreePayload = {
  version: number;
  /** ISO-8601. Informational — helps an operator tell two keytrees apart. */
  exportedAt: string;
  entries: KeytreeEntry[];
  /**
   * Named S3-credential profiles.
   *
   * Carried because a (repo, env) config alone does NOT rebuild a working
   * machine: `vsync init` requires `--profile=<name>`, so a restored keystore
   * without profiles leaves the operator unable to create any new env. Empty
   * array when the export selected pairs but no profiles.
   *
   * These hold live S3 access keys — the same reason the whole file is
   * passphrase-sealed applies doubly here.
   */
  profiles: NamedProfile[];
};

/** Encrypt + frame a keytree payload into bytes for a `.keytree` file. */
export async function buildKeytreeFile(
  payload: KeytreePayload,
  passphrase: string,
): Promise<Uint8Array> {
  if (payload.version !== KEYTREE_VERSION) {
    throw new Error(
      `buildKeytreeFile: payload.version ${payload.version} not supported`,
    );
  }
  if (!passphrase) {
    throw new Error("buildKeytreeFile: passphrase is required");
  }
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const saltStr = Buffer.from(saltBytes).toString("base64");

  const json = JSON.stringify(payload);
  const encrypted = await encrypt(
    new TextEncoder().encode(json),
    passphrase,
    saltStr,
  );

  const saltAscii = new TextEncoder().encode(saltStr);
  if (saltAscii.length > 0xff) {
    throw new Error("internal: salt too long for 1-byte length prefix");
  }
  const out = new Uint8Array(
    KEYTREE_MAGIC.length + 1 + saltAscii.length + encrypted.length,
  );
  let offset = 0;
  out.set(KEYTREE_MAGIC, offset);
  offset += KEYTREE_MAGIC.length;
  out[offset] = saltAscii.length;
  offset += 1;
  out.set(saltAscii, offset);
  offset += saltAscii.length;
  out.set(encrypted, offset);
  return out;
}

/** Decrypt + unframe — the inverse of buildKeytreeFile. */
export async function parseKeytreeFile(
  bytes: Uint8Array,
  passphrase: string,
): Promise<KeytreePayload> {
  if (bytes.length < KEYTREE_MAGIC.length + 1) {
    throw new Error("keytree file is too short");
  }
  for (let i = 0; i < KEYTREE_MAGIC.length; i++) {
    if (bytes[i] !== KEYTREE_MAGIC[i]) {
      throw new Error(
        "not a vsync keytree file (magic header missing). " +
          "If this is a single-env `.share` file, use `vsync import <env> <file>` instead.",
      );
    }
  }
  let offset = KEYTREE_MAGIC.length;
  const saltLen = bytes[offset]!;
  offset += 1;
  if (bytes.length < offset + saltLen) {
    throw new Error("keytree file truncated (salt header)");
  }
  const saltStr = new TextDecoder().decode(
    bytes.subarray(offset, offset + saltLen),
  );
  offset += saltLen;
  const ciphertext = bytes.subarray(offset);

  let decrypted: Uint8Array;
  try {
    decrypted = await decrypt(ciphertext, passphrase, saltStr);
  } catch {
    throw new Error(
      "failed to decrypt keytree file — passphrase wrong or file corrupt.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    throw new Error("keytree payload is not valid JSON (file corrupt)");
  }
  validateKeytreePayload(parsed);
  return parsed;
}

export function validateKeytreePayload(
  p: unknown,
): asserts p is KeytreePayload {
  if (!p || typeof p !== "object") throw new Error("keytree payload is not an object");
  const o = p as Record<string, unknown>;
  if (o.version !== KEYTREE_VERSION) {
    throw new Error(
      `keytree version ${String(o.version)} is not supported by this vsync ` +
        `(expected ${KEYTREE_VERSION}) — upgrade vsync or re-export.`,
    );
  }
  if (!Array.isArray(o.entries)) throw new Error("keytree payload has no entries[]");
  if (!Array.isArray(o.profiles)) throw new Error("keytree payload has no profiles[]");
  for (const p of o.profiles as unknown[]) {
    if (!p || typeof p !== "object") throw new Error("keytree profile is not an object");
    const pr = p as Record<string, unknown>;
    if (typeof pr.name !== "string" || !pr.name) throw new Error("keytree profile missing name");
    if (typeof pr.bucket !== "string" || !pr.bucket) {
      throw new Error(`keytree profile ${pr.name} missing bucket`);
    }
    // Same all-or-nothing reasoning as the entries above.
    const { name: _n, ...rest } = pr;
    try {
      validateProfile(rest);
    } catch (e) {
      throw new Error(
        `keytree profile ${pr.name} is invalid: ${(e as Error).message}`,
      );
    }
  }
  for (const e of o.entries as unknown[]) {
    if (!e || typeof e !== "object") throw new Error("keytree entry is not an object");
    const en = e as Record<string, unknown>;
    if (typeof en.repo !== "string" || !en.repo) throw new Error("keytree entry missing repo");
    if (typeof en.env !== "string" || !en.env) throw new Error("keytree entry missing env");
    if (typeof en.key !== "string" || !en.key) throw new Error("keytree entry missing key");
    if (!en.config || typeof en.config !== "object") {
      throw new Error(`keytree entry ${en.repo}/${en.env} missing config`);
    }
    // Validate the config as deeply as saveConfigFile will. Without this, a
    // structurally-plausible-but-invalid entry passes parse and then throws
    // partway through the import loop, leaving the machine half-restored.
    // Import must be all-or-nothing, so every entry is checked up front.
    try {
      validateConfigFile(en.config);
    } catch (e) {
      throw new Error(
        `keytree entry ${en.repo}/${en.env} has an invalid config: ${(e as Error).message}`,
      );
    }
  }
}
