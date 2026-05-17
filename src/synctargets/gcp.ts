// GCP Secret Manager handler (v0.7 behavior, lifted into the v0.8 registry).

import type { SecretTask } from "../envfile";
import type { ConfigFile } from "../repoconfig";
import { runPool } from "../syncpool";
import { askText, isTty } from "../prompt";
import type { ResolveResult, RunSyncOpts, TargetHandler } from "./types";

export type GcpRouting = { project: string };

export function buildGcpCmd(
  task: SecretTask,
  routing: GcpRouting,
  exists: boolean,
): string[] {
  if (exists) {
    return [
      "gcloud",
      "secrets",
      "versions",
      "add",
      task.key,
      "--data-file=-",
      `--project=${routing.project}`,
    ];
  }
  return [
    "gcloud",
    "secrets",
    "create",
    task.key,
    "--replication-policy=automatic",
    "--data-file=-",
    `--project=${routing.project}`,
  ];
}

export function buildGcpDescribeCmd(
  task: SecretTask,
  routing: GcpRouting,
): string[] {
  return [
    "gcloud",
    "secrets",
    "describe",
    task.key,
    `--project=${routing.project}`,
  ];
}

async function secretExists(
  task: SecretTask,
  routing: GcpRouting,
  signal: AbortSignal,
): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: buildGcpDescribeCmd(task, routing),
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  return (await proc.exited) === 0;
}

async function setGcpSecret(
  t: SecretTask,
  routing: GcpRouting,
  signal: AbortSignal,
): Promise<void> {
  console.log(`Setting secret: ${t.key}`);
  const exists = await secretExists(t, routing, signal);
  const cmd = buildGcpCmd(t, routing, exists);
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
    throw new Error(`${cmd[1]} ${cmd[2]}: ${stderr || `exit ${code}`}`);
  }
  console.log(`✓ ${t.key}`);
}

export const gcpHandler: TargetHandler<GcpRouting> = {
  name: "gcp",
  bin: "gcloud",

  banner(routing, _env, n) {
    return `\nSyncing ${n} secrets to GCP Secret Manager: project=${routing.project}`;
  },

  async resolveRouting(
    cfg: ConfigFile,
    flags: Record<string, string>,
  ): Promise<ResolveResult<GcpRouting>> {
    if (flags["gcp-project"]) {
      const routing = { project: flags["gcp-project"] };
      cfg.sync = cfg.sync ?? {};
      cfg.sync.gcp = routing;
      return { routing, mutated: true };
    }
    if (cfg.sync?.gcp?.project) {
      return { routing: { project: cfg.sync.gcp.project }, mutated: false };
    }
    if (!isTty()) {
      throw new Error(
        "sync.gcp.project not configured for this (repo, env) and no --gcp-project flag passed.",
      );
    }
    const value = askText("GCP project ID for sync");
    if (!value) throw new Error("aborted (empty gcp project)");
    const routing = { project: value };
    cfg.sync = cfg.sync ?? {};
    cfg.sync.gcp = routing;
    return { routing, mutated: true };
  },

  async runSync(tasks, routing, opts: RunSyncOpts) {
    return runPool(tasks, opts.workers, opts.timeoutMs, (task, signal) =>
      setGcpSecret(task, routing, signal),
    );
  },
};
