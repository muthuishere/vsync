// vsyncfile.test.ts — parser + writer for the .env-style `.vsync` pin file.
//
// See docs/specs/v0.16-repo-identity-git-only.md §3.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readVsyncFile,
  writeVsyncFile,
  parseVsyncFile,
  vsyncFilePath,
  VsyncFileClobberError,
  VsyncFileMalformedError,
} from "../src/vsyncfile";

function mkRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "vsync-file-test-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("parseVsyncFile", () => {
  test("simple repo=value line", () => {
    const r = parseVsyncFile("repo=acme-web\n", "/tmp/x/.vsync");
    expect(r.repo).toBe("acme-web");
  });

  test("comment lines are ignored", () => {
    const r = parseVsyncFile(
      "# comment one\n  # indented comment\nrepo=acme-web\n",
      "/tmp/x/.vsync",
    );
    expect(r.repo).toBe("acme-web");
  });

  test("inline '#' becomes part of value (no inline comments)", () => {
    const r = parseVsyncFile("repo=acme # foo\n", "/tmp/x/.vsync");
    expect(r.repo).toBe("acme # foo");
  });

  test("duplicate keys → last wins", () => {
    const r = parseVsyncFile("repo=first\nrepo=second\n", "/tmp/x/.vsync");
    expect(r.repo).toBe("second");
  });

  test("blank lines and trailing whitespace tolerated", () => {
    const r = parseVsyncFile(
      "\n\nrepo=acme-web   \n\n",
      "/tmp/x/.vsync",
    );
    expect(r.repo).toBe("acme-web");
  });

  test("unknown keys are accepted (forward-compat)", () => {
    const r = parseVsyncFile(
      "repo=acme-web\nfuture_field=42\nother=foo\n",
      "/tmp/x/.vsync",
    );
    expect(r.repo).toBe("acme-web");
    expect(r.future_field).toBe("42");
    expect(r.other).toBe("foo");
  });

  test("line without '=' throws VsyncFileMalformedError", () => {
    expect(() =>
      parseVsyncFile("garbage_no_equals\n", "/tmp/x/.vsync"),
    ).toThrow(VsyncFileMalformedError);
  });

  test("invalid key character throws", () => {
    expect(() =>
      parseVsyncFile("1invalid=value\n", "/tmp/x/.vsync"),
    ).toThrow(VsyncFileMalformedError);
  });
});

describe("readVsyncFile", () => {
  test("returns null when file is absent", () => {
    const { root, cleanup } = mkRoot();
    expect(readVsyncFile(root)).toBeNull();
    cleanup();
  });

  test("reads a well-formed file", () => {
    const { root, cleanup } = mkRoot();
    writeFileSync(join(root, ".vsync"), "repo=acme-web\n");
    const v = readVsyncFile(root);
    expect(v).not.toBeNull();
    expect(v!.repo).toBe("acme_web"); // normalised
    expect(v!.unknown).toEqual({});
    cleanup();
  });

  test("missing `repo` key throws VsyncFileMalformedError", () => {
    const { root, cleanup } = mkRoot();
    writeFileSync(join(root, ".vsync"), "# only comments\nother=foo\n");
    expect(() => readVsyncFile(root)).toThrow(VsyncFileMalformedError);
    cleanup();
  });

  test("`repo=` value failing normalise → VsyncFileMalformedError", () => {
    const { root, cleanup } = mkRoot();
    // Value of all-symbols normalises to null → malformed.
    writeFileSync(join(root, ".vsync"), "repo=!@#$%\n");
    expect(() => readVsyncFile(root)).toThrow(VsyncFileMalformedError);
    cleanup();
  });

  test("preserves unknown keys in returned object", () => {
    const { root, cleanup } = mkRoot();
    writeFileSync(
      join(root, ".vsync"),
      "repo=acme-web\nfuture=42\nother=foo\n",
    );
    const v = readVsyncFile(root)!;
    expect(v.unknown.future).toBe("42");
    expect(v.unknown.other).toBe("foo");
    cleanup();
  });
});

describe("writeVsyncFile", () => {
  test("writes a fresh file when absent", () => {
    const { root, cleanup } = mkRoot();
    const r = writeVsyncFile(root, "acme-web");
    expect(r.written).toBe(true);
    const content = readFileSync(join(root, ".vsync"), "utf-8");
    expect(content).toContain("repo=acme-web");
    expect(content).toContain("# .vsync");
    cleanup();
  });

  test("no-op when existing file matches (both already-normalised)", () => {
    const { root, cleanup } = mkRoot();
    writeFileSync(join(root, ".vsync"), "repo=acme_web\n");
    const r = writeVsyncFile(root, "acme_web");
    expect(r.written).toBe(false);
    cleanup();
  });

  test("throws VsyncFileClobberError when existing file differs", () => {
    const { root, cleanup } = mkRoot();
    writeFileSync(join(root, ".vsync"), "repo=acme_web\n");
    expect(() => writeVsyncFile(root, "other_repo")).toThrow(
      VsyncFileClobberError,
    );
    // File unchanged
    const content = readFileSync(join(root, ".vsync"), "utf-8");
    expect(content).toContain("repo=acme_web");
    cleanup();
  });

  test("write produces a parseable file", () => {
    const { root, cleanup } = mkRoot();
    writeVsyncFile(root, "acme-web");
    const v = readVsyncFile(root)!;
    expect(v.repo).toBe("acme_web");
    cleanup();
  });
});

describe("vsyncFilePath", () => {
  test("joins toplevel with .vsync", () => {
    expect(vsyncFilePath("/foo/bar")).toBe("/foo/bar/.vsync");
  });
});
