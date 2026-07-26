// repo.ts — resolve the canonical repo identity used by config paths and
// the keychain.
//
// Precedence (first non-null wins). See docs/specs/v0.16-repo-identity-git-only.md.
//
//   Precondition: must be inside a git repository
//                 (git rev-parse --show-toplevel succeeds).
//                 Otherwise → NotInGitRepoError.
//
//   1. opts.override                   — explicit `--repo=<name>` flag.
//                                        Throws VsyncFileClobberError if it
//                                        differs from a present .vsync pin.
//   2. readVsyncFile(toplevel)         — committed .vsync at git toplevel.
//   3. parseRemoteUrl(origin)          — parsed `git config --get
//                                        remote.origin.url`, normalised.
//   4. ERROR (RepoIdentityUnresolvedError) — no remote set, no .vsync,
//                                            no flag.
//
// `getRepoRoot()` is the git toplevel; callers that need to consult or
// write the .vsync file pass it explicitly to readVsyncFile / writeVsyncFile.
//
// `vsync import` uses `getRepoNameForImport()` which substitutes the share
// file's embedded repo in place of step 3 (the share is more authoritative
// than the local origin for that one subcommand).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readVsyncFile, VsyncFileClobberError, vsyncFilePath } from "./vsyncfile";

/**
 * Filesystem path of the repo root (git toplevel).
 * Throws NotInGitRepoError if we're not inside a git tree.
 */
export async function getRepoRoot(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const code = await proc.exited;
  if (code === 0) {
    const out = (await new Response(proc.stdout).text()).trim();
    if (out) return out;
  }
  throw new NotInGitRepoError(process.cwd());
}

/**
 * Filesystem path the **vault folder** resolves against.
 *
 * Identical to `getRepoRoot()` in the main worktree. In a *linked* worktree
 * it returns the main worktree's toplevel instead, so every worktree shares
 * one vault rather than each maintaining its own copy.
 *
 * Rationale: the vault is machine state, not branch state. Resolving it
 * per-worktree meant `vsync pull` had to run once per worktree, producing N
 * independently-drifting plaintext copies of the same secrets — more disk
 * exposure and more ways to be out of date. One vault per checkout, shared
 * by every worktree, is both fewer copies and fewer surprises.
 *
 * Note this is deliberately NOT used for the committed `.vsync` identity pin
 * — that's a tracked file and belongs at the current worktree's toplevel,
 * where git expects it.
 */
export async function getVaultRoot(): Promise<string> {
  const toplevel = await getRepoRoot();
  const worktree = await detectWorktree(toplevel);
  return worktree ? worktree.mainToplevel : toplevel;
}

/**
 * Best-effort variant — returns null instead of throwing when not in a
 * git tree. Used by `vsync status` so it can still render a useful
 * "not in a git repo" message instead of erroring out.
 */
export async function tryGetRepoRoot(): Promise<string | null> {
  try {
    return await getRepoRoot();
  } catch {
    return null;
  }
}

export type RepoNameOptions = {
  /** Caller-supplied override (e.g. parsed from --repo=… flag). */
  override?: string;
  /** Repo root override (mostly for tests). Defaults to getRepoRoot(). */
  root?: string;
};

/**
 * Resolve the canonical repo name used by config file paths and keychain
 * entries. See the precedence chain at the top of this file.
 *
 * @throws NotInGitRepoError if not inside a git repository
 * @throws VsyncFileClobberError if a --repo override conflicts with a present .vsync
 * @throws VsyncFileMalformedError if .vsync exists but is unparseable
 * @throws RepoIdentityUnresolvedError if no source resolved to a name
 */
export async function getRepoName(
  opts: RepoNameOptions = {},
): Promise<string> {
  const root = opts.root ?? (await getRepoRoot());

  // .vsync may exist regardless of which source wins — read it first so we
  // can detect a flag-vs-file mismatch and throw the clobber error before
  // we proceed.
  const pinned = readVsyncFile(root); // null if absent; throws if malformed

  const fromOverride = normalize(opts.override);
  if (fromOverride) {
    if (pinned && pinned.repo !== fromOverride) {
      throw new VsyncFileClobberError(
        `${root}/.vsync`,
        pinned.repo,
        fromOverride,
      );
    }
    return fromOverride;
  }

  if (pinned) return pinned.repo;

  const remoteUrl = await readRemoteUrl(root);
  const fromRemote = normalize(parseRemoteUrl(remoteUrl));
  if (fromRemote) return fromRemote;

  throw new RepoIdentityUnresolvedError(root, remoteUrl);
}

/**
 * Variant for `vsync import`: substitutes the share file's embedded repo
 * for step 3 (origin URL parse). See spec §6.
 *
 * Precedence: --repo flag > .vsync > share's repo > ERROR
 */
