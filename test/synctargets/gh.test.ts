import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildGhCmd, ghHandler } from "../../src/synctargets/gh";
import type { ConfigFile } from "../../src/repoconfig";

const baseCfg: ConfigFile = {
  version: 1,
  s3: {
    endpoint: "x",
    bucket: "b",
    region: "r",
    useSsl: true,
    accessKeyId: "a",
    secretAccessKey: "s",
  },
  encryption: { salt: "salty-enough" },
};

describe("buildGhCmd", () => {
  test("produces gh secret set with --env and --repo", () => {
    expect(
      buildGhCmd({ key: "API_KEY", value: "v" }, { repo: "owner/name" }, "dev"),
    ).toEqual([
      "gh",
      "secret",
      "set",
      "API_KEY",
      "--env",
      "dev",
      "--repo",
      "owner/name",
    ]);
  });
});

describe("ghHandler.resolveRouting", () => {
  let originalTty: any;
  let originalPrompt: any;

  beforeEach(() => {
    originalTty = (process.stdin as any).isTTY;
    originalPrompt = (globalThis as any).prompt;
  });

  afterEach(() => {
    (process.stdin as any).isTTY = originalTty;
    (globalThis as any).prompt = originalPrompt;
  });

  test("flag wins over cfg", async () => {
    const cfg = structuredClone(baseCfg);
    cfg.sync = { gh: { repo: "old/repo" } };
    const r = await ghHandler.resolveRouting(cfg, { "gh-repo": "new/repo" });
    expect(r.routing).toEqual({ repo: "new/repo" });
    expect(r.mutated).toBe(true);
    expect(cfg.sync?.gh?.repo).toBe("new/repo");
  });

  test("cfg used when no flag", async () => {
    const cfg = structuredClone(baseCfg);
    cfg.sync = { gh: { repo: "owner/name" } };
    const r = await ghHandler.resolveRouting(cfg, {});
    expect(r.routing).toEqual({ repo: "owner/name" });
    expect(r.mutated).toBe(false);
  });

  test("no-tty + no flag + no cfg throws", async () => {
    (process.stdin as any).isTTY = false;
    const cfg = structuredClone(baseCfg);
    await expect(ghHandler.resolveRouting(cfg, {})).rejects.toThrow(
      /sync\.gh\.repo not configured/,
    );
  });

  test("tty prompt fills routing and marks mutated", async () => {
    (process.stdin as any).isTTY = true;
    (globalThis as any).prompt = () => "prompted/repo";
    const cfg = structuredClone(baseCfg);
    const r = await ghHandler.resolveRouting(cfg, {});
    expect(r.routing).toEqual({ repo: "prompted/repo" });
    expect(r.mutated).toBe(true);
    expect(cfg.sync?.gh?.repo).toBe("prompted/repo");
  });
});

describe("ghHandler metadata", () => {
  test("name + bin", () => {
    expect(ghHandler.name).toBe("gh");
    expect(ghHandler.bin).toBe("gh");
  });

  test("banner shape", () => {
    expect(ghHandler.banner({ repo: "o/n" }, "dev", 5)).toBe(
      "\nSyncing 5 secrets to GitHub: repo=o/n, environment=dev",
    );
  });
});
