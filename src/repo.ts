// repo.ts — utilities for working out which repo we're running in.
//
// Two things consumers need:
//   - getRepoRoot()   — the filesystem path of the repo top-level
//   - getRepoName()   — a short identifier used as the namespace for the
//                       config file and keychain entry
//
// Repo-name precedence (first match wins):
//   1. Explicit override (e.g. `--repo=foo` flag passed through)
//   2. SECRETS_SYNC_REPO env var
//   3. `name` from package.json at the repo root, with any leading scope
//      stripped (e.g. "@muthuishere/secret-lib" → "secret-lib")
//   4. basename of the git remote / git toplevel (e.g. "reqsume")
//   5. basename of process.cwd() as a last resort
//
// All four file-paths and the keychain account are derived from the
// resulting name, so it should be stable across machines for the same
// repo.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Filesystem path of the repo root (git toplevel, else cwd). */
export async function getRepoRoot(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const code = await proc.exited;
  if (code === 0) {
    return (await new Response(proc.stdout).text()).trim();
  }
  return process.cwd();
}

export type RepoNameOptions = {
  /** Caller-supplied override (e.g. parsed from --repo=… flag). */
  override?: string;
  /** Repo root override (mostly for tests). Defaults to getRepoRoot(). */
  root?: string;
};

/**
 * Resolve the canonical repo name used by config file paths and keychain
 * entries. See the precedence list at the top of this file.
 */
export async function getRepoName(
  opts: RepoNameOptions = {},
): Promise<string> {
  const fromOverride = sanitize(opts.override);
  if (fromOverride) return fromOverride;

  const fromEnv = sanitize(process.env.SECRETS_SYNC_REPO);
  if (fromEnv) return fromEnv;

  const root = opts.root ?? (await getRepoRoot());

  const fromPkg = sanitize(await readPackageName(root));
  if (fromPkg) return fromPkg;

  const fromGit = sanitize(path.basename(root));
  if (fromGit) return fromGit;

  return sanitize(path.basename(process.cwd())) || "default";
}

async function readPackageName(root: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path.join(root, "package.json"), "utf8");
    const parsed = JSON.parse(buf);
    const name: unknown = parsed?.name;
    if (typeof name !== "string" || !name) return null;
    // Strip npm scope: "@scope/foo" → "foo"
    const slash = name.indexOf("/");
    return slash >= 0 ? name.slice(slash + 1) : name;
  } catch {
    return null;
  }
}

/**
 * Allow letters, digits, underscore, hyphen, and dot. Strip anything else.
 * Empty result returns null so callers fall through to the next source.
 */
function sanitize(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/[^A-Za-z0-9._-]/g, "");
  return trimmed || null;
}
