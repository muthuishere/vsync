// keychain.ts — thin wrapper over Bun.secrets so the rest of the codebase
// doesn't have to know whether we're talking to macOS Keychain, Linux
// libsecret, or Windows Credential Manager. All three are abstracted away
// by Bun's API; we just pick a consistent service+name pair.
//
// Service name follows the UTI convention Bun recommends (`com.org.tool`).
// Account name is `<repo>/<env>` so a single Keychain entry per repo+env.

import { secrets } from "bun";

export const KEYCHAIN_SERVICE = "com.deemwar.secret-lib";

function accountName(repo: string, env: string): string {
  if (!repo) throw new Error("repo is required for keychain operations");
  if (!env) throw new Error("env is required for keychain operations");
  return `${repo}/${env}`;
}

/** Save (or overwrite) the encryption key for a (repo, env) pair. */
export async function setKey(
  repo: string,
  env: string,
  key: string,
): Promise<void> {
  if (!key) throw new Error("key value cannot be empty");
  await secrets.set({
    service: KEYCHAIN_SERVICE,
    name: accountName(repo, env),
    value: key,
  });
}

/**
 * Look up the encryption key. Returns null if not set (rather than throwing)
 * so callers can produce friendly "key not found, run import" errors.
 */
export async function getKey(
  repo: string,
  env: string,
): Promise<string | null> {
  return await secrets.get({
    service: KEYCHAIN_SERVICE,
    name: accountName(repo, env),
  });
}

/** Remove the encryption key. Idempotent — no-op if it didn't exist. */
export async function deleteKey(repo: string, env: string): Promise<void> {
  try {
    await secrets.delete({
      service: KEYCHAIN_SERVICE,
      name: accountName(repo, env),
    });
  } catch {
    // Bun.secrets.delete throws on macOS for missing entries; swallow so
    // delete-key is idempotent across platforms.
  }
}

/** Generate a fresh 32-byte AES key, base64-encoded (~44 chars). */
export function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}
