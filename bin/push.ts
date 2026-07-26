#!/usr/bin/env bun
// Usage: vsync push <env> [--repo=<name>]
//
// Reads the per-(repo, env) config + keychain key, zips the resolved
// vault folder (cfg.files.vaultFolder ?? infra/vault/<env>), encrypts
// with the keychain-stored AES key, and uploads versioned + pointer-
// sealed bundles to S3. See pull.ts for the inverse.

import { existsSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/argv";
import { wantsHelp, printHelp } from "../src/help";
import { getRepoName, getVaultRoot } from "../src/repo";
import { loadEnvConfig, resolveVaultFolder } from "../src/envconfig";
import { loadConfigFile, DEFAULT_AUDIT_ENABLED } from "../src/repoconfig";
import { zipPaths } from "../src/archive";
import { encrypt } from "../src/crypto";
import { wrap } from "../src/manifest";
import { makeClient } from "../src/s3";
import { timestamp } from "../src/backup";
import {
  appendAuditRow,
  buildMeta,
  gatherRowMetadata,
  makeAuditClient,
} from "../src/audit";
import {
  readLedger,
  snapshotLedger,
  writeLedger,
  RemoteAheadError,
} from "../src/ledger";
import { walkVault } from "../src/vaultwalk";

const HELP = `
NAME
  vsync push — encrypt + upload the local vault folder to S3

SYNOPSIS
  vsync push <env> [--repo=<name>] [audit flags]

DESCRIPTION
  Reads the per-(repo, env) config + keychain key, zips the resolved vault
  folder (cfg.files.vaultFolder ?? infra/vault/<env>), wraps the zip in a
  pointer-sealed manifest (magic RQEM0001 — embeds the version timestamp
  to defeat rename-attacks), encrypts the result with AES-256-GCM
  (magic RQE1, PBKDF2-SHA256 600k iters), and uploads to:

    s3://<bucket>/<repo>/<env>/versions/<ts>.enc
    s3://<bucket>/<repo>/<env>/latest    <- pointer text file (<ts>)

  A best-effort \`push\` row is appended to the audit log unless --no-audit
  or the per-env audit opt-out is set. The inverse is \`vsync pull <env>\`.

FLAGS
  --force                  overwrite the remote even if a teammate pushed since
                           your last sync. DANGEROUS — their work is lost.
  --no-audit               do not append an audit row for this push
  --note=<text>            free-form note recorded in the audit row's meta
  --meta key=value         extra audit-row meta KV (repeatable)
  --repo=<name>            override the auto-detected repo name
  --help, -h               print this help and exit

ENVIRONMENT
  VSYNC_AUDIT_NOTE         fallback for --note=<text>
  VSYNC_AUDIT_META         fallback for --meta KVs (JSON object)

EXAMPLES
  # Daily push
  vsync push dev

  # Push with a note attached to the audit row
  vsync push prod --note="hot-fix for #1423"

  # CI push, audit row skipped (audit handled out-of-band)
  vsync push staging --no-audit

EXIT CODES
  0    bundle uploaded; pointer swapped; audit row appended (or warning)
  1    missing config / key, missing vault folder, or S3 error

SEE ALSO
  vsync pull(1)            inverse — download + decrypt + unpack
  vsync versions(1)        list available versions on S3
  vsync audit(1)            inspect the append-only audit log
  vsync rotate-passphrase(1) re-encrypt the bundle under a new passphrase
`;

export async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) printHelp(HELP);
  const { positional, flags, lists } = parseArgs(argv);
  const env = positional[0];
  if (!env) {
    console.error("usage: vsync push <env> [--repo=<name>]");
    process.exit(1);
  }
  const repo = await getRepoName({ override: flags.repo });
  const wantForce = flags.force === "true";

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
  const root = await getVaultRoot();

  const vaultFolder = resolveVaultFolder(cfg, env);
  const absVault = join(root, vaultFolder);
  if (!existsSync(absVault) || !statSync(absVault).isDirectory()) {
    console.error(
      `vault folder not found: ${absVault}\n` +
        `Create it and put your secrets inside (e.g. ${vaultFolder}/.env.${env}).`,
    );
    process.exit(1);
  }

  // v0.17 — pre-flight symlink check (push surface for SymlinkInVaultError).
  walkVault(absVault);

  const ts = timestamp();
  const prefixKey = `${repo}/${env.toLowerCase()}/`;
  const versionKey = `${prefixKey}versions/${ts}.enc`;
  const pointerKey = `${prefixKey}latest`;

  // v0.17 — lost-update guard. Read the ledger; HEAD the remote pointer;
  // refuse if remote has advanced past our last sync (unless --force).
  const ledger = readLedger(repo, env);
  if (ledger && !wantForce) {
    try {
      const remoteTs = (await makeClient(cfg.s3).file(pointerKey).text()).trim();
      if (remoteTs && remoteTs > ledger.last_sync_ts) {
        throw new RemoteAheadError(env, ledger.last_sync_ts, remoteTs, ledger);
      }
    } catch (err: any) {
      if (err instanceof RemoteAheadError) throw err;
      // Pointer missing (404) → fresh prefix; nothing remote to be ahead of.
      // Network error → don't fail the push for a guard; fall through.
    }
  } else if (!ledger) {
    console.error(
      `⚠ no ledger for ${env} — first push since v0.17 upgrade. Lost-update guard disabled until ledger exists.`,
    );
  }

  const tmpZip = join(
    tmpdir(),
    `push-${ts}-${Math.random().toString(36).slice(2)}.zip`,
  );

  try {
    console.log(`[1/5] zipping ${vaultFolder}/`);
    await zipPaths(root, [vaultFolder], tmpZip);

    console.log(`[2/5] sealing manifest ts=${ts}`);
    const zipBytes = await Bun.file(tmpZip).bytes();
    const wrapped = wrap(ts, zipBytes);

    console.log(`[3/5] encrypting`);
    const encrypted = await encrypt(wrapped, cfg.encryption.key, cfg.encryption.salt);

    console.log(`[4/5] uploading ${encrypted.byteLength} bytes → s3://${cfg.s3.bucket}/${versionKey}`);
    const client = makeClient(cfg.s3);
    await client.file(versionKey).write(encrypted);

    console.log(`[5/5] updating pointer → s3://${cfg.s3.bucket}/${pointerKey}`);
    await client.file(pointerKey).write(ts);

    console.log(`✅ pushed ${repo}/${env} (version: ${ts})`);
  } finally {
    if (existsSync(tmpZip)) unlinkSync(tmpZip);
  }

  // v0.17 — write the ledger from the just-pushed vault state.
  const newLedger = snapshotLedger(absVault, ts, "push");
  writeLedger(repo, env, newLedger);

  await tryAppendAudit(cfg.s3, cfgFile?.audit?.enabled, flags, lists, repo, env, ts);
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
    const row = await gatherRowMetadata("push", versionTs);
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
