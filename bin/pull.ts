#!/usr/bin/env bun
// Usage: vsync pull <env> [--repo=<name>]
//
// Reads the per-(repo, env) config + keychain key, backs up the current
// vault folder if any, downloads the latest encrypted bundle from S3,
// verifies the embedded manifest timestamp matches the `latest` pointer,
// decrypts, and unpacks into the resolved vault folder.

import { existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/argv";
import { wantsHelp, printHelp } from "../src/help";
import { getRepoName, getRepoRoot } from "../src/repo";
import { loadEnvConfig, resolveVaultFolder } from "../src/envconfig";
import { loadConfigFile, DEFAULT_AUDIT_ENABLED } from "../src/repoconfig";
import { unzipTo } from "../src/archive";
import { decrypt } from "../src/crypto";
import { unwrap } from "../src/manifest";
import { makeClient } from "../src/s3";
import { makeBackup } from "../src/backup";
import {
  appendAuditRow,
  buildMeta,
  gatherRowMetadata,
  makeAuditClient,
} from "../src/audit";
import {
  checkDirty,
  readLedger,
  snapshotLedger,
  writeLedger,
  LocalDirtyError,
} from "../src/ledger";
import { backupVault } from "../src/vaultbackup";

const HELP = `
NAME
  vsync pull — download + decrypt + unpack the latest vault folder from S3

SYNOPSIS
  vsync pull <env> [--repo=<name>] [audit flags]

DESCRIPTION
  Reads the per-(repo, env) config + keychain key, backs up the current
  local vault folder (encrypted with the same envelope as the S3 bundle),
  reads the s3://<bucket>/<repo>/<env>/latest pointer, downloads the
  matching <ts>.enc bundle, decrypts it, verifies the embedded manifest
  timestamp matches the pointer (defeats rename-attacks), and unpacks the
  zip into the repo root.

  The destination is the vault folder configured at \`vsync init\` time
  (cfg.files.vaultFolder ?? infra/vault/<env>). A best-effort \`pull\` row
  is appended to the audit log unless --no-audit or the per-env audit
  opt-out is set.

FLAGS
  --backup                 snapshot the current vault to
                           \$XDG_CONFIG_HOME/vsync/backups/<repo>/<env>.backup-<ts>/
                           before pulling. Use when local has unsynced edits
                           you may want to recover.
  --force                  discard any local edits without backing up.
                           Mutually exclusive with --backup.
  --no-audit               do not append an audit row for this pull
  --note=<text>            free-form note recorded in the audit row's meta
  --meta key=value         extra audit-row meta KV (repeatable)
  --repo=<name>            override the auto-detected repo name
  --help, -h               print this help and exit

ENVIRONMENT
  VSYNC_AUDIT_NOTE         fallback for --note=<text>
  VSYNC_AUDIT_META         fallback for --meta KVs (JSON object)

EXAMPLES
  # Daily pull
  vsync pull dev

  # Pull with a note recorded in the audit log
  vsync pull prod --note="picking up team-mate's secret rotation"

  # CI pull, skip the audit append
  vsync pull staging --no-audit

EXIT CODES
  0    bundle pulled, decrypted, and unpacked successfully
  1    missing config / key, empty pointer, decrypt failure, or tampered manifest

SEE ALSO
  vsync push(1)            inverse — encrypt + upload the local vault
  vsync versions(1)        list versions on S3 without pulling them
  vsync use(1)              symlink ./.env to the vault's .env.<env>
`;

export async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) printHelp(HELP);
  const { positional, flags, lists } = parseArgs(argv);
  const env = positional[0];
  if (!env) {
    console.error("usage: vsync pull <env> [--repo=<name>]");
    process.exit(1);
  }
  const repo = await getRepoName({ override: flags.repo });

  const wantForce = flags.force === "true";
  const wantBackup = flags.backup === "true";
  if (wantForce && wantBackup) {
    console.error("error: --force and --backup are mutually exclusive.");
    process.exit(1);
  }

  let cfg;
  try {
    cfg = await loadEnvConfig(repo, env);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  // Reload the on-disk ConfigFile to pick up `audit.enabled` (EnvConfig
  // doesn't carry it through).
  const cfgFile = await loadConfigFile(repo, env);
  const root = await getRepoRoot();
  const vaultFolder = resolveVaultFolder(cfg, env);
  const absVault = join(root, vaultFolder);

  // v0.17 — refuse-on-dirty unless --backup or --force was passed.
  const ledger = readLedger(repo, env);
  const diff = checkDirty(absVault, ledger);
  if (diff.kind === "dirty") {
    if (!wantForce && !wantBackup) {
      throw new LocalDirtyError(env, absVault, ledger!, diff);
    }
  } else if (diff.kind === "untracked" && ledger === null && existsSync(absVault)) {
    console.error(
      `⚠ no ledger for ${env} — first sync since v0.17 upgrade. This pull may overwrite local edits.`,
    );
    console.error(
      `  After this pull, vsync will track changes to prevent silent overwrites.`,
    );
  }

  const prefixKey = `${repo}/${env.toLowerCase()}/`;
  const pointerKey = `${prefixKey}latest`;
  const client = makeClient(cfg.s3);

  // v0.17 — --backup: snapshot current vault under XDG before pulling fresh.
  let plainBackupPath: string | null = null;
  if (wantBackup && existsSync(absVault)) {
    plainBackupPath = backupVault(repo, env, absVault);
    console.log(`[backup] vault snapshotted → ${plainBackupPath}`);
    rmSync(absVault, { recursive: true, force: true });
  } else if (wantForce && existsSync(absVault)) {
    rmSync(absVault, { recursive: true, force: true });
  }

  console.log(`[1/6] backing up local ${vaultFolder}/ (if any)`);
  const backup = await makeBackup(env, root, [vaultFolder], cfg.encryption);
  if (backup) {
    console.log(`      → ${backup}`);
  } else {
    console.log(`      (no local files yet, skipping)`);
  }

  console.log(`[2/6] reading pointer s3://${cfg.s3.bucket}/${pointerKey}`);
  const remoteTs = (await client.file(pointerKey).text()).trim();
  if (!remoteTs) {
    console.error(
      `pointer is empty — vsync push ${env} first to seed s3://${cfg.s3.bucket}/${prefixKey}`,
    );
    process.exit(1);
  }

  const versionKey = `${prefixKey}versions/${remoteTs}.enc`;
  console.log(`[3/6] downloading version ${remoteTs} (${versionKey})`);
  const encrypted = await client.file(versionKey).bytes();

  console.log(`[4/6] decrypting`);
  let wrapped: Uint8Array;
  try {
    wrapped = await decrypt(encrypted, cfg.encryption.key, cfg.encryption.salt);
  } catch (e) {
    console.error(
      `failed to decrypt s3://${cfg.s3.bucket}/${versionKey} — the keychain key for ${repo}/${env} doesn't match the bundle's seal.\n` +
        `Either the bundle was sealed by a different key (rotated since), or the bucket layout is wrong.\n` +
        `(${(e as Error).message ?? e})`,
    );
    process.exit(1);
  }

  console.log(`[5/6] verifying manifest ts`);
  const { ts: embeddedTs, payload: zipBytes } = unwrap(wrapped);
  if (embeddedTs !== remoteTs) {
    console.error(
      `pointer claims ${remoteTs} but bundle was sealed as ${embeddedTs} — refusing. Possible bucket tampering.`,
    );
    process.exit(1);
  }

  const tmpZip = join(
    tmpdir(),
    `pull-${remoteTs}-${Math.random().toString(36).slice(2)}.zip`,
  );
  try {
    await Bun.write(tmpZip, zipBytes);
    console.log(`[6/6] unzipping into ${root}`);
    await unzipTo(tmpZip, root);
    console.log(`✅ pulled ${repo}/${env} version ${remoteTs}`);
  } finally {
    if (existsSync(tmpZip)) unlinkSync(tmpZip);
  }

  // v0.17 — write the ledger from the freshly-pulled vault state.
  if (existsSync(absVault)) {
    const newLedger = snapshotLedger(absVault, remoteTs, "pull");
    writeLedger(repo, env, newLedger);
  }
  if (plainBackupPath) {
    console.log(`   prior state preserved at ${plainBackupPath}`);
  }

  await tryAppendAudit(cfg.s3, cfgFile?.audit?.enabled, flags, lists, repo, env, remoteTs);
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
  versionTs: string,
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
    const row = await gatherRowMetadata("pull", versionTs);
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
