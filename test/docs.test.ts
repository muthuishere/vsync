import { test, expect, describe } from "bun:test";
import { DOCS_OVERVIEW } from "../src/templates/docs.md";

describe("vsync docs — CLI capability guide", () => {
  test("output is at least 512 bytes", () => {
    expect(DOCS_OVERVIEW.length).toBeGreaterThanOrEqual(512);
  });

  test("starts with a top-level markdown heading", () => {
    expect(DOCS_OVERVIEW.split("\n")[0]).toMatch(/^#\s+/);
  });

  // Documents what every verb does (bare verb form — this is the CLI's own
  // command map, not a "vsync <verb>" walkthrough).
  for (const verb of [
    "profile add",
    "profile list",
    "profile show",
    "profile remove",
    "init",
    "push",
    "pull",
    "use",
    "versions",
    "audit",
    "export",
    "import",
    "sync",
    "runtime-token",
    "rotate-passphrase",
    "status",
  ]) {
    test(`documents the ${verb} command`, () => {
      expect(DOCS_OVERVIEW).toContain(verb);
    });
  }

  test("points at the provider runbooks", () => {
    expect(DOCS_OVERVIEW).toContain("vsync docs aws");
  });

  test("points at the agent map", () => {
    expect(DOCS_OVERVIEW).toContain("vsync docs agent");
  });

  test("points at per-subcommand help", () => {
    expect(DOCS_OVERVIEW).toContain("vsync <sub> --help");
  });

  test("names the keychain service", () => {
    expect(DOCS_OVERVIEW).toContain("tools.vsync");
  });

  test("documents the two-halves invariant", () => {
    expect(DOCS_OVERVIEW).toMatch(/both halves/i);
  });

  // It documents the CLI; it is NOT a repo artifact to commit.
  test("does not frame itself as a committable AGENTS.md", () => {
    expect(DOCS_OVERVIEW).not.toContain("AGENTS.md");
  });
});
