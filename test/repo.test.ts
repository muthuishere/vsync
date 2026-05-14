import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { getRepoName } from "../src/repo";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
  return mkdtempSync(join(tmpdir(), "secret-lib-repo-"));
}

describe("getRepoName precedence", () => {
  test("1. explicit override wins", async () => {
    process.env.SECRETS_SYNC_REPO = "from-env";
    const name = await getRepoName({ override: "from-flag", root: mkTmpRoot() });
    expect(name).toBe("from-flag");
  });

  test("2. SECRETS_SYNC_REPO env wins over package.json", async () => {
    process.env.SECRETS_SYNC_REPO = "from-env";
    const root = mkTmpRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "from-pkg" }),
    );
    const name = await getRepoName({ root });
    expect(name).toBe("from-env");
  });

  test("3. package.json::name when no override/env (strips scope)", async () => {
    const root = mkTmpRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@muthuishere/cool-thing" }),
    );
    const name = await getRepoName({ root });
    expect(name).toBe("cool-thing");
  });

  test("4. git basename when no package.json", async () => {
    const root = mkTmpRoot();
    // no package.json
    const name = await getRepoName({ root });
    // root is /tmp/secret-lib-repo-XXXX → basename starts with secret-lib-repo
    expect(name).toMatch(/^secret-lib-repo-/);
  });

  test("sanitizes weird characters", async () => {
    const name = await getRepoName({ override: "weird/name with*spaces!" });
    // slashes and spaces stripped, kept letters/digits/-/_/.
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name).not.toContain(" ");
    expect(name).not.toContain("/");
  });

  test("empty override falls through to next source", async () => {
    process.env.SECRETS_SYNC_REPO = "from-env";
    const name = await getRepoName({ override: "" });
    expect(name).toBe("from-env");
  });

  test("malformed package.json falls back to git basename", async () => {
    const root = mkTmpRoot();
    writeFileSync(join(root, "package.json"), "not valid json {{{");
    const name = await getRepoName({ root });
    expect(name).toMatch(/^secret-lib-repo-/);
  });
});
