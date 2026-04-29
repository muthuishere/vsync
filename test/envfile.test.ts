import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  test("GCP_SA_KEY_FILE_PATH expands to GCP_SA_KEY", () => {
    const keyFile = write("sa.json", `  {"type":"service_account","x":1}\n`);
    const p = write(".env.dev", `GCP_SA_KEY_FILE_PATH=${keyFile}\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([
      { key: "GCP_SA_KEY", value: `{"type":"service_account","x":1}` },
    ]);
  });

  test("GCP_SA_KEY_FILE_PATH rejects non-JSON content", () => {
    const keyFile = write("sa.txt", "not json");
    const p = write(".env.dev", `GCP_SA_KEY_FILE_PATH=${keyFile}\n`);
    expect(() => parseEnvFile(p)).toThrow(/does not look like JSON/);
  });

  test("SSH_KEY_PATH expands to SSH_PRIVATE_KEY (raw bytes)", () => {
    const keyFile = write(
      "id_rsa",
      "-----BEGIN PRIVATE KEY-----\nabcd\n-----END PRIVATE KEY-----\n",
    );
    const p = write(".env.dev", `SSH_KEY_PATH=${keyFile}\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([
      {
        key: "SSH_PRIVATE_KEY",
        value:
          "-----BEGIN PRIVATE KEY-----\nabcd\n-----END PRIVATE KEY-----\n",
      },
    ]);
  });

  test("missing SSH key file warns but does not throw", () => {
    const p = write(".env.dev", `SSH_KEY_PATH=${join(dir, "missing")}\nFOO=bar\n`);
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "FOO", value: "bar" }]);
  });

  test("ignores lines without `=`", () => {
    const p = write(".env.dev", "no equals here\nFOO=bar\n");
    const { tasks } = parseEnvFile(p);
    expect(tasks).toEqual([{ key: "FOO", value: "bar" }]);
  });

  test("throws when file missing", () => {
    expect(() => parseEnvFile(join(dir, ".env.nope"))).toThrow(/not found/);
  });
});
