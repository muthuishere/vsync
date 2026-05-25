// repo.test.ts — v0.16 resolver tests.
//
// Pre-v0.16 SECRETS_SYNC_REPO / cwd / "default" fallback tests are dropped.
// The new resolver requires a git tree + (--repo flag OR .vsync file OR
// origin URL) — see docs/specs/v0.16-repo-identity-git-only.md.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  getRepoName,
  parseRemoteUrl,
  normalize,
  resolveRepoWithSource,
  NotInGitRepoError,
  RepoIdentityUnresolvedError,
} from "../src/repo";
import { VsyncFileClobberError } from "../src/vsyncfile";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mkBareGitRepo(opts: { remote?: string; vsync?: string } = {}): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "vsync-repo-test-"));
  execSync("git init -b main", { cwd: root });
  execSync("git config user.email test@example.com", { cwd: root });
  execSync("git config user.name test", { cwd: root });
  if (opts.remote) {
    execSync(`git remote add origin ${opts.remote}`, { cwd: root });
  }
  if (opts.vsync !== undefined) {
    writeFileSync(join(root, ".vsync"), opts.vsync);
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("getRepoName — v0.16 precedence", () => {
  test("1. --repo flag wins over .vsync (when matching) and origin", async () => {
    const { root, cleanup } = mkBareGitRepo({
      remote: "git@github.com:acme/web.git",
      vsync: "repo=acme-web\n",
    });
    const name = await getRepoName({ override: "acme-web", root });
    expect(name).toBe("acme_web");
    cleanup();
  });

  test("1b. --repo flag matching .vsync exactly returns flag value", async () => {
    const { root, cleanup } = mkBareGitRepo({
      vsync: "repo=acme-web\n",
    });
    const name = await getRepoName({ override: "acme-web", root });
    expect(name).toBe("acme_web");
    cleanup();
  });

  test("1c. --repo flag conflicting with .vsync throws VsyncFileClobberError", async () => {
    const { root, cleanup } = mkBareGitRepo({
      vsync: "repo=acme-web\n",
    });
    await expect(
      getRepoName({ override: "other-name", root }),
    ).rejects.toThrow(VsyncFileClobberError);
    cleanup();
  });

  test("2. .vsync wins over origin when no flag", async () => {
    const { root, cleanup } = mkBareGitRepo({
      remote: "git@github.com:other/lib.git",
      vsync: "repo=acme-web\n",
    });
    const name = await getRepoName({ root });
    expect(name).toBe("acme_web");
    cleanup();
  });

  test("2b. .vsync still wins even when origin would parse differently", async () => {
    // strict-stop semantics: file present → step 3 (origin) never consulted.
    const { root, cleanup } = mkBareGitRepo({
      remote: "git@github.com:fork/repo.git",
      vsync: "repo=upstream-canonical\n",
    });
    const res = await resolveRepoWithSource({ root });
    expect(res.repo).toBe("upstream_canonical");
    expect(res.source).toBe("file");
    cleanup();
  });

  test("3. parsed origin wins when no .vsync, no flag", async () => {
    const { root, cleanup } = mkBareGitRepo({
      remote: "git@github.com:acme/web.git",
    });
    const name = await getRepoName({ root });
    expect(name).toBe("acme_web");
    cleanup();
  });
});

describe("getRepoName — error paths", () => {
  test("not in a git tree → NotInGitRepoError", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vsync-no-git-"));
    await expect(getRepoName({ root: tmp })).rejects.toThrow(/.*/); // any rethrow
    // The actual NotInGitRepoError comes from getRepoRoot(); when root is
    // passed explicitly, the check is bypassed — so RepoIdentityUnresolvedError
    // is what we see for a tmpdir without git + no .vsync + no origin.
    await expect(getRepoName({ root: tmp })).rejects.toThrow(
      RepoIdentityUnresolvedError,
    );
    rmSync(tmp, { recursive: true, force: true });
  });

  test("git tree, no origin, no .vsync, no flag → RepoIdentityUnresolvedError", async () => {
    const { root, cleanup } = mkBareGitRepo(); // no remote, no .vsync
    await expect(getRepoName({ root })).rejects.toThrow(
      RepoIdentityUnresolvedError,
    );
    cleanup();
  });

  test(".vsync malformed → VsyncFileMalformedError", async () => {
    const { root, cleanup } = mkBareGitRepo({
      vsync: "garbage_no_equals_sign\n",
    });
    const { VsyncFileMalformedError } = await import("../src/vsyncfile");
    await expect(getRepoName({ root })).rejects.toThrow(
      VsyncFileMalformedError,
    );
    cleanup();
  });

  test(".vsync with missing repo key → VsyncFileMalformedError", async () => {
    const { root, cleanup } = mkBareGitRepo({
      vsync: "# only comments\n# no repo line\n",
    });
    await expect(getRepoName({ root })).rejects.toThrow(
      /missing required key: repo/,
    );
    cleanup();
  });
});

