#!/usr/bin/env bun
// Usage: vsync import <env> [<share-file>] [--repo=<name>] [--passphrase=<pp>] [--interactive]
//
// Reads the encrypted share file produced by `vsync export`, prompts
// for (or accepts via flag) the passphrase, decrypts, and installs:
//   - the per-repo config to ~/.config/vsync/<repo>/env_<env>
//   - the encryption key into the OS keychain (tools.vsync / <repo>/<env>)
//
// After import you're ready to `vsync pull <env>` / `push <env>`.

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { saveConfigFile, configFilePath, DEFAULT_AUDIT_ENABLED } from "../src/repoconfig";
import { setKey } from "../src/keychain";
import { parseShareFile } from "../src/sharefile";
import { askText, askSecret, isTty } from "../src/prompt";
import {
  appendAuditRow,
  buildMeta,
  gatherRowMetadata,
  makeAuditClient,
} from "../src/audit";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags, lists } = parseArgs(argv);
  const env = positional[0];
  let filePath = positional[1] ?? flags.file;
  if (!env) {
    console.error(
      "usage: vsync import <env> [<share-file>] [--repo=<name>] [--passphrase=<pp>]",
    );
    process.exit(1);
  }

  // CLI override for repo *during import*. Whichever the file embedded for
  // `repo` is treated as truth unless the user passes --repo to remap.
  const repoOverride = flags.repo;

  if (!filePath) {
    if (!isTty()) {
      console.error("missing share-file path (positional or --file=…) and stdin is not a TTY");
      process.exit(1);
    }
    filePath = askText("Path to the .share file received");
  }
  const absPath = resolve(filePath);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(absPath);
  } catch (e: any) {
    console.error(`failed to read ${absPath}: ${e?.message ?? e}`);
    process.exit(1);
  }

  let passphrase = flags.passphrase;
  if (!passphrase) {
    if (!isTty()) {
      console.error(
        "missing --passphrase=… and stdin is not a TTY — can't prompt for it",
      );
      process.exit(1);
    }
    passphrase = await askSecret("Passphrase");
  }

  let payload;
  try {
    payload = await parseShareFile(bytes, passphrase);
  } catch (e: any) {
    console.error((e as Error).message);
    process.exit(1);
  }

  if (repoOverride && repoOverride !== payload.repo) {
    console.log(
      `[notice] --repo=${repoOverride} overrides repo embedded in share file (${payload.repo})`,
    );
  }
  const repo = repoOverride || payload.repo;
  const finalEnv = payload.env || env;
  if (payload.env !== env) {
    console.log(
      `[notice] share file is for env=${payload.env}; importing under requested env=${env}`,
    );
  }

  const saved = await saveConfigFile(repo, env, payload.config);
  await setKey(repo, env, payload.key);

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("✅ Import complete");
  console.log("─────────────────────────────────────────────────────────────\n");
  console.log(`  config file: ${saved}`);
  console.log(
    `  key:         OS keychain (service=tools.vsync, account=${repo}/${env})\n`,
  );
  console.log("Next step:");
  console.log(`  vsync pull ${env}   # download the latest vault folder from S3`);
  console.log("");
  console.log("You can safely delete the .share file now — its contents are installed.");
  // Silence "unused var" linters from finalEnv assignment kept for clarity.
  void finalEnv;

  await tryAppendAudit(payload.config.s3, payload.config.audit?.enabled, flags, lists, repo, env);
}

/**
 * Best-effort audit append. Honours both the per-(repo, env) opt-out
 * (`cfg.audit.enabled === false`) and the per-invocation `--no-audit`
 * flag. Any throw from the append path is downgraded to a stderr warning
 * so the parent command's exit code is unaffected.
 */
async function tryAppendAudit(
  s3: Parameters<typeof makeAuditClient>[0],
  enabled: boolean | undefined,
  flags: Record<string, string>,
  lists: Record<string, string[]>,
  repo: string,
  env: string,
): Promise<void> {
  if (flags["no-audit"] === "true") return;
  const on = enabled ?? DEFAULT_AUDIT_ENABLED;
  if (!on) return;

  let meta;
  try {
    meta = buildMeta({
      envMeta: process.env.VSYNC_AUDIT_META,
      envNote: process.env.VSYNC_AUDIT_NOTE,
      flagMetaList: lists.meta,
      flagNote: flags.note,
    });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  for (const w of meta.warnings) console.error(w);

  try {
    const row = await gatherRowMetadata("import", "");
    row.meta = meta.json;
    const client = makeAuditClient(s3);
    await appendAuditRow(client, repo, env, row);
  } catch (e) {
    console.error(`warning: failed to record audit entry: ${(e as Error).message}`);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
