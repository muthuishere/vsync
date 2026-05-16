#!/usr/bin/env bun
// Usage: vsync export <env> [--repo=<name>] [--out=<path>] [--passphrase=<pp>] [--interactive]
//
// Bundles the on-disk per-repo config + the keychain-stored AES key into a
// passphrase-encrypted .share file that's safe to send via any channel
// (Slack DM, AirDrop, email — same envelope used by S3 pushes). The
// passphrase is auto-generated if not supplied and printed to stdout for
// the user to copy.
//
// Default output path: ./<repo>-<env>.share

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { loadConfigFile, configFilePath, DEFAULT_AUDIT_ENABLED } from "../src/repoconfig";
import { getKey } from "../src/keychain";
import { EXPORT_BLOB_VERSION, type ExportPayload } from "../src/envconfig";
import { buildShareFile } from "../src/sharefile";
import { generatePassphrase } from "../src/passphrase";
import { askText, isTty } from "../src/prompt";
import {
  appendAuditRow,
  buildMeta,
  gatherRowMetadata,
  makeAuditClient,
} from "../src/audit";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags, lists } = parseArgs(argv);
  const env = positional[0];
  if (!env) {
    console.error("usage: vsync export <env> [--repo=<name>] [--out=<path>] [--passphrase=<pp>]");
    process.exit(1);
  }
  const interactive = flags.interactive === "true";
  const repo = await getRepoName({ override: flags.repo });

  const cfg = await loadConfigFile(repo, env);
  if (!cfg) {
    console.error(
      `no config file for ${repo}/${env} at ${configFilePath(repo, env)}.\n` +
        `Run 'vsync init ${env}' first, or 'vsync import ${env} <share-file>' if a teammate sent you one.`,
    );
    process.exit(1);
  }
  const key = await getKey(repo, env);
  if (!key) {
    console.error(
      `encryption key for ${repo}/${env} not found in OS keychain.\n` +
        `Re-run 'vsync init ${env}' to generate a fresh one (will not match prior S3 bundles).`,
    );
    process.exit(1);
  }

  let passphrase = flags.passphrase;
  if ((!passphrase || interactive) && isTty()) {
    const generated = generatePassphrase();
    if (interactive) {
      const custom = askText(
        `Passphrase to encrypt the share file (blank → use generated "${generated}")`,
      );
      passphrase = custom || generated;
    } else {
      passphrase = generated;
    }
  }
  if (!passphrase) {
    passphrase = generatePassphrase();
  }

  const out = resolve(flags.out ?? `./${repo}-${env}.share`);

  const payload: ExportPayload = {
    version: EXPORT_BLOB_VERSION,
    repo,
    env,
    config: cfg,
    key,
  };

  const bytes = await buildShareFile(payload, passphrase);
  await writeFile(out, bytes, { mode: 0o600 });

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("✅ Share file written");
  console.log("─────────────────────────────────────────────────────────────\n");
  console.log(`  file:        ${out}`);
  console.log(`  passphrase:  ${passphrase}\n`);
  console.log("Send the file and the passphrase to your teammate on TWO different channels");
  console.log("(e.g. file via Slack DM, passphrase via SMS).\n");
  console.log("They will run:");
  console.log(`  vsync import ${env} ${out.split("/").pop()}`);

  await tryAppendAudit(cfg.s3, cfg.audit?.enabled, flags, lists, repo, env);
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
    const row = await gatherRowMetadata("export", "");
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
