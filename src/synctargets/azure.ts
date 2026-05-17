// Azure Key Vault handler — see docs/specs/v0.8-multi-target-sync.md §4.
// Idempotent: `az keyvault secret set` creates-or-updates in one call.

import type { SecretTask } from "../envfile";
import type { ConfigFile } from "../repoconfig";
import { runPool } from "../syncpool";
import { askText, isTty } from "../prompt";
import type { ResolveResult, RunSyncOpts, TargetHandler } from "./types";

export type AzureRouting = { vaultName: string };

export function buildAzureCmd(
  task: SecretTask,
  routing: AzureRouting,
): string[] {
  return [
    "az",
    "keyvault",
    "secret",
    "set",
    "--vault-name",
    routing.vaultName,
    "--name",
    task.key,
    "--file",
    "/dev/stdin",
  ];
}

async function setAzureSecret(
  t: SecretTask,
  routing: AzureRouting,
  signal: AbortSignal,
): Promise<void> {
  console.log(`Setting secret: ${t.key}`);
  const proc = Bun.spawn({
    cmd: buildAzureCmd(t, routing),
    stdin: new TextEncoder().encode(t.value),
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw new Error(`az keyvault secret set: ${stderr || `exit ${code}`}`);
  }
  console.log(`✓ ${t.key}`);
}

export const azureHandler: TargetHandler<AzureRouting> = {
  name: "azure",
  bin: "az",

  banner(routing, _env, n) {
    return `\nSyncing ${n} secrets to Azure Key Vault: vault=${routing.vaultName}`;
  },

  async resolveRouting(
    cfg: ConfigFile,
    flags: Record<string, string>,
  ): Promise<ResolveResult<AzureRouting>> {
    if (flags["azure-vault"]) {
      const routing = { vaultName: flags["azure-vault"] };
      cfg.sync = cfg.sync ?? {};
      cfg.sync.azure = routing;
      return { routing, mutated: true };
    }
    if (cfg.sync?.azure?.vaultName) {
      return {
        routing: { vaultName: cfg.sync.azure.vaultName },
        mutated: false,
      };
    }
    if (!isTty()) {
      throw new Error(
        "sync.azure.vaultName not configured for this (repo, env) and no --azure-vault flag passed.",
      );
    }
    const value = askText("Azure Key Vault name");
    if (!value) throw new Error("aborted (empty azure vault name)");
    const routing = { vaultName: value };
    cfg.sync = cfg.sync ?? {};
    cfg.sync.azure = routing;
    return { routing, mutated: true };
  },

  async runSync(tasks, routing, opts: RunSyncOpts) {
    return runPool(tasks, opts.workers, opts.timeoutMs, (task, signal) =>
      setAzureSecret(task, routing, signal),
    );
  },
};
