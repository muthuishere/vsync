// vaultbackup.ts — v0.17 plain-text vault backups for `vsync pull --backup`.
//
// Distinct from src/backup.ts which produces an *encrypted* .enc archive as a
// safety net before destructive operations. v0.17 `--backup` creates a *plain*
// recursive copy under ${XDG_CONFIG_HOME}/vsync/backups/<repo>/<env>.backup-<ts>/
// so the operator can `cp` files back if they realise they wanted to keep
// their edits.
//
// See docs/specs/v0.17-pull-safety.md §7.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { vsyncBaseDir } from "./defaults";
import { walkVault } from "./vaultwalk";

/** Compute the backup target dir for a (repo, env) at the current instant. */
export function backupDirPath(repo: string, env: string, now: Date = new Date()): string {
  // ISO-8601 with `:` replaced by `-` so the dir name is filesystem-safe on
  // every OS. UTC always.
  const iso = now.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
  return join(vsyncBaseDir(), "backups", repo, `${env}.backup-${iso}`);
}

/**
 * Recursively copy `vaultDir` to a fresh backup dir under XDG. Walks the tree
 * with vaultwalk first (raising SymlinkInVaultError on symlinks — `--backup`
 * doesn't get to ignore the symlink rule).
 *
 * Returns the destination path. Caller is expected to subsequently rm -rf
 * the original vault dir before pulling fresh content.
 */
export function backupVault(repo: string, env: string, vaultDir: string): string {
  if (!existsSync(vaultDir)) {
    // Nothing to back up — still create the empty dir so the operator sees
    // the path printed by --backup is consistent with the rest of the flow.
    const dest = backupDirPath(repo, env);
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    return dest;
  }
  // Pre-flight walk catches symlinks before we copy.
  walkVault(vaultDir);
  const dest = backupDirPath(repo, env);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  cpSync(vaultDir, dest, { recursive: true, preserveTimestamps: true });
  return dest;
}

/**
 * Count existing backup dirs for this (repo, env-wildcard) so status can warn
 * when too many accumulate.
 */
export function countBackups(repo: string): number {
  const dir = join(vsyncBaseDir(), "backups", repo);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".backup-") || n.includes(".backup-")).length;
  } catch {
    return 0;
  }
}

/** Helper for tests / cleanup scripts — wipe all backups for a repo. */
export function removeAllBackups(repo: string): void {
  const dir = join(vsyncBaseDir(), "backups", repo);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
