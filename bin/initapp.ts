#!/usr/bin/env bun
// Usage: secret-lib initapp [flags]
//
// Bootstraps a new repo for secret-lib:
//
//   .env / .env.<env> stubs for each env
//   .env.sample with placeholder shape (committed)
//   infra/vault/<env>/.gitkeep   for each env
//   infra/setup/Taskfile.yml     with per-env wrappers
//   .gitignore                   appends rules if missing
//
// All file writes are skip-if-exists by default; pass --force to overwrite.

import { parseArgs } from "../src/argv";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getRepoRoot } from "../src/repo";
import { askText, isTty } from "../src/prompt";

const DEFAULT_ENVS = ["local", "dev", "production"];

type GenAction = "wrote" | "skipped" | "appended";

export async function main(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);

  const force = flags.force === "true";
  const noTaskfile = flags["no-taskfile"] === "true";

  let envs: string[];
  if (flags.envs) {
    envs = flags.envs
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  } else if (isTty()) {
    const answer = askText(
      "Environments to scaffold (comma-separated)",
      DEFAULT_ENVS.join(","),
    );
    envs = answer
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  } else {
    envs = DEFAULT_ENVS;
  }
  if (envs.length === 0) {
    console.error("no environments to scaffold");
    process.exit(1);
  }
  for (const env of envs) {
    if (!/^[a-z][a-z0-9_-]*$/.test(env)) {
      console.error(
        `env name "${env}" is invalid — use lowercase letters/digits/underscore/hyphen, starting with a letter`,
      );
      process.exit(1);
    }
  }

  const root = await getRepoRoot();
  console.log(`Scaffolding secret-lib layout in ${root}`);
  console.log(`Environments: ${envs.join(", ")}\n`);

  const actions: { path: string; action: GenAction }[] = [];

  // 1) .env / .env.<env> stubs (gitignored)
  for (const env of envs) {
    const path = env === "local" ? ".env" : `.env.${env}`;
    actions.push({
      path,
      action: await writeIfMissing(
        join(root, path),
        envFileTemplate(env),
        force,
      ),
    });
  }

  // 2) .env.sample (committed)
  actions.push({
    path: ".env.sample",
    action: await writeIfMissing(join(root, ".env.sample"), sampleEnvFile(), force),
  });

  // 3) infra/vault/<env>/.gitkeep
  for (const env of envs) {
    const path = join("infra", "vault", env, ".gitkeep");
    actions.push({
      path,
      action: await writeIfMissing(join(root, path), "", force),
    });
  }

  // 4) infra/setup/Taskfile.yml
  if (!noTaskfile) {
    const path = join("infra", "setup", "Taskfile.yml");
    actions.push({
      path,
      action: await writeIfMissing(join(root, path), taskfileTemplate(envs), force),
    });
  }

  // 5) .gitignore — append rules if missing
  const giPath = join(root, ".gitignore");
  actions.push({
    path: ".gitignore",
    action: await appendGitignore(giPath, gitignoreLines(envs)),
  });

  console.log("Results:");
  for (const { path, action } of actions) {
    const icon = action === "wrote" ? "✅" : action === "appended" ? "➕" : "⏭️ ";
    console.log(`  ${icon} ${action.padEnd(8)} ${path}`);
  }

  console.log("\nNext steps:");
  console.log(`  1. secret-lib init ${envs[0]}        # generates key + writes config`);
  console.log(`  2. secret-lib push ${envs[0]}        # uploads .env + vault to S3`);
  console.log(`  3. secret-lib export ${envs[0]}      # shares with teammate`);
  console.log("");
  console.log("Edit the generated stubs (.env, .env.*) before pushing.");
}

function envFileTemplate(env: string): string {
  return `# .env${env === "local" ? "" : "." + env}
# Local secrets for the ${env} environment.
# Don't commit this file — it's listed in .gitignore.
# Mirror the shape in .env.sample.

`;
}

function sampleEnvFile(): string {
  return `# .env.sample
# Safe-to-commit placeholder file. Lists the variable names every env
# needs, with empty values. Real values live in .env / .env.<env>
# (gitignored), and the canonical bundle lives in S3 — sync via
# 'secret-lib push <env>' / 'secret-lib pull <env>'.

DATABASE_URL=
JWT_SECRET=
`;
}

