import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { getRepoName, parseRemoteUrl, normalize } from "../src/repo";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalRepoEnv: string | undefined;

beforeEach(() => {
  originalRepoEnv = process.env.SECRETS_SYNC_REPO;
  delete process.env.SECRETS_SYNC_REPO;
});

afterEach(() => {
  if (originalRepoEnv === undefined) delete process.env.SECRETS_SYNC_REPO;
  else process.env.SECRETS_SYNC_REPO = originalRepoEnv;
});

function mkTmpRoot(): string {
  // Plain temp dir with no git remote configured — readRemoteUrl returns
  // null, so the resolver falls through to cwd basename.
  return mkdtempSync(join(tmpdir(), "vsync-repo-"));
}

describe("getRepoName precedence", () => {
  test("1. explicit override wins over env and remote", async () => {
    process.env.SECRETS_SYNC_REPO = "fromenv";
    const name = await getRepoName({ override: "fromflag", root: mkTmpRoot() });
    expect(name).toBe("fromflag");
  });

  test("2. SECRETS_SYNC_REPO env wins over remote/cwd", async () => {
    process.env.SECRETS_SYNC_REPO = "fromenv";
    const name = await getRepoName({ root: mkTmpRoot() });
    expect(name).toBe("fromenv");
  });

  test("3. fall through to cwd basename when no override/env/remote", async () => {
    const root = mkTmpRoot();
    const name = await getRepoName({ root });
    // process.cwd() basename — whichever the test runner is in.
    expect(name).toBeTruthy();
    expect(name).toMatch(/^[a-z0-9._]+$/);
  });

  test("empty override falls through to next source", async () => {
    process.env.SECRETS_SYNC_REPO = "fromenv";
    const name = await getRepoName({ override: "" });
    expect(name).toBe("fromenv");
  });

  test("override goes through normalize (lowercases, replaces /, -)", async () => {
    const name = await getRepoName({ override: "Acme-Org/Web-App" });
    expect(name).toBe("acme_org_web_app");
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