export async function getRepoNameForImport(opts: {
  override?: string;
  root?: string;
  shareRepo: string;
}): Promise<string> {
  const root = opts.root ?? (await getRepoRoot());
  const pinned = readVsyncFile(root); // throws on malformed

  const fromOverride = normalize(opts.override);
  if (fromOverride) {
    if (pinned && pinned.repo !== fromOverride) {
      throw new VsyncFileClobberError(
        `${root}/.vsync`,
        pinned.repo,
        fromOverride,
      );
    }
    return fromOverride;
  }

  if (pinned) {
    // Special: if .vsync pins one repo but the share is for a different one,
    // refuse the import (likely wrong-share mistake — see spec §6.1 row 3).
    const shareNorm = normalize(opts.shareRepo);
    if (shareNorm && pinned.repo !== shareNorm) {
      const { ShareRepoMismatchError } = await import("./vsyncfile");
      // Note: caller knows the share path; we don't have it here. The bin/import
      // layer catches this and re-throws with the path filled in.
      throw new ShareRepoMismatchError(
        `${root}/.vsync`,
        "<share-file>",
        pinned.repo,
        shareNorm,
      );
    }
    return pinned.repo;
  }

  const fromShare = normalize(opts.shareRepo);
  if (fromShare) return fromShare;

  throw new RepoIdentityUnresolvedError(root, null);
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
export async function readRemoteUrl(root: string): Promise<string | null> {
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

/**
 * Detailed resolution: same precedence as getRepoName, but also reports which
 * source won (flag / file / auto) and the underlying context (toplevel, cwd,
 * origin URL, worktree info). Used by `vsync status` to display the source
 * to the operator.
 */
export interface RepoResolution {
  repo: string;
  source: "flag" | "file" | "auto";
  sourceDetail: string;
  toplevel: string;
  cwd: string;
  originUrl: string | null;
  worktree: { branch: string | null; mainToplevel: string } | null;
}

export async function resolveRepoWithSource(opts: {
  override?: string;
  root?: string;
} = {}): Promise<RepoResolution> {
  const cwd = process.cwd();
  const toplevel = opts.root ?? (await getRepoRoot());
  const originUrl = await readRemoteUrl(toplevel);
  const worktree = await detectWorktree(toplevel);
  const pinned = readVsyncFile(toplevel);
  const fromOverride = normalize(opts.override);

  if (fromOverride) {
    if (pinned && pinned.repo !== fromOverride) {
      throw new VsyncFileClobberError(
        vsyncFilePath(toplevel),
        pinned.repo,
        fromOverride,
      );
    }
    return {
      repo: fromOverride,
      source: "flag",
      sourceDetail: `--repo=${fromOverride}`,
      toplevel,
      cwd,
      originUrl,
      worktree,
    };
  }

  if (pinned) {
    return {
      repo: pinned.repo,
      source: "file",
      sourceDetail: vsyncFilePath(toplevel),
      toplevel,
      cwd,
      originUrl,
      worktree,
    };
  }

  const fromRemote = normalize(parseRemoteUrl(originUrl));
  if (fromRemote) {
    return {
      repo: fromRemote,
      source: "auto",
      sourceDetail: `parsed from origin: ${originUrl}`,
      toplevel,
      cwd,
      originUrl,
      worktree,
    };
  }

  throw new RepoIdentityUnresolvedError(toplevel, originUrl);
}

/**
 * Detect whether `toplevel` is a linked git worktree. Returns null for the
 * main worktree (no special-casing needed). Returns { branch, mainToplevel }
 * for linked worktrees.
 */
async function detectWorktree(
  toplevel: string,
): Promise<{ branch: string | null; mainToplevel: string } | null> {
  try {
    const proc = Bun.spawn(
      ["git", "-C", toplevel, "rev-parse", "--git-common-dir"],
      { stderr: "pipe", stdout: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) return null;
    const commonDir = (await new Response(proc.stdout).text()).trim();
    if (!commonDir) return null;
    // Normalise to absolute path
    const absCommon = commonDir.startsWith("/")
      ? commonDir
      : join(toplevel, commonDir);
    // Main worktree's .git is `<toplevel>/.git`. Linked worktrees have a
    // common-dir that points elsewhere (e.g. main repo's .git/worktrees/...).
    const mainGit = join(toplevel, ".git");
    if (absCommon === mainGit || absCommon === `${mainGit}/`) return null;
    // We're in a linked worktree. The mainToplevel is the parent of the
    // common-dir.
    const mainToplevel = absCommon.replace(/\/\.git\/?$/, "");
    if (!existsSync(mainToplevel)) return null;
    // Read current branch
    let branch: string | null = null;
    try {
      const branchProc = Bun.spawn(
        ["git", "-C", toplevel, "rev-parse", "--abbrev-ref", "HEAD"],
        { stderr: "pipe", stdout: "pipe" },
      );
      if ((await branchProc.exited) === 0) {
        const out = (await new Response(branchProc.stdout).text()).trim();
        if (out && out !== "HEAD") branch = out;
      }
    } catch {
      // ignore
    }
    return { branch, mainToplevel };
  } catch {
    return null;
  }
}

/**
 * Thrown by the resolver when `git rev-parse --show-toplevel` fails (we're
 * not inside any git repository).
 */
export class NotInGitRepoError extends Error {
  constructor(public readonly cwd: string) {
    super(
      `✗ vsync requires a git repository.\n\n` +
        `  cwd: ${cwd}\n\n` +
        `  Run \`git init\` and \`git remote add origin <url>\` to set up,\n` +
        `  or \`cd\` into an existing git tree before running vsync.`,
    );
    this.name = "NotInGitRepoError";
  }
}

/**
 * Thrown when we're inside a git tree but no source (--repo flag, .vsync
 * file, origin URL) resolved to a repo identity.
 */
export class RepoIdentityUnresolvedError extends Error {
  constructor(
    public readonly toplevel: string,
    public readonly originUrl: string | null,
  ) {
    super(
      `✗ Cannot resolve repo identity.\n\n` +
        `  toplevel:      ${toplevel}\n` +
        `  origin remote: ${originUrl ?? "not set"}\n` +
        `  .vsync file:   not present\n` +
        `  --repo flag:   not passed\n\n` +
        `  Either:\n` +
        `    - run \`git remote add origin <url>\` to derive identity from the remote, then re-run, OR\n` +
        `    - run \`vsync init <env> --repo=<name>\` to pin the identity explicitly, OR\n` +
        `    - pass \`--repo=<name>\` on this command for a one-shot rename.`,
    );
    this.name = "RepoIdentityUnresolvedError";
  }
}
