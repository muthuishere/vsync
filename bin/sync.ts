#!/usr/bin/env bun
// Usage: vsync sync <env> <gh|gcp|all> [--gh-repo=<owner/name>] [--gcp-project=<id>]
//
// Reads <vaultFolder>/.env.<env> and pushes each variable to the named
// secret backend, in parallel (6 workers, 10-min overall timeout).
//
// Routing config lives in the per-repo vsync file (cfg.sync.gh.repo /
// cfg.sync.gcp.project), NOT in the .env file. First run prompts for
// missing routing and saves it; subsequent runs are zero-prompt.
//
// Path-expansion + skip rules in src/envfile.ts:
//   - GCP_SA_KEY_FILE_PATH → GCP_SA_KEY (file content)
//   - SSH_KEY_PATH → SSH_PRIVATE_KEY (file content)
//   - GITHUB_TOKEN, GOOGLE_APPLICATION_CREDENTIALS skipped (local-only)

import { join } from "node:path";
import { parseArgs } from "../src/argv";
import { parseEnvFile, type SecretTask } from "../src/envfile";
import { runPool } from "../src/syncpool";
import { getRepoName, getRepoRoot } from "../src/repo";
import {
  loadConfigFile,
  saveConfigFile,
  type ConfigFile,
} from "../src/repoconfig";
import { resolveVaultFolder } from "../src/envconfig";
import { askText, isTty } from "../src/prompt";

const TARGETS = ["gh", "gcp", "all"] as const;
type Target = (typeof TARGETS)[number];

