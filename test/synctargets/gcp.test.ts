import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildGcpCmd,
  buildGcpDescribeCmd,
  gcpHandler,
} from "../../src/synctargets/gcp";
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

describe("buildGcpDescribeCmd", () => {
  test("produces describe command", () => {
    expect(
      buildGcpDescribeCmd({ key: "API_KEY", value: "v" }, { project: "proj-1" }),
    ).toEqual(["gcloud", "secrets", "describe", "API_KEY", "--project=proj-1"]);
  });
});

describe("buildGcpCmd", () => {
  test("exists=false produces create with replication policy", () => {
    expect(
      buildGcpCmd({ key: "API_KEY", value: "v" }, { project: "proj-1" }, false),
    ).toEqual([
      "gcloud",
      "secrets",
      "create",
      "API_KEY",
      "--replication-policy=automatic",
      "--data-file=-",
      "--project=proj-1",
    ]);
  });

  test("exists=true produces versions add", () => {
    expect(
      buildGcpCmd({ key: "API_KEY", value: "v" }, { project: "proj-1" }, true),
    ).toEqual([
      "gcloud",
      "secrets",
      "versions",
      "add",
      "API_KEY",
      "--data-file=-",
      "--project=proj-1",
    ]);
  });
});

describe("gcpHandler.resolveRouting", () => {
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
    cfg.sync = { gcp: { project: "old" } };
    const r = await gcpHandler.resolveRouting(cfg, { "gcp-project": "new" });
    expect(r.routing).toEqual({ project: "new" });
    expect(r.mutated).toBe(true);
  });

  test("cfg used when no flag", async () => {
    const cfg = structuredClone(baseCfg);
    cfg.sync = { gcp: { project: "proj-1" } };
    const r = await gcpHandler.resolveRouting(cfg, {});
    expect(r.routing).toEqual({ project: "proj-1" });
    expect(r.mutated).toBe(false);
  });

  test("no-tty + no flag + no cfg throws", async () => {
    (process.stdin as any).isTTY = false;
    const cfg = structuredClone(baseCfg);
    await expect(gcpHandler.resolveRouting(cfg, {})).rejects.toThrow(
      /sync\.gcp\.project not configured/,
    );
  });
});

describe("gcpHandler metadata", () => {
  test("name + bin + banner", () => {
    expect(gcpHandler.name).toBe("gcp");
    expect(gcpHandler.bin).toBe("gcloud");
    expect(gcpHandler.banner({ project: "p" }, "dev", 3)).toBe(
      "\nSyncing 3 secrets to GCP Secret Manager: project=p",
    );
  });
});
