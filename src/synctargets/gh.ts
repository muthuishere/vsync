// GitHub repo secrets handler (v0.7 behavior, lifted into the v0.8 registry).

import type { SecretTask } from "../envfile";
import type { ConfigFile } from "../repoconfig";
import { runPool } from "../syncpool";
import { askText, isTty } from "../prompt";
import type { ResolveResult, RunSyncOpts, TargetHandler } from "./types";

export type GhRouting = { repo: string };

export function buildGhCmd(
  task: SecretTask,
  routing: GhRouting,
  env: string,
): string[] {
  return [
    "gh",
    "secret",
    "set",
    task.key,
    "--env",
    env,
    "--repo",
    routing.repo,
  ];
}

async function setGhSecret(
  t: SecretTask,
  routing: GhRouting,
  env: string,
  signal: AbortSignal,
): Promise<void> {
  console.log(`Setting secret: ${t.key}`);
  const proc = Bun.spawn({
    cmd: buildGhCmd(t, routing, env),
    stdin: new TextEncoder().encode(t.value),
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw new Error(`gh secret set: ${stderr || `exit ${code}`}`);
  }
  console.log(`✓ ${t.key}`);
}

export const ghHandler: TargetHandler<GhRouting> = {
  name: "gh",
  bin: "gh",

  banner(routing, env, n) {
    return `\nSyncing ${n} secrets to GitHub: repo=${routing.repo}, environment=${env}`;
  },

  async resolveRouting(
    cfg: ConfigFile,
    flags: Record<string, string>,
  ): Promise<ResolveResult<GhRouting>> {
    if (flags["gh-repo"]) {
      const routing = { repo: flags["gh-repo"] };
      cfg.sync = cfg.sync ?? {};
      cfg.sync.gh = routing;
      return { routing, mutated: true };
    }
    if (cfg.sync?.gh?.repo) {
      return { routing: { repo: cfg.sync.gh.repo }, mutated: false };
    }
    if (!isTty()) {
      throw new Error(
        "sync.gh.repo not configured for this (repo, env) and no --gh-repo flag passed.",
      );
    }
    const value = askText("GitHub repo for sync (owner/name)");
    if (!value) throw new Error("aborted (empty gh repo)");
    const routing = { repo: value };
    cfg.sync = cfg.sync ?? {};
    cfg.sync.gh = routing;
    return { routing, mutated: true };
  },

  async runSync(tasks, routing, opts: RunSyncOpts) {
    return runPool(tasks, opts.workers, opts.timeoutMs, (task, signal) =>
      setGhSecret(task, routing, opts.env, signal),
    );
  },
};
