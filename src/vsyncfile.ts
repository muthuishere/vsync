// vsyncfile.ts — read / write the committed `.vsync` identity pin file.
//
// `.vsync` is an `.env`-style file at the git toplevel that pins the repo
// identity for the whole team. The file is committed; first teammate's
// `vsync init` writes it, every subsequent clone reads it without ceremony.
//
// Format (one `key=value` per line, no quotes, no inline comments):
//
//     # .vsync — vsync identity pin (commit this file)
//     # Docs: https://muthuishere.github.io/vsync/architecture/repo-identity
//     repo=acme-web
//
// Grammar — intentionally narrow:
//   - Keys:   [A-Za-z_][A-Za-z0-9_]*
//   - Values: literal — everything after `=` to end-of-line, trimmed of
//             trailing whitespace. No quotes, no escapes.
//   - Comments: lines starting with `#` (after optional whitespace).
//     NO INLINE COMMENTS — `repo=foo # bar` makes the value `foo # bar`.
//   - Duplicate keys: last wins.
//   - Unknown keys: ignored silently (forward-compat).
//   - Missing required `repo`: error.
//
// See docs/specs/v0.16-repo-identity-git-only.md §3 for the full rationale.
//
// This module does not consult `process.cwd()`, env vars, or any other
// source — callers must supply the git toplevel path explicitly.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalize } from "./repo";

/** Path to the .vsync file under a given git toplevel. */
export function vsyncFilePath(toplevel: string): string {
  return join(toplevel, ".vsync");
}

/**
 * Parse a .vsync file's text content into a key/value map.
 * Returns null only if `text` is empty (which the caller should not pass).
 * On malformed content (no `repo` key, unparseable line shape), throws
 * VsyncFileMalformedError.
 */
export function parseVsyncFile(
  text: string,
  pathHint: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = raw.indexOf("=");
    if (eq < 0) {
      throw new VsyncFileMalformedError(
        pathHint,
        `line has no '=': ${raw.slice(0, 80)}`,
      );
    }

    const key = raw.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new VsyncFileMalformedError(
        pathHint,
        `invalid key on line "${raw.slice(0, 80)}" (must match [A-Za-z_][A-Za-z0-9_]*)`,
      );
    }

    // Value = everything after '=' up to end-of-line, trimmed of trailing
    // whitespace only. Leading whitespace is part of the value (rare; the
    // operator who wrote `repo=  acme` meant the spaces).
    const value = raw.slice(eq + 1).replace(/\s+$/, "");
    result[key] = value; // duplicate keys: last wins
  }
  return result;
}

/** Contents of a .vsync file. Only the `repo` field is required. */
export interface VsyncFile {
  repo: string;
  /** Any keys we don't recognise — preserved on rewrite for forward-compat. */
  unknown: Record<string, string>;
}

/**
 * Read and parse the .vsync file at `<toplevel>/.vsync`.
 * Returns null if the file does not exist.
 * Throws VsyncFileMalformedError if the file is unparseable or missing `repo`.
 */
export function readVsyncFile(toplevel: string): VsyncFile | null {
  const path = vsyncFilePath(toplevel);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf-8");
  const map = parseVsyncFile(text, path);

  const repoRaw = map["repo"];
  if (repoRaw === undefined || repoRaw === "") {
    throw new VsyncFileMalformedError(path, "missing required key: repo");
  }
  const repo = normalize(repoRaw);
  if (!repo) {
    throw new VsyncFileMalformedError(
      path,
      `repo value "${repoRaw}" fails normalisation (must match [a-z0-9._]+, ≤100 chars)`,
    );
  }

  const unknown: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k !== "repo") unknown[k] = v;
  }

  return { repo, unknown };
}

