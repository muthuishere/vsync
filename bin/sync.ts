#!/usr/bin/env bun
// Usage: vsync sync <env> <gh|gcp|aws|azure|vault> [routing flags] [parser flags]
//
// Reads <vaultFolder>/.env.<env> and pushes each variable to the named
// secret backend. The dispatcher looks the target up in the HANDLERS
// registry (src/synctargets/index.ts); each handler owns its routing
// resolution, banner, and runSync — see docs/specs/v0.8-multi-target-sync.md.

import { join } from "node:path";
import { parseArgs } from "../src/argv";
import { parseEnvFile } from "../src/envfile";
import { getRepoName, getRepoRoot } from "../src/repo";
import { loadConfigFile, saveConfigFile } from "../src/repoconfig";
import { resolveVaultFolder } from "../src/envconfig";
import { HANDLERS, type TargetName } from "../src/synctargets";

const WORKERS = 6;
const TIMEOUT_MS = 10 * 60 * 1000;

export async function main(argv: string[]): Promise<void> {
  const { positional, flags, lists } = parseArgs(argv);
  const env = positional[0];
  const target = positional[1] as TargetName | undefined;

  if (!env || !target || !(target in HANDLERS)) {
    usage();
    process.exit(1);
  }

  const inlineFileSuffixes = lists["inline-file-suffix"] ?? [];
  const excludeProperties = lists["exclude-property"] ?? [];

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

  printPolicyHeader(inlineFileSuffixes, excludeProperties);

  let parsed;
  try {
    parsed = parseEnvFile(envFilePath, {
      inlineFileSuffixes,
      excludeProperties,
    });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const { tasks, skipped } = parsed;
  if (tasks.length === 0) {
    console.error(`no secrets to sync from ${envFilePath}`);
    process.exit(1);
  }

  const handler = HANDLERS[target];
  const { routing, mutated } = await handler.resolveRouting(cfg, flags);
  if (mutated) await saveConfigFile(repo, env, cfg);

  await ensureBinary(handler.bin);

  console.log(handler.banner(routing as any, env, tasks.length));
  printSkipped(skipped);

  const ctrl = new AbortController();
  const start = Date.now();
  const result = await handler.runSync(tasks, routing as any, {
    workers: WORKERS,
    timeoutMs: TIMEOUT_MS,
    env,
    signal: ctrl.signal,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (result.failed.length > 0) {
    console.log(
      `\n${target}: ${result.ok} ok, ${result.failed.length} failed (${result.failed.join(", ")}) in ${elapsed}s`,
    );
    process.exit(1);
  }
  console.log(
    `\n✅ ${result.ok} secrets synced to ${target} in ${elapsed}s.`,
  );
}

function usage(): void {
  console.error("usage: vsync sync <env> <gh|gcp|aws|azure|vault>");
  console.error("");
  console.error("  env      environment name; reads <vaultFolder>/.env.<env>");
  console.error("  gh       push to GitHub repo secrets (env = <env>)");
  console.error("  gcp      push to GCP Secret Manager");
  console.error("  aws      push to AWS Secrets Manager");
  console.error("  azure    push to Azure Key Vault");
  console.error("  vault    push to HashiCorp Vault KV v2 (single bulk write)");
  console.error("");
  console.error("  One target per invocation.");
  console.error("");
  console.error("Parser policy (no defaults — pass explicitly):");
  console.error("  --inline-file-suffix=<suf>   key suffix that turns a value into a file ref (repeatable)");
  console.error("  --exclude-property=<key>     key to skip entirely (repeatable)");
  console.error("");
  console.error("Routing flags (per target):");
  console.error("  --gh-repo=<owner/name>");
  console.error("  --gcp-project=<id>");
  console.error("  --aws-region=<region>           [--aws-secret-prefix=<prefix>]");
  console.error("  --azure-vault=<vault-name>");
  console.error("  --vault-addr=<url> --vault-mount=<mount> --vault-path=<path>");
  console.error("  --repo=<name>");
}

export function printPolicyHeader(
  inlineFileSuffixes: string[],
  excludeProperties: string[],
): void {
  console.log("\nParser policy:");
  if (inlineFileSuffixes.length === 0) {
    console.log("  inline-file-suffix: (none — file refs disabled)");
  } else {
    for (const suf of inlineFileSuffixes) {
      console.log(`  inline-file-suffix: ${suf}`);
    }
  }
  if (excludeProperties.length === 0) {
    console.log("  exclude-property:   (none — nothing skipped)");
  } else {
    for (const key of excludeProperties) {
      console.log(`  exclude-property:   ${key}`);
    }
  }
}

function printSkipped(
  skipped: Array<{ key: string; reason: "excluded" }>,
): void {
  for (const s of skipped) {
    console.log(`  skipped (${s.reason}): ${s.key}`);
  }
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
