import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAzureCmd, azureHandler } from "../../src/synctargets/azure";
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

describe("buildAzureCmd", () => {
  test("idempotent set via stdin", () => {
    expect(
      buildAzureCmd({ key: "APIKEY", value: "v" }, { vaultName: "kv-prod" }),
    ).toEqual([
      "az",
      "keyvault",
      "secret",
      "set",
      "--vault-name",
      "kv-prod",
      "--name",
      "APIKEY",
      "--file",
      "/dev/stdin",
    ]);
  });

  test("no silent underscore translation — key passes through verbatim", () => {
    const cmd = buildAzureCmd(
      { key: "API_KEY", value: "v" },
      { vaultName: "kv-prod" },
    );
    expect(cmd[7]).toBe("API_KEY");
  });
});

describe("azureHandler.resolveRouting", () => {
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
    cfg.sync = { azure: { vaultName: "old-kv" } };
    const r = await azureHandler.resolveRouting(cfg, {
      "azure-vault": "new-kv",
    });
    expect(r.routing).toEqual({ vaultName: "new-kv" });
    expect(r.mutated).toBe(true);
  });

  test("cfg used when no flag", async () => {
    const cfg = structuredClone(baseCfg);
    cfg.sync = { azure: { vaultName: "kv-prod" } };
    const r = await azureHandler.resolveRouting(cfg, {});
    expect(r.routing).toEqual({ vaultName: "kv-prod" });
    expect(r.mutated).toBe(false);
  });

  test("no-tty + no flag + no cfg throws", async () => {
    (process.stdin as any).isTTY = false;
    const cfg = structuredClone(baseCfg);
    await expect(azureHandler.resolveRouting(cfg, {})).rejects.toThrow(
      /sync\.azure\.vaultName not configured/,
    );
  });
});

describe("azureHandler metadata", () => {
  test("name + bin + banner", () => {
    expect(azureHandler.name).toBe("azure");
    expect(azureHandler.bin).toBe("az");
    expect(azureHandler.banner({ vaultName: "kv-prod" }, "dev", 2)).toBe(
      "\nSyncing 2 secrets to Azure Key Vault: vault=kv-prod",
    );
  });
});
