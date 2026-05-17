import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "../src/envfile";

describe("parseEnvFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envfile-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  function writeAt(rel: string, content: string): string {
    const p = join(dir, rel);
    mkdirSync(join(dir, rel, "..").replace(/[/]\.\.$/, ""), { recursive: true });
    writeFileSync(p, content);
    return p;
  }

  test("parses k=v lines, skips blanks and comments", () => {
    const p = write(".env.dev", "\n# a comment\nFOO=bar\n\nBAZ=qux\n");
    const { tasks, meta } = parseEnvFile(p);
    expect(tasks).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
    expect(meta).toEqual({});
  });

  test("strips a single pair of surrounding quotes", () => {
    const p = write(".env.dev", `A="hello"\nB='world'\nC="mixed'\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([
      { key: "A", value: "hello" },
      { key: "B", value: "world" },
      { key: "C", value: `"mixed'` },
    ]);
  });

  test("splits on first `=` only", () => {
    const p = write(".env.dev", "URL=https://x.example/?a=1&b=2\n");
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "URL", value: "https://x.example/?a=1&b=2" }]);
  });

  test("skips local-only keys", () => {
    const p = write(
      ".env.dev",
      "GITHUB_TOKEN=ghp_xxx\nGOOGLE_APPLICATION_CREDENTIALS=/tmp/x.json\nFOO=bar\n",
    );
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "FOO", value: "bar" }]);
  });

  test("extracts routing keys into meta, not tasks", () => {
    const p = write(
      ".env.dev",
      "GITHUB_REPO=owner/repo\nGCP_PROJECT_ID=my-proj\nFOO=bar\n",
    );
    const { tasks, meta } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "FOO", value: "bar" }]);
    expect(meta).toEqual({ GITHUB_REPO: "owner/repo", GCP_PROJECT_ID: "my-proj" });
  });

  // --- generic suffix rules ---

  test("generic *_PATH strips _PATH and pushes file contents", () => {
    write("foo.txt", "the body\n");
    const p = write(".env.dev", `MY_KEY_PATH=foo.txt\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "MY_KEY", value: "the body\n" }]);
  });

  test("generic *_FILE strips _FILE and pushes file contents", () => {
    write("bar.txt", "another body");
    const p = write(".env.dev", `ANOTHER_FILE=bar.txt\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "ANOTHER", value: "another body" }]);
  });

  test("./ resolves vault-relative", () => {
    write("local.txt", "local body");
    const p = write(".env.dev", `THING_PATH=./local.txt\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "THING", value: "local body" }]);
  });

  test("nested vault-relative path", () => {
    mkdirSync(join(dir, "keys"), { recursive: true });
    writeFileSync(join(dir, "keys", "k1"), "k1-body");
    const p = write(".env.dev", `K1_PATH=keys/k1\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "K1", value: "k1-body" }]);
  });

  test("${VAULT_ROOT} placeholder resolves to env file directory", () => {
    write("explicit.txt", "explicit");
    const p = write(".env.dev", `THING_PATH=\${VAULT_ROOT}/explicit.txt\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "THING", value: "explicit" }]);
  });

  test("absolute paths pass through unchanged", () => {
    const abs = write("abs.txt", "abs body");
    const p = write(".env.dev", `THING_PATH=${abs}\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "THING", value: "abs body" }]);
  });

  test("missing *_PATH file throws with all errors aggregated", () => {
    write("present.txt", "ok");
    const p = write(
      ".env.dev",
      [
        "A_PATH=present.txt",
        "B_PATH=missing1.txt",
        "C_FILE=missing2.txt",
        "FOO=bar",
      ].join("\n") + "\n",
    );
    let err: Error | null = null;
    try {
      parseEnvFile(p);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/2 file reference\(s\)/);
    expect(err!.message).toMatch(/B_PATH/);
    expect(err!.message).toMatch(/C_FILE/);
  });

  test("placeholder expansion applies to plain (non-path) values too", () => {
    const p = write(
      ".env.dev",
      `WORK_DIR=\${VAULT_ROOT}/sub\nHOME_DIR=~/x\n`,
    );
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([
      { key: "WORK_DIR", value: join(dir, "sub") },
      { key: "HOME_DIR", value: join(homedir(), "x") },
    ]);
  });

  test("${HOME} placeholder expands", () => {
    const p = write(".env.dev", `FOO=\${HOME}/bar\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "FOO", value: join(homedir(), "bar") }]);
  });

  test("ignores lines without `=`", () => {
    const p = write(".env.dev", "no equals here\nFOO=bar\n");
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "FOO", value: "bar" }]);
  });

  test("throws when env file missing", () => {
    expect(() => parseEnvFile(join(dir, ".env.nope"))).toThrow(/not found/);
  });

  test("a bare `_PATH=` value is treated as plain (no name to strip into)", () => {
    // edge case: key is literally `_PATH` — stripping leaves "" which is invalid;
    // we keep the original as a plain value rather than pushing an empty-key task.
    const p = write(".env.dev", `_PATH=raw\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "_PATH", value: "raw" }]);
  });
});
