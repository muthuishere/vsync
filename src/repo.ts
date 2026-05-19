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
//   3. parsed `remote.origin.url` from git, normalized to <owner>_<repo>
//      (e.g. "git@github.com:Acme/web.git" → "acme_web")
//   4. basename of process.cwd() as a last resort
//   5. literal "default" if everything fails sanitization
//
// All file paths and the keychain account are derived from the resulting
// name, so it should be stable across machines for the same repo — and
// across worktrees / fresh checkouts of the same repo (this is why step 3
// uses the remote URL rather than the toplevel directory name).
//
// See docs/specs/v0.9-repo-name-resolution.md for the full rationale.

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
  const fromOverride = normalize(opts.override);
  if (fromOverride) return fromOverride;

  const fromEnv = normalize(process.env.SECRETS_SYNC_REPO);
  if (fromEnv) return fromEnv;

  const root = opts.root ?? (await getRepoRoot());

  const fromRemote = normalize(parseRemoteUrl(await readRemoteUrl(root)));
  if (fromRemote) return fromRemote;

  const fromCwd = normalize(path.basename(process.cwd()));
  if (fromCwd) return fromCwd;

  return "default";
}

/**
 * Parse a git remote URL into `<owner>/<repo>` (slashes intact — `normalize`
 * collapses them to `_`). Returns null when the URL isn't recognisable.
 *
 * Accepts SSH (`git@host:owner/repo.git`), HTTPS (with or without `.git`,
 * with or without basic-auth credentials), `ssh://` URLs, and `file://`
 * local clones (where the result is just the repo's bare name).
 */
export function parseRemoteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH shorthand: git@host:owner/repo.git
  const sshMatch = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  if (sshMatch) return stripDotGit(sshMatch[1]);

  // URL with scheme: ssh://, https://, http://, file://, git://
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\/(.+)$/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    let rest = schemeMatch[2];
    // Strip basic-auth credentials (user:token@host/…)
    const atIdx = rest.indexOf("@");
    const slashIdx = rest.indexOf("/");
    if (atIdx >= 0 && (slashIdx < 0 || atIdx < slashIdx)) {
      rest = rest.slice(atIdx + 1);
    }
    if (scheme === "file") {
      // file:///path/to/repo — no host or owner concept. Use the bare repo
      // directory name as the result.
      const segments = rest.split("/").filter((s) => s.length > 0);
      if (segments.length === 0) return null;
      return stripDotGit(segments[segments.length - 1]);
    }
    // Drop host segment (everything up to the first '/').
    const firstSlash = rest.indexOf("/");
    if (firstSlash < 0) return null;
    const pathPart = rest.slice(firstSlash + 1);
    if (!pathPart) return null;
    return stripDotGit(pathPart);
  }

  return null;
}

function stripDotGit(s: string): string {
  return s.replace(/\.git\/?$/, "");
}

/**
 * Read the URL of `origin` from the repo at `root`. Returns null on any
 * failure (no remote, command not on PATH, non-git directory).
 */
async function readRemoteUrl(root: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["git", "-C", root, "config", "--get", "remote.origin.url"],
      { stderr: "pipe", stdout: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) return null;
    const out = (await new Response(proc.stdout).text()).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Normalise a name to the canonical form: lowercase, with `/` and `-`
 * collapsed to `_`, then anything outside `[a-z0-9._]` stripped. Throws
 * if the result exceeds 100 characters (callers can recover by passing
 * `--repo=<short>` from the command line).
 */
export function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const lowered = value.trim().toLowerCase();
  if (!lowered) return null;
  const joined = lowered.replace(/[/-]+/g, "_");
  const stripped = joined.replace(/[^a-z0-9._]/g, "");
  if (!stripped) return null;
  if (stripped.length > 100) {
    throw new Error(
      `resolved repo name "${stripped.slice(0, 40)}…" exceeds 100 chars. ` +
        `Pass --repo=<short-name> to override.`,
    );
  }
  return stripped;
}
