// AWS Secrets Manager handler — see docs/specs/v0.8-multi-target-sync.md §3.

import type { SecretTask } from "../envfile";
import type { ConfigFile } from "../repoconfig";
import { runPool } from "../syncpool";
import { askText, isTty } from "../prompt";
import type { ResolveResult, RunSyncOpts, TargetHandler } from "./types";

export type AwsRouting = { region: string; secretPrefix?: string };

function secretName(task: SecretTask, routing: AwsRouting): string {
  return (routing.secretPrefix ?? "") + task.key;
}

export function buildAwsDescribeCmd(
  task: SecretTask,
  routing: AwsRouting,
): string[] {
  return [
    "aws",
    "secretsmanager",
    "describe-secret",
    "--secret-id",
    secretName(task, routing),
    "--region",
    routing.region,
  ];
}

export function buildAwsCmd(
  task: SecretTask,
  routing: AwsRouting,
  exists: boolean,
): string[] {
  const name = secretName(task, routing);
  if (exists) {
    return [
      "aws",
      "secretsmanager",
      "put-secret-value",
      "--secret-id",
      name,
      "--secret-string",
      "fileb:///dev/stdin",
      "--region",
      routing.region,
    ];
  }
  return [
    "aws",
    "secretsmanager",
    "create-secret",
    "--name",
    name,
    "--secret-string",
    "fileb:///dev/stdin",
    "--region",
    routing.region,
  ];
}

async function secretExists(
  task: SecretTask,
  routing: AwsRouting,
  signal: AbortSignal,
): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: buildAwsDescribeCmd(task, routing),
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  return (await proc.exited) === 0;
}

async function setAwsSecret(
  t: SecretTask,
  routing: AwsRouting,
  signal: AbortSignal,
): Promise<void> {
  console.log(`Setting secret: ${t.key}`);
  const exists = await secretExists(t, routing, signal);
  const cmd = buildAwsCmd(t, routing, exists);
  const proc = Bun.spawn({
    cmd,
    stdin: new TextEncoder().encode(t.value),
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw new Error(`aws secretsmanager ${cmd[2]}: ${stderr || `exit ${code}`}`);
  }
  console.log(`✓ ${t.key}`);
}

export const awsHandler: TargetHandler<AwsRouting> = {
  name: "aws",
  bin: "aws",

  banner(routing, _env, n) {
    const prefix = routing.secretPrefix ? `, prefix=${routing.secretPrefix}` : "";
    return `\nSyncing ${n} secrets to AWS Secrets Manager: region=${routing.region}${prefix}`;
  },

  async resolveRouting(
    cfg: ConfigFile,
    flags: Record<string, string>,
  ): Promise<ResolveResult<AwsRouting>> {
    let mutated = false;
    let region = flags["aws-region"] ?? cfg.sync?.aws?.region;
    let secretPrefix =
      flags["aws-secret-prefix"] ?? cfg.sync?.aws?.secretPrefix;

    if (flags["aws-region"]) mutated = true;
    if (flags["aws-secret-prefix"] !== undefined) mutated = true;

    if (!region) {
      if (!isTty()) {
        throw new Error(
          "sync.aws.region not configured for this (repo, env) and no --aws-region flag passed.",
        );
      }
      const value = askText("AWS region for sync");
      if (!value) throw new Error("aborted (empty aws region)");
      region = value;
      mutated = true;
    }

    const routing: AwsRouting = { region };
    if (secretPrefix) routing.secretPrefix = secretPrefix;

    if (mutated) {
      cfg.sync = cfg.sync ?? {};
      cfg.sync.aws = routing;
    }
    return { routing, mutated };
  },

  async runSync(tasks, routing, opts: RunSyncOpts) {
    return runPool(tasks, opts.workers, opts.timeoutMs, (task, signal) =>
      setAwsSecret(task, routing, signal),
    );
  },
};