const WORKERS = 6;
const TIMEOUT_MS = 10 * 60 * 1000;

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  const target = positional[1] as Target | undefined;

  if (!env || !target || !TARGETS.includes(target)) {
    console.error("usage: vsync sync <env> <gh|gcp|all>");
    console.error("");
    console.error("  env     environment name; reads <vaultFolder>/.env.<env>");
    console.error("  gh      push to GitHub repo secrets (env = <env>)");
    console.error("  gcp     push to GCP Secret Manager (project from cfg.sync.gcp.project)");
    console.error("  all     push to every configured target");
    console.error("");
    console.error("Flags: --gh-repo=<owner/name>, --gcp-project=<id>, --repo=<name>");
    process.exit(1);
  }

  const repo = await getRepoName({ override: flags.repo });
  const root = await getRepoRoot();

  const cfg = await loadConfigFile(repo, env);
  if (!cfg) {
    console.error(
      `no config file for ${repo}/${env}. Run 'vsync init ${env}' first.`,
    );
    process.exit(1);
  }

  const vaultFolder = resolveVaultFolder(cfg, env);
  const envFilePath = join(root, vaultFolder, `.env.${env}`);

  let parsed;
  try {
    parsed = parseEnvFile(envFilePath);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const { tasks } = parsed;
  if (tasks.length === 0) {
    console.error(`no secrets to sync from ${envFilePath}`);
    process.exit(1);
  }

  const targets: Array<"gh" | "gcp"> =
    target === "all" ? ["gh", "gcp"] : [target];

  // Resolve + persist routing for every target we're about to run.
  let cfgMutated = false;
  const ghRepo = targets.includes("gh")
    ? await resolveGhRepo(cfg, flags, () => {
        cfgMutated = true;
      })
    : undefined;
  const gcpProject = targets.includes("gcp")
    ? await resolveGcpProject(cfg, flags, () => {
        cfgMutated = true;
      })
    : undefined;

  if (cfgMutated) {
    await saveConfigFile(repo, env, cfg);
  }

  let totalOk = 0;
  const totalFailed: string[] = [];

  for (const t of targets) {
    const start = Date.now();
    let result;
    if (t === "gh") {
      await ensureBinary("gh");
      console.log(
        `\nSyncing ${tasks.length} secrets to GitHub: repo=${ghRepo}, environment=${env}`,
      );
      result = await runPool(tasks, WORKERS, TIMEOUT_MS, (task, signal) =>
        setGhSecret(task, ghRepo!, env, signal),
      );
    } else {
      await ensureBinary("gcloud");
      console.log(
        `\nSyncing ${tasks.length} secrets to GCP Secret Manager: project=${gcpProject}`,
      );
      result = await runPool(tasks, WORKERS, TIMEOUT_MS, (task, signal) =>
        setGcpSecret(task, gcpProject!, signal),
      );
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (result.failed.length > 0) {
      console.log(
        `  ${t}: ${result.ok} ok, ${result.failed.length} failed (${result.failed.join(", ")}) in ${elapsed}s`,
      );
    } else {
      console.log(`  ${t}: all ${result.ok} synced in ${elapsed}s`);
    }
    totalOk += result.ok;
    totalFailed.push(...result.failed.map((k) => `${t}:${k}`));
  }

  if (totalFailed.length > 0) {
    console.log(`\nDone — ${totalOk} ok, ${totalFailed.length} failed.`);
    process.exit(1);
  }
  console.log(`\n✅ All ${totalOk} secrets synced across ${targets.length} target(s).`);
}

async function resolveGhRepo(
  cfg: ConfigFile,
  flags: Record<string, string>,
  markMutated: () => void,
): Promise<string> {
  if (flags["gh-repo"]) {
    setSync(cfg, "gh", { repo: flags["gh-repo"] }, markMutated);
    return flags["gh-repo"];
  }
  if (cfg.sync?.gh?.repo) return cfg.sync.gh.repo;
  if (!isTty()) {
    throw new Error(
      "sync.gh.repo not configured for this (repo, env) and no --gh-repo flag passed.",
    );
  }
  const value = askText("GitHub repo for sync (owner/name)");
  if (!value) throw new Error("aborted (empty gh repo)");
  setSync(cfg, "gh", { repo: value }, markMutated);
  return value;
}

async function resolveGcpProject(
  cfg: ConfigFile,
  flags: Record<string, string>,
  markMutated: () => void,
): Promise<string> {
  if (flags["gcp-project"]) {
    setSync(cfg, "gcp", { project: flags["gcp-project"] }, markMutated);
    return flags["gcp-project"];
  }
  if (cfg.sync?.gcp?.project) return cfg.sync.gcp.project;
  if (!isTty()) {
    throw new Error(
      "sync.gcp.project not configured for this (repo, env) and no --gcp-project flag passed.",
    );
  }
  const value = askText("GCP project ID for sync");
  if (!value) throw new Error("aborted (empty gcp project)");
  setSync(cfg, "gcp", { project: value }, markMutated);
  return value;
}

function setSync(
  cfg: ConfigFile,
  target: "gh" | "gcp",
  block: ConfigFile["sync"] extends infer S ? S extends undefined ? never : NonNullable<S>[typeof target] : never,
  markMutated: () => void,
): void {
  cfg.sync = cfg.sync ?? {};
  // @ts-expect-error structural assignment narrowed by target
  cfg.sync[target] = block;
  markMutated();
}

async function setGhSecret(
  t: SecretTask,
  repo: string,
  environment: string,
  signal: AbortSignal,
): Promise<void> {
  console.log(`Setting secret: ${t.key}`);
  const proc = Bun.spawn({
    cmd: ["gh", "secret", "set", t.key, "--env", environment, "--repo", repo],
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

async function setGcpSecret(
  t: SecretTask,
  project: string,
  signal: AbortSignal,
): Promise<void> {
  console.log(`Setting secret: ${t.key}`);

  const exists = await secretExists(t.key, project, signal);

  const cmd = exists
    ? ["gcloud", "secrets", "versions", "add", t.key, "--data-file=-", `--project=${project}`]
    : [
        "gcloud", "secrets", "create", t.key,
        "--replication-policy=automatic",
        "--data-file=-",
        `--project=${project}`,
      ];

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

async function secretExists(
  name: string,
  project: string,
  signal: AbortSignal,
): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ["gcloud", "secrets", "describe", name, `--project=${project}`],
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  return (await proc.exited) === 0;
}

async function ensureBinary(name: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["which", name],
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    console.error(`${name} not found on PATH — install it before running vsync sync.`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
