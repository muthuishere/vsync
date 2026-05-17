// TargetHandler interface — every sync backend (gh, gcp, aws, azure, vault)
// implements this. See docs/specs/v0.8-multi-target-sync.md §2 for the
// dispatch model and why runSync lives on the handler (vault is bulk).

import type { SecretTask } from "../envfile";
import type { ConfigFile } from "../repoconfig";
import type { SyncResult } from "../syncpool";

export type ResolveResult<R> = { routing: R; mutated: boolean };

export type RunSyncOpts = {
  workers: number;
  timeoutMs: number;
  env: string;
  signal: AbortSignal;
};

export type TargetHandler<R = unknown> = {
  name: string;
  bin: string;
  banner(routing: R, env: string, n: number): string;
  resolveRouting(
    cfg: ConfigFile,
    flags: Record<string, string>,
  ): Promise<ResolveResult<R>>;
  runSync(
    tasks: SecretTask[],
    routing: R,
    opts: RunSyncOpts,
  ): Promise<SyncResult>;
};