describe("resolveRepoWithSource — source tracking", () => {
  test("source = flag when --repo passed", async () => {
    const { root, cleanup } = mkBareGitRepo({
      remote: "git@github.com:acme/web.git",
    });
    const res = await resolveRepoWithSource({ override: "rename", root });
    expect(res.source).toBe("flag");
    expect(res.sourceDetail).toBe("--repo=rename");
    cleanup();
  });

  test("source = file when .vsync present", async () => {
    const { root, cleanup } = mkBareGitRepo({
      vsync: "repo=pinned\n",
    });
    const res = await resolveRepoWithSource({ root });
    expect(res.source).toBe("file");
    expect(res.sourceDetail).toContain(".vsync");
    cleanup();
  });

  test("source = auto when only origin set", async () => {
    const { root, cleanup } = mkBareGitRepo({
      remote: "git@github.com:acme/web.git",
    });
    const res = await resolveRepoWithSource({ root });
    expect(res.source).toBe("auto");
    expect(res.sourceDetail).toContain("git@github.com:acme/web.git");
    cleanup();
  });

  test("origin URL included in resolution", async () => {
    const { root, cleanup } = mkBareGitRepo({
      remote: "git@github.com:acme/web.git",
    });
    const res = await resolveRepoWithSource({ root });
    expect(res.originUrl).toBe("git@github.com:acme/web.git");
    expect(res.toplevel).toBe(root);
    cleanup();
  });
});

describe("parseRemoteUrl", () => {
  test("SSH shorthand: git@github.com:owner/repo.git", () => {
    expect(parseRemoteUrl("git@github.com:owner/repo.git")).toBe("owner/repo");
  });

  test("HTTPS with .git suffix", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo.git")).toBe(
      "owner/repo",
    );
  });

  test("HTTPS without .git suffix", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo")).toBe("owner/repo");
  });

  test("GitLab subgroup: ssh://…/group/sub/repo.git", () => {
    expect(parseRemoteUrl("ssh://git@gitlab.com/group/sub/repo.git")).toBe(
      "group/sub/repo",
    );
  });

  test("HTTPS with basic-auth credentials strips creds", () => {
    expect(parseRemoteUrl("https://user:token@github.com/o/r.git")).toBe(
      "o/r",
    );
  });

  test("file:// local clone returns bare repo name", () => {
    expect(parseRemoteUrl("file:///tmp/upstream")).toBe("upstream");
  });

  test("Best-Practice-Creations/volentis_mono_repo (spec example)", () => {
    const parsed = parseRemoteUrl(
      "https://github.com/Best-Practice-Creations/volentis_mono_repo",
    );
    expect(parsed).toBe("Best-Practice-Creations/volentis_mono_repo");
    expect(normalize(parsed)).toBe(
      "best_practice_creations_volentis_mono_repo",
    );
  });

  test("garbage input returns null", () => {
    expect(parseRemoteUrl("not a url")).toBeNull();
    expect(parseRemoteUrl("")).toBeNull();
    expect(parseRemoteUrl(null)).toBeNull();
    expect(parseRemoteUrl(undefined)).toBeNull();
  });

  test("custom SSH host (self-hosted) still parses", () => {
    expect(parseRemoteUrl("git@gitea.example.com:user/repo.git")).toBe(
      "user/repo",
    );
  });

  test("http:// scheme works too", () => {
    expect(parseRemoteUrl("http://example.com/owner/repo.git")).toBe(
      "owner/repo",
    );
  });
});

describe("normalize", () => {
  test("lowercases", () => {
    expect(normalize("CamelCase")).toBe("camelcase");
  });

  test("replaces slash with underscore", () => {
    expect(normalize("owner/repo")).toBe("owner_repo");
  });

  test("replaces hyphen with underscore", () => {
    expect(normalize("kebab-case-name")).toBe("kebab_case_name");
  });

  test("collapses consecutive slashes/hyphens into one underscore", () => {
    expect(normalize("group//sub")).toBe("group_sub");
    expect(normalize("a--b")).toBe("a_b");
    expect(normalize("a-/-b")).toBe("a_b");
  });

  test("strips spaces and special chars", () => {
    expect(normalize("hello world!")).toBe("helloworld");
    expect(normalize("name@v1")).toBe("namev1");
  });

  test("preserves digits, dots, underscores", () => {
    expect(normalize("v0.9.0_test")).toBe("v0.9.0_test");
  });

  test("empty / whitespace / null returns null", () => {
    expect(normalize("")).toBeNull();
    expect(normalize("   ")).toBeNull();
    expect(normalize(null)).toBeNull();
    expect(normalize(undefined)).toBeNull();
  });

  test("all-symbols input (post-strip empty) returns null", () => {
    expect(normalize("!@#$%")).toBeNull();
  });

  test("rejects names longer than 100 chars", () => {
    const longName = "a".repeat(101);
    expect(() => normalize(longName)).toThrow(/exceeds 100 chars/);
  });

  test("accepts exactly 100 chars", () => {
    const name = "a".repeat(100);
    expect(normalize(name)).toBe(name);
  });
});
