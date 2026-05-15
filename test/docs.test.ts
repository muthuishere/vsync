import { test, expect, describe } from "bun:test";
import { DOCS_MD } from "../src/templates/docs.md";

describe("vsync docs content", () => {
  test("output is at least 1 KB", () => {
    expect(DOCS_MD.length).toBeGreaterThanOrEqual(1024);
  });

  test("starts with a top-level markdown heading", () => {
    expect(DOCS_MD.split("\n")[0]).toMatch(/^#\s+/);
  });

  for (const verb of [
    "init",
    "export",
    "import",
    "push",
    "pull",
    "versions",
    "sync",
    "docs",
  ]) {
    test(`mentions the ${verb} command`, () => {
      expect(DOCS_MD).toContain(`vsync ${verb}`);
    });
  }

  test("references the vault folder convention", () => {
    expect(DOCS_MD).toContain("infra/vault/");
  });

  test("references the keychain service name", () => {
    expect(DOCS_MD).toContain("tools.vsync");
  });

  test("documents the backup recovery procedure (mentions RQE1 + PBKDF2)", () => {
    expect(DOCS_MD).toContain("RQE1");
    expect(DOCS_MD).toContain("PBKDF2");
  });

  test("includes agent rules", () => {
    expect(DOCS_MD).toMatch(/Rules for AI agents/i);
  });
});
