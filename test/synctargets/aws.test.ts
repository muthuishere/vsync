import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildAwsCmd,
  buildAwsDescribeCmd,
  awsHandler,
} from "../../src/synctargets/aws";
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

describe("buildAwsDescribeCmd", () => {
  test("no prefix", () => {
    expect(
      buildAwsDescribeCmd(
        { key: "API_KEY", value: "v" },
        { region: "us-east-1" },
      ),
    ).toEqual([
      "aws",
      "secretsmanager",
      "describe-secret",
      "--secret-id",
      "API_KEY",
      "--region",
      "us-east-1",
    ]);
  });

  test("with prefix", () => {
    expect(
      buildAwsDescribeCmd(
        { key: "API_KEY", value: "v" },
        { region: "us-east-1", secretPrefix: "myapp/" },
      ),
    ).toEqual([
      "aws",
      "secretsmanager",
      "describe-secret",
      "--secret-id",
      "myapp/API_KEY",
      "--region",
      "us-east-1",
    ]);
  });
});

describe("buildAwsCmd", () => {
  test("exists=true → put-secret-value with --secret-id", () => {
    expect(
      buildAwsCmd(
        { key: "API_KEY", value: "v" },
        { region: "us-east-1", secretPrefix: "myapp/" },
        true,
      ),
    ).toEqual([
      "aws",
      "secretsmanager",
      "put-secret-value",
      "--secret-id",
      "myapp/API_KEY",
      "--secret-string",
      "fileb:///dev/stdin",
      "--region",
      "us-east-1",
    ]);
  });

  test("exists=false → create-secret with --name", () => {
    expect(
      buildAwsCmd(
        { key: "API_KEY", value: "v" },
        { region: "us-east-1" },
        false,
      ),
    ).toEqual([
      "aws",
      "secretsmanager",
      "create-secret",
      "--name",
      "API_KEY",
      "--secret-string",
      "fileb:///dev/stdin",
      "--region",
      "us-east-1",
    ]);
  });
});

describe("awsHandler.resolveRouting", () => {
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
    cfg.sync = { aws: { region: "us-west-1" } };
    const r = await awsHandler.resolveRouting(cfg, {
      "aws-region": "us-east-1",
    });
    expect(r.routing.region).toBe("us-east-1");
    expect(r.mutated).toBe(true);
  });

  test("cfg used when no flag", async () => {
    const cfg = structuredClone(baseCfg);
    cfg.sync = { aws: { region: "us-east-1", secretPrefix: "myapp/" } };
    const r = await awsHandler.resolveRouting(cfg, {});
    expect(r.routing).toEqual({ region: "us-east-1", secretPrefix: "myapp/" });
    expect(r.mutated).toBe(false);
  });

  test("no-tty + no flag + no cfg throws", async () => {
    (process.stdin as any).isTTY = false;
    const cfg = structuredClone(baseCfg);
    await expect(awsHandler.resolveRouting(cfg, {})).rejects.toThrow(
      /sync\.aws\.region not configured/,
    );
  });

  test("prefix flag persists when region from cfg", async () => {
    const cfg = structuredClone(baseCfg);
    cfg.sync = { aws: { region: "us-east-1" } };
    const r = await awsHandler.resolveRouting(cfg, {
      "aws-secret-prefix": "myapp/",
    });
    expect(r.routing).toEqual({ region: "us-east-1", secretPrefix: "myapp/" });
    expect(r.mutated).toBe(true);
  });
});

describe("awsHandler metadata", () => {
  test("name + bin + banner", () => {
    expect(awsHandler.name).toBe("aws");
    expect(awsHandler.bin).toBe("aws");
    expect(awsHandler.banner({ region: "us-east-1" }, "dev", 4)).toBe(
      "\nSyncing 4 secrets to AWS Secrets Manager: region=us-east-1",
    );
    expect(
      awsHandler.banner(
        { region: "us-east-1", secretPrefix: "myapp/" },
        "dev",
        4,
      ),
    ).toBe(
      "\nSyncing 4 secrets to AWS Secrets Manager: region=us-east-1, prefix=myapp/",
    );
  });
});
