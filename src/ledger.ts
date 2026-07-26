// ledger.ts — per-(repo, env) machine-local sync state.
//
// The ledger records what the vault folder looked like at the last
// successful pull or push, plus the remote generation it corresponded to.
// On the next pull, the resolver walks the live vault, diffs against the
// ledger, and refuses if there are local edits. On the next push, the
// ledger's `generation` is compared to the remote's HEAD to detect that
// a teammate has pushed since our last sync.
//
// See docs/specs/v0.17-pull-safety.md for the full design.
//
// Schema: see Ledger type below. Mode 0600. Atomic write via tmp+rename.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { vsyncBaseDir } from "./defaults";
import { assertUsableRepoName } from "./repoconfig";
import { walkVault, type VaultEntry } from "./vaultwalk";

export interface LedgerFileEntry {
  mtime_ms: number;
  size: number;
}

export interface Ledger {
  v: 1;
  /**
   * The remote bundle's version timestamp at last sync. Lexicographically
   * comparable (format YYYYMMDD-HHmmss). Drives the lost-update guard on push.
   */
  last_sync_ts: string;
  /** ISO-8601 wall-clock time of the last sync operation. */
  last_sync_at: string;
  last_sync_op: "pull" | "push";
  files: Record<string, LedgerFileEntry>;
}

export function ledgerPath(repo: string, env: string): string {
  // Same reserved-name collision as configFilePath — the ledger lives in the
  // per-repo dir too, so `profiles`/`backups` would land it inside vsync's
  // own state directories.
  assertUsableRepoName(repo);
  return join(vsyncBaseDir(), repo, `env_${env}.ledger.json`);
}

/**
 * Read the ledger for a (repo, env). Returns null if the file is absent.
 * Throws LedgerMalformedError on parse failure, wrong v, or missing fields.
 */
export function readLedger(repo: string, env: string): Ledger | null {
  const path = ledgerPath(repo, env);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf-8");
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new LedgerMalformedError(path, `not valid JSON: ${(err as Error).message}`);
  }
  if (parsed.v !== 1) {
    throw new LedgerMalformedError(path, `unsupported version v=${parsed.v} (expected 1)`);
  }
  if (typeof parsed.last_sync_ts !== "string") {
    throw new LedgerMalformedError(path, `missing "last_sync_ts"`);
  }
  if (typeof parsed.last_sync_at !== "string") {
    throw new LedgerMalformedError(path, `missing "last_sync_at"`);
  }
  if (parsed.last_sync_op !== "pull" && parsed.last_sync_op !== "push") {
    throw new LedgerMalformedError(path, `"last_sync_op" must be "pull" or "push"`);
  }
  if (typeof parsed.files !== "object" || parsed.files === null) {
    throw new LedgerMalformedError(path, `"files" must be an object`);
  }
  // Validate per-file entries
  for (const [key, val] of Object.entries(parsed.files)) {
    if (key.startsWith("/") || key.includes("..") || key.includes("\\")) {
      throw new LedgerMalformedError(
        path,
        `"files" key "${key}" is not a safe POSIX relative path`,
      );
    }
    const v = val as any;
    if (typeof v?.mtime_ms !== "number" || typeof v?.size !== "number") {
      throw new LedgerMalformedError(
        path,
        `"files[${key}]" must be {mtime_ms: number, size: number}`,
      );
    }
  }
  return parsed as Ledger;
}

/**
 * Atomically write the ledger. Uses tmp+rename so the file is never
 * partially written (a SIGKILL during writeFileSync would leave a half-file).
 * Creates parent dirs as needed.
 */