/**
 * Write the .vsync file at `<toplevel>/.vsync` with the given repo identity.
 *
 * Behaviour:
 *   - File absent → write it, return { written: true }.
 *   - File present, `repo=` matches → no-op, return { written: false }.
 *   - File present, `repo=` differs → throw VsyncFileClobberError.
 *   - File present, malformed → throw VsyncFileMalformedError (caller's
 *     malformed file remains untouched; let the operator fix it).
 *
 * Unknown keys in an existing file are preserved when the matching write
 * is a no-op. (A differing write throws — no unknown-key preservation path
 * exists because we never proceed with that case.)
 */
export function writeVsyncFile(
  toplevel: string,
  repo: string,
): { written: boolean } {
  const path = vsyncFilePath(toplevel);
  const existing = readVsyncFile(toplevel); // throws on malformed
  if (existing) {
    if (existing.repo === repo) return { written: false };
    throw new VsyncFileClobberError(path, existing.repo, repo);
  }

  const content =
    "# .vsync — vsync identity pin (commit this file)\n" +
    "# Docs: https://muthuishere.github.io/vsync/architecture/repo-identity\n" +
    `repo=${repo}\n`;
  writeFileSync(path, content, { mode: 0o644 });
  return { written: true };
}

/**
 * Thrown when `.vsync` exists but its contents are unparseable, missing
 * the required `repo` key, or carry a `repo=` value that fails normalisation.
 */
export class VsyncFileMalformedError extends Error {
  constructor(
    public readonly path: string,
    detail: string,
  ) {
    super(
      `✗ .vsync at ${path} is malformed.\n\n` +
        `  expected: one \`key=value\` per line, with at least\n` +
        `            repo=<name>\n\n` +
        `  detail:   ${detail}\n\n` +
        `  Fix the file or delete it and re-run \`vsync init\`.`,
    );
    this.name = "VsyncFileMalformedError";
  }
}

/**
 * Thrown when `init` / `import` was called with `--repo=<X>` while the
 * checkout already has a committed `.vsync` pinning a different identity.
 * Refusing to overwrite is intentional: silently rewriting a committed
 * team contract on one operator's machine would corrupt the next clone.
 */
export class VsyncFileClobberError extends Error {
  constructor(
    public readonly path: string,
    public readonly currentRepo: string,
    public readonly attemptedRepo: string,
  ) {
    super(
      `✗ .vsync pins identity to \`${currentRepo}\`, but ` +
        `--repo=${attemptedRepo} was passed.\n\n` +
        `  file: ${path}\n\n` +
        `This file is committed and shared with the team. To rename the identity\n` +
        `team-wide, edit .vsync in a commit (or delete it and re-run \`vsync init\`).\n` +
        `To use a different identity locally for one command, do not pass --repo\n` +
        `on a checkout that has a .vsync — the two are incompatible by design.`,
    );
    this.name = "VsyncFileClobberError";
  }
}

/**
 * Thrown by `vsync import` when the local `.vsync` pins one identity but
 * the share file declares a different one. Almost certainly a wrong-share
 * mistake; refuse the import rather than silently mixing vaults.
 */
export class ShareRepoMismatchError extends Error {
  constructor(
    public readonly vsyncPath: string,
    public readonly sharePath: string,
    public readonly pinnedRepo: string,
    public readonly shareRepo: string,
  ) {
    super(
      `✗ .vsync pins identity to \`${pinnedRepo}\`, but the share file ` +
        `declares \`${shareRepo}\`.\n\n` +
        `  share:  ${sharePath}\n` +
        `  .vsync: ${vsyncPath}\n\n` +
        `This share was exported from a different repo. Importing it here would\n` +
        `mix unrelated vaults under one identity.\n\n` +
        `Either:\n` +
        `  - check you have the right share file, OR\n` +
        `  - delete .vsync and re-run if you really mean to take over this checkout, OR\n` +
        `  - pass --repo=<X> if you want to import this share under a renamed\n` +
        `    local identity (the flag overrides both file and share).`,
    );
    this.name = "ShareRepoMismatchError";
  }
}
