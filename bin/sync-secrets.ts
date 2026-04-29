#!/usr/bin/env bun
// Usage: sync-secrets <ENV> <gh|gcp>
//
// Reads `<repo-root>/.env.<ENV>` and pushes each variable to the chosen
// secret backend, in parallel (6 workers, 10-min overall timeout).
//
// Routing config is read from the .env file itself:
//   - gh:  GITHUB_REPO=owner/repo   → environment name = <ENV> (literal)
//   - gcp: GCP_PROJECT_ID=...       → secrets are flat (project isolates envs)
//
// See src/envfile.ts for parsing rules and special-case keys
// (GCP_SA_KEY_FILE_PATH → GCP_SA_KEY, SSH_KEY_PATH → SSH_PRIVATE_KEY,
// GITHUB_TOKEN / GOOGLE_APPLICATION_CREDENTIALS skipped).

import { join } from "node:path";
import { parseArgs } from "../src/argv";
import { parseEnvFile, type SecretTask } from "../src/envfile";
import { runPool } from "../src/syncpool";
import { getRepoRoot } from "../src/repo";

const TARGETS = ["gh", "gcp"] as const;
type Target = (typeof TARGETS)[number];

const WORKERS = 6;
const TIMEOUT_MS = 10 * 60 * 1000;

export async function main(argv: string[]): Promise<void> {
  const { positional } = parseArgs(argv);
  const env = positional[0];
  const target = positional[1] as Target | undefined;

  if (!env || !target || !TARGETS.includes(target)) {
    console.error("usage: sync-secrets <ENV> <gh|gcp>");
    console.error("");
    console.error("  ENV     environment name; reads <repo-root>/.env.<ENV>");
    console.error("  gh      pushes to GitHub repo secrets (env = <ENV>)");
    console.error("  gcp     pushes to GCP Secret Manager (project from .env file)");
    process.exit(1);
  }

  const root = await getRepoRoot();
  const envFile = join(root, `.env.${env}`);

  let parsed;
  try {
    parsed = parseEnvFile(envFile);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const { tasks, meta } = parsed;
  if (tasks.length === 0) {
    console.error(`no secrets to sync from ${envFile}`);
    process.exit(1);
  }

  const start = Date.now();
  let result;

  if (target === "gh") {
    const repo = meta.GITHUB_REPO;
    if (!repo) {
      console.error(`GITHUB_REPO not found in ${envFile}`);
      process.exit(1);
    }
    await ensureBinary("gh");
    console.log(
      `Syncing ${tasks.length} secrets to GitHub: repo=${repo}, environment=${env}`,
    );
    result = await runPool(tasks, WORKERS, TIMEOUT_MS, (t, signal) =>
      setGhSecret(t, repo, env, signal),
    );
  } else {
    const project = meta.GCP_PROJECT_ID;
    if (!project) {
      console.error(`GCP_PROJECT_ID not found in ${envFile}`);
      process.exit(1);
    }
    await ensureBinary("gcloud");
    console.log(
      `Syncing ${tasks.length} secrets to GCP Secret Manager: project=${project}`,
    );
    result = await runPool(tasks, WORKERS, TIMEOUT_MS, (t, signal) =>
      setGcpSecret(t, project, signal),
    );
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (result.failed.length > 0) {
    console.log(
      `Done in ${elapsed}s — ${result.ok} ok, ${result.failed.length} failed: ${result.failed.join(", ")}`,
    );
    process.exit(0);
  }
  console.log(`✅ All ${result.ok} secrets synced in ${elapsed}s`);
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
    console.error(`${name} not found on PATH — install it before running sync-secrets.`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
