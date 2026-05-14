#!/usr/bin/env bun
// Usage: secret-lib restore-backup <env> <backup-file> <target-dir> [--repo=<name>]
//
// Decrypts a ~/.config/localdevconfig/<env>-<ts>.zip.enc file using the
// key+salt from the (repo, env) config, then unzips into <target-dir>.
//
// Use this when a `pull` overwrote local edits and you want to recover
// the prior state from one of the rolling backups.

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { loadEnvConfig } from "../src/envconfig";
import { decrypt } from "../src/crypto";
import { unzipTo } from "../src/archive";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  const backupArg = positional[1];
  const targetArg = positional[2];
  if (!env || !backupArg || !targetArg) {
    console.error(
      "usage: secret-lib restore-backup <env> <backup-file> <target-dir> [--repo=<name>]",
    );
    process.exit(1);
  }
  const repo = await getRepoName({ override: flags.repo });

  const backupPath = resolve(backupArg);
  const targetDir = resolve(targetArg);

  if (!existsSync(backupPath)) {
    console.error(`backup file not found: ${backupPath}`);
    process.exit(1);
  }

  let cfg;
  try {
    cfg = await loadEnvConfig(repo, env);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  console.log(`[1/3] reading ${backupPath}`);
  const encrypted = await Bun.file(backupPath).bytes();

  console.log(`[2/3] decrypting with keychain-stored key`);
  const zipBytes = await decrypt(encrypted, cfg.encryption.key, cfg.encryption.salt);

  const tmpZip = join(
    tmpdir(),
    `restore-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
  );
  try {
    await Bun.write(tmpZip, zipBytes);
    console.log(`[3/3] unzipping into ${targetDir}`);
    await unzipTo(tmpZip, targetDir);
    console.log(`✅ restored ${backupPath} → ${targetDir}`);
  } finally {
    if (existsSync(tmpZip)) unlinkSync(tmpZip);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