export function writeLedger(repo: string, env: string, ledger: Ledger): void {
  const path = ledgerPath(repo, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  const content = JSON.stringify(ledger, null, 2);
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Remove the ledger (no-op if absent). */
export function deleteLedger(repo: string, env: string): void {
  const path = ledgerPath(repo, env);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

/**
 * Build a Ledger from a fresh walk of the vault folder, with the given
 * generation and op. Caller writes it via writeLedger().
 */
export function snapshotLedger(
  vaultDir: string,
  syncTs: string,
  op: "pull" | "push",
): Ledger {
  const entries = walkVault(vaultDir);
  const files: Record<string, LedgerFileEntry> = {};
  for (const e of entries) {
    files[e.rel] = {
      mtime_ms: e.stat.mtimeMs,
      size: e.stat.size,
    };
  }
  return {
    v: 1,
    last_sync_ts: syncTs,
    last_sync_at: new Date().toISOString(),
    last_sync_op: op,
    files,
  };
}

export type DirtyDiff =
  | { kind: "clean" }
  | { kind: "untracked" }
  | {
      kind: "dirty";
      modified: string[];
      added: string[];
      deleted: string[];
    };

/**
 * Compare the current vault state against the ledger. Returns a structured
 * diff. SymlinkInVaultError propagates from walkVault if present.
 *
 * Cost: O(n) where n = file count in vault. One stat() per file.
 */
export function checkDirty(vaultDir: string, ledger: Ledger | null): DirtyDiff {
  if (!ledger) return { kind: "untracked" };

  if (!existsSync(vaultDir)) {
    // Whole vault dir gone — every ledger entry is "deleted".
    const deleted = Object.keys(ledger.files);
    if (deleted.length === 0) return { kind: "clean" };
    return { kind: "dirty", modified: [], added: [], deleted };
  }

  const seen = new Set<string>();
  const modified: string[] = [];
  const added: string[] = [];

  let entries: VaultEntry[];
  try {
    entries = walkVault(vaultDir);
  } catch (err) {
    throw err; // SymlinkInVaultError — bubble up
  }

  for (const e of entries) {
    seen.add(e.rel);
    const expected = ledger.files[e.rel];
    if (!expected) {
      added.push(e.rel);
    } else if (
      e.stat.mtimeMs !== expected.mtime_ms ||
      e.stat.size !== expected.size
    ) {
      modified.push(e.rel);
    }
  }

  const deleted: string[] = [];
  for (const rel of Object.keys(ledger.files)) {
    if (!seen.has(rel)) deleted.push(rel);
  }

  if (modified.length === 0 && added.length === 0 && deleted.length === 0) {
    return { kind: "clean" };
  }
  return {
    kind: "dirty",
    modified: modified.sort(),
    added: added.sort(),
    deleted: deleted.sort(),
  };
}

/**
 * Thrown when the ledger file exists but is unparseable / wrong version /
 * missing required fields.
 */
export class LedgerMalformedError extends Error {
  constructor(
    public readonly path: string,
    detail: string,
  ) {
    super(
      `✗ ledger at ${path} is malformed.\n\n` +
        `  detail: ${detail}\n\n` +
        `  Fix the file or delete it and re-run \`vsync pull <env>\`.`,
    );
    this.name = "LedgerMalformedError";
  }
}

/**
 * Thrown when `vsync pull` detects local changes that don't match the ledger.
 * Carries the structured diff so the CLI can format the error message with
 * per-category file lists.
 */
export class LocalDirtyError extends Error {
  constructor(
    public readonly env: string,
    public readonly vaultDir: string,
    public readonly ledger: Ledger,
    public readonly diff: Extract<DirtyDiff, { kind: "dirty" }>,
  ) {
    const fmt = (label: string, files: string[]): string => {
      if (files.length === 0) return "";
      const shown = files.slice(0, 20);
      const more = files.length > 20 ? `\n    ... and ${files.length - 20} more` : "";
      return (
        `\n  ${label} (${files.length}):\n` +
        shown.map((f) => `    ${f}`).join("\n") +
        more
      );
    };
    super(
      `✗ Local vault has unsynced changes — refusing to overwrite.\n\n` +
        `  env:       ${env}\n` +
        `  vault:     ${vaultDir}\n` +
        `  last sync: ${ledger.last_sync_op} at ${ledger.last_sync_at} (ts ${ledger.last_sync_ts})\n` +
        fmt("modified", diff.modified) +
        fmt("added", diff.added) +
        fmt("deleted", diff.deleted) +
        `\n\nTo proceed:\n\n` +
        `  vsync push ${env}                # if these edits ARE the intended state\n` +
        `  vsync pull ${env} --backup       # snapshot current vault, then pull\n` +
        `  vsync pull ${env} --force        # discard local edits (DANGEROUS — no backup)`,
    );
    this.name = "LocalDirtyError";
  }
}

/**
 * Thrown when `vsync push` detects that the remote generation has advanced
 * past the ledger's generation (a teammate or earlier process pushed since
 * our last sync). Push refuses by default; `--force` overrides.
 */
export class RemoteAheadError extends Error {
  constructor(
    public readonly env: string,
    public readonly localTs: string,
    public readonly remoteTs: string,
    public readonly ledger: Ledger,
  ) {
    super(
      `✗ Remote has new changes since your last sync — refusing to push.\n\n` +
        `  env:              ${env}\n` +
        `  your last sync:   ${ledger.last_sync_op} at ${ledger.last_sync_at} (ts ${localTs})\n` +
        `  remote currently: ts ${remoteTs}\n\n` +
        `Someone (you or a teammate) pushed since your last sync.\n\n` +
        `To proceed:\n\n` +
        `  vsync pull ${env}                # fetch their changes (will flag dirty if you also edited)\n` +
        `  vsync push ${env} --force        # overwrite their work (DANGEROUS — they lose data)`,
    );
    this.name = "RemoteAheadError";
  }
}
