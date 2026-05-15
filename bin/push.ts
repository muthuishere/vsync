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
import { getRepoName, getRepoRoot } from "../src/repo";
import { loadEnvConfig, resolveVaultFolder } from "../src/envconfig";
import { zipPaths } from "../src/archive";
import { encrypt } from "../src/crypto";
import { wrap } from "../src/manifest";
import { makeClient } from "../src/s3";
import { timestamp } from "../src/backup";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  if (!env) {
    console.error("usage: vsync push <env> [--repo=<name>]");
    process.exit(1);
  }
  const repo = await getRepoName({ override: flags.repo });

  let cfg;
  try {
    cfg = await loadEnvConfig(repo, env);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const root = await getRepoRoot();

  const vaultFolder = resolveVaultFolder(cfg, env);
  const absVault = join(root, vaultFolder);
  if (!existsSync(absVault) || !statSync(absVault).isDirectory()) {
    console.error(
      `vault folder not found: ${absVault}\n` +
        `Create it and put your secrets inside (e.g. ${vaultFolder}/.env.${env}).`,
    );
    process.exit(1);
  }

  const ts = timestamp();
  const prefixKey = `${env.toLowerCase()}/`;
  const versionKey = `${prefixKey}versions/${ts}.enc`;
  const pointerKey = `${prefixKey}latest`;

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
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
