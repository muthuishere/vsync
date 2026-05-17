// HashiCorp Vault KV v2 handler — see docs/specs/v0.8-multi-target-sync.md §5.
// Bulk-write: KV v2 is atomic per path, so all tasks go in one `vault kv put`.

import type { SecretTask } from "../envfile";
import type { ConfigFile } from "../repoconfig";
import type { SyncResult } from "../syncpool";
import { askText, isTty } from "../prompt";
import type { ResolveResult, RunSyncOpts, TargetHandler } from "./types";

export type VaultRouting = {
  addr: string;
  mount: string;
  secretPath: string;
};

export function buildVaultCmd(
  tasks: SecretTask[],
  routing: VaultRouting,
): string[] {
  const cmd = [
    "vault",
    "kv",
    "put",
    `-mount=${routing.mount}`,
    routing.secretPath,
  ];
  for (const t of tasks) {
    cmd.push(`${t.key}=${t.value}`);
  }
  return cmd;
}

export const vaultHandler: TargetHandler<VaultRouting> = {
  name: "vault",
  bin: "vault",

  banner(routing, _env, n) {
    return `\nSyncing ${n} secrets to HashiCorp Vault: addr=${routing.addr}, mount=${routing.mount}, path=${routing.secretPath}`;
  },

  async resolveRouting(
    cfg: ConfigFile,
    flags: Record<string, string>,
  ): Promise<ResolveResult<VaultRouting>> {
    let mutated = false;
    let addr = flags["vault-addr"] ?? cfg.sync?.vault?.addr;
    let mount = flags["vault-mount"] ?? cfg.sync?.vault?.mount;
    let secretPath = flags["vault-path"] ?? cfg.sync?.vault?.secretPath;

    if (flags["vault-addr"]) mutated = true;
    if (flags["vault-mount"]) mutated = true;
    if (flags["vault-path"]) mutated = true;

    if (!addr) {
      if (!isTty()) {
        throw new Error(
          "sync.vault.addr not configured for this (repo, env) and no --vault-addr flag passed.",
        );
      }
      const v = askText("Vault address (e.g. https://vault.example.com:8200)");
      if (!v) throw new Error("aborted (empty vault addr)");
      addr = v;
      mutated = true;
    }
    if (!mount) {
      if (!isTty()) {
        throw new Error(
          "sync.vault.mount not configured for this (repo, env) and no --vault-mount flag passed.",
        );
      }
      const v = askText("Vault KV mount (e.g. secret)");
      if (!v) throw new Error("aborted (empty vault mount)");
      mount = v;
      mutated = true;
    }
    if (!secretPath) {
      if (!isTty()) {
        throw new Error(
          "sync.vault.secretPath not configured for this (repo, env) and no --vault-path flag passed.",
        );
      }
      const v = askText("Vault secret path (e.g. myapp/dev)");
      if (!v) throw new Error("aborted (empty vault path)");
      secretPath = v;
      mutated = true;
    }

    const routing: VaultRouting = { addr, mount, secretPath };
    if (mutated) {
      cfg.sync = cfg.sync ?? {};
      cfg.sync.vault = routing;
    }
    return { routing, mutated };
  },

  async runSync(
    tasks,
    routing,
    opts: RunSyncOpts,
  ): Promise<SyncResult> {
    console.log(`Writing ${tasks.length} keys to ${routing.mount}/${routing.secretPath}`);
    const cmd = buildVaultCmd(tasks, routing);
    const timer = setTimeout(() => {
      // outer signal already wired in main; this is just defensive cleanup.
    }, opts.timeoutMs);
    try {
      const proc = Bun.spawn({
        cmd,
        env: { ...process.env, VAULT_ADDR: routing.addr },
        stdout: "pipe",
        stderr: "pipe",
        signal: opts.signal,
      });
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = (await new Response(proc.stderr).text()).trim();
        console.error(
          `WARNING: vault kv put failed: ${stderr || `exit ${code}`}`,
        );
        return { ok: 0, failed: tasks.map((t) => t.key) };
      }
      for (const t of tasks) {
        console.log(`✓ ${t.key}`);
      }
      return { ok: tasks.length, failed: [] };
    } finally {
      clearTimeout(timer);
    }
  },
};