function gitignoreLines(envs: string[]): string[] {
  const rules: string[] = [];
  for (const env of envs) {
    rules.push(env === "local" ? ".env" : `.env.${env}`);
  }
  rules.push(".env.*.local");
  rules.push("infra/vault/");
  rules.push("!infra/vault/**/.gitkeep");
  return rules;
}

function taskfileTemplate(envs: string[]): string {
  const perEnv = envs
    .map(
      (env) => `
  ${env}:init:
    desc: 'Generate config + key for ${env}'
    cmds: [{ task: init, vars: { ENV: ${env} } }]
  ${env}:push:
    desc: 'Encrypt + upload .env.${env === "local" ? "" : env} + vault to S3'
    cmds: [{ task: push, vars: { ENV: ${env} } }]
  ${env}:pull:
    desc: 'Download + decrypt latest ${env} bundle from S3'
    cmds: [{ task: pull, vars: { ENV: ${env} } }]
  ${env}:export:
    desc: 'Write share file for ${env} (send to teammate)'
    cmds: [{ task: export, vars: { ENV: ${env} } }]`,
    )
    .join("");

  return `version: '3'

# secret-lib wrapper tasks. Generated by 'secret-lib initapp'.
# All commands run via bunx — no install step.

vars:
  SECRET_LIB: bunx @muthuishere/secret-lib

tasks:
  init:
    desc: 'Generate key + config file (var ENV=...)'
    preconditions: [{ sh: '[ -n "{{.ENV}}" ]', msg: 'ENV is required (e.g. ENV=dev)' }]
    cmds: ['{{.SECRET_LIB}} init {{.ENV}}']

  push:
    desc: 'Upload local .env + vault to S3 (var ENV=...)'
    preconditions: [{ sh: '[ -n "{{.ENV}}" ]', msg: 'ENV is required' }]
    cmds: ['{{.SECRET_LIB}} push {{.ENV}}']

  pull:
    desc: 'Download + decrypt latest from S3 (var ENV=...)'
    preconditions: [{ sh: '[ -n "{{.ENV}}" ]', msg: 'ENV is required' }]
    cmds: ['{{.SECRET_LIB}} pull {{.ENV}}']

  export:
    desc: 'Write passphrase-encrypted .share file (var ENV=...)'
    preconditions: [{ sh: '[ -n "{{.ENV}}" ]', msg: 'ENV is required' }]
    cmds: ['{{.SECRET_LIB}} export {{.ENV}}']

  import:
    desc: 'Read a .share file (var ENV=..., FILE=path)'
    preconditions:
      - { sh: '[ -n "{{.ENV}}" ]',  msg: 'ENV is required' }
      - { sh: '[ -n "{{.FILE}}" ]', msg: 'FILE is required' }
    cmds: ['{{.SECRET_LIB}} import {{.ENV}} {{.FILE}}']
${perEnv}
`;
}

async function writeIfMissing(
  absPath: string,
  contents: string,
  force: boolean,
): Promise<GenAction> {
  if (existsSync(absPath) && !force) return "skipped";
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, contents);
  return "wrote";
}

async function appendGitignore(
  absPath: string,
  lines: string[],
): Promise<GenAction> {
  let existing = "";
  if (existsSync(absPath)) {
    existing = await readFile(absPath, "utf8");
  }
  const missing = lines.filter((l) => !lineIsPresent(existing, l));
  if (missing.length === 0) return "skipped";

  const block =
    (existing && !existing.endsWith("\n") ? "\n" : "") +
    "\n# Added by secret-lib initapp\n" +
    missing.join("\n") +
    "\n";

  if (existing) {
    await appendFile(absPath, block);
  } else {
    await writeFile(absPath, block.trimStart());
  }
  return existing ? "appended" : "wrote";
}

function lineIsPresent(content: string, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  for (const existing of content.split(/\r?\n/)) {
    if (existing.trim() === trimmed) return true;
  }
  return false;
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
