// vaultwalk.ts — recursive walker for vault folders.
//
// Yields one entry per regular file under the root. Includes dotfiles and
// nested subdirs. Symlinks raise SymlinkInVaultError — vault is plain data
// (see docs/specs/v0.17-pull-safety.md §8).
//
// Used by the ledger (src/ledger.ts) for dirty detection, by push for
// pre-flight validation, and by status for the "local" column.

import { Stats, lstatSync, readdirSync } from "node:fs";
import { join, relative, sep, posix } from "node:path";

export interface VaultEntry {
  /** POSIX path relative to the walk root, e.g. ".env.dev" or "tls/server.crt". */
  rel: string;
  /** Absolute path. */
  abs: string;
  /** fs.Stats (from lstat). */
  stat: Stats;
}

/**
 * Recursively yield every regular file under `root`. Throws
 * SymlinkInVaultError on the first symlink encountered (vault is plain data;
 * symlinks would silently leak target content into the encrypted bundle).
 *
 * Returns an empty array (no throw) when `root` doesn't exist — callers that
 * care about that case should check existsSync(root) before walking.
 */
export function walkVault(root: string): VaultEntry[] {
  const out: VaultEntry[] = [];
  walkInto(root, root, out);
  // Stable order so consumers (ledger, status) get deterministic output.
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

function walkInto(root: string, dir: string, out: VaultEntry[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return;
    throw err;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    let st: Stats;
    try {
      st = lstatSync(abs); // lstat — don't follow symlinks
    } catch {
      continue; // race: file removed between readdir and lstat
    }
    if (st.isSymbolicLink()) {
      // Read the target path for the error message; ignore failures.
      let target = "(unreadable)";
      try {
        const { readlinkSync } = require("node:fs");
        target = readlinkSync(abs);
      } catch {
        // ignore
      }
      throw new SymlinkInVaultError(abs, target);
    }
    if (st.isDirectory()) {
      walkInto(root, abs, out);
      continue;
    }
    if (!st.isFile()) continue; // skip pipes, sockets, devices
    const relSys = relative(root, abs);
    // Normalise to POSIX separators for ledger key stability across OS.
    const rel = sep === "/" ? relSys : relSys.split(sep).join(posix.sep);
    out.push({ rel, abs, stat: st });
  }
}

/**
 * Thrown when the walker encounters a symbolic link under the vault root.
 * vault is plain data; symlinks would point outside the encrypted bundle
 * and silently leak the target's path/content on every sync.
 */
export class SymlinkInVaultError extends Error {
  constructor(
    public readonly path: string,
    public readonly target: string,
  ) {
    super(
      `✗ Symlink found in vault — not supported.\n\n` +
        `  symlink:  ${path}\n` +
        `  target:   ${target}\n\n` +
        `The vault folder stores plain data. Symlinks would point outside the\n` +
        `encrypted bundle and silently leak the target's path on every sync.\n\n` +
        `Either:\n` +
        `  - copy the target's content in place, OR\n` +
        `  - move the symlink out of the vault tree.`,
    );
    this.name = "SymlinkInVaultError";
  }
}
