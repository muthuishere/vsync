import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildVaultCmd, vaultHandler } from "../../src/synctargets/vault";
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

const routing = {
  addr: "https://vault.example.com:8200",
  mount: "secret",
  secretPath: "myapp/dev",
};

describe("buildVaultCmd", () => {
  test("single bulk cmd includes mount and positional KVs for all tasks", () => {
    const tasks = [
      { key: "A", value: "1" },
      { key: "B", value: "2" },
      { key: "C", value: "3" },
    ];
    expect(buildVaultCmd(tasks, routing)).toEqual([
      "vault",
      "kv",
      "put",
      "-mount=secret",
      "myapp/dev",
      "A=1",
      "B=2",
      "C=3",
    ]);
  });

  test("empty task list still yields the put scaffold", () => {
    expect(buildVaultCmd([], routing)).toEqual([
      "vault",
      "kv",
      "put",
      "-mount=secret",
      "myapp/dev",
    ]);
  });

  test("values with `=` survive — split is positional, not parsed", () => {
    const cmd = buildVaultCmd(
      [{ key: "DSN", value: "user=foo password=bar" }],
      routing,
    );
    expect(cmd[5]).toBe("DSN=user=foo password=bar");
  });
});

describe("vaultHandler.resolveRouting", () => {
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

  test("flags win over cfg", async () => {
    const cfg = structuredClone(baseCfg);
    cfg.sync = {
      vault: { addr: "https://old", mount: "old", secretPath: "old/path" },
    };
    const r = await vaultHandler.resolveRouting(cfg, {
      "vault-addr": "https://new",
      "vault-mount": "kv",
      "vault-path": "new/path",
    });
    expect(r.routing).toEqual({
      addr: "https://new",
      mount: "kv",
      secretPath: "new/path",
    });
    expect(r.mutated).toBe(true);
  });

  test("cfg used when no flags", async () => {
    const cfg = structuredClone(baseCfg);
    cfg.sync = { vault: routing };
    const r = await vaultHandler.resolveRouting(cfg, {});
    expect(r.routing).toEqual(routing);
    expect(r.mutated).toBe(false);
  });

  test("no-tty + missing addr + no cfg throws", async () => {
    (process.stdin as any).isTTY = false;
    const cfg = structuredClone(baseCfg);
    await expect(vaultHandler.resolveRouting(cfg, {})).rejects.toThrow(
      /sync\.vault\.addr not configured/,
    );
  });

  test("no-tty + partial cfg (missing mount) throws", async () => {
    (process.stdin as any).isTTY = false;
    const cfg = structuredClone(baseCfg);
    await expect(
      vaultHandler.resolveRouting(cfg, { "vault-addr": "https://x" }),
    ).rejects.toThrow(/sync\.vault\.mount not configured/);
  });

  test("no-tty + missing secretPath throws", async () => {
    (process.stdin as any).isTTY = false;
    const cfg = structuredClone(baseCfg);
    await expect(
      vaultHandler.resolveRouting(cfg, {
        "vault-addr": "https://x",
        "vault-mount": "secret",
      }),
    ).rejects.toThrow(/sync\.vault\.secretPath not configured/);
  });
});

describe("vaultHandler metadata", () => {
  test("name + bin + banner", () => {
    expect(vaultHandler.name).toBe("vault");
    expect(vaultHandler.bin).toBe("vault");
    expect(vaultHandler.banner(routing, "dev", 7)).toBe(
      "\nSyncing 7 secrets to HashiCorp Vault: addr=https://vault.example.com:8200, mount=secret, path=myapp/dev",
    );
  });
});
