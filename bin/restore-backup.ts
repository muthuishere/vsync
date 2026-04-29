#!/usr/bin/env bun
// Usage: restore-backup <NAME> <backup-file> <target-dir> [--prefix=PREFIX]
//
// Decrypts a ~/.config/localdevconfig/<name>-<ts>.zip.enc file using the
// key+salt from <PREFIX>_<NAME>, then unzips into <target-dir>.
//
// Use this when a `pull-env` overwrote local edits and you want to recover
// the prior state from one of the rolling backups.

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "../src/argv";
import { loadFromEnv } from "../src/envconfig";
import { decrypt } from "../src/crypto";
import { unzipTo } from "../src/archive";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const name = positional[0];
  const backupArg = positional[1];
  const targetArg = positional[2];
  const prefix = flags.prefix;

  if (!name || !backupArg || !targetArg) {
    console.error(
      "usage: restore-backup <NAME> <backup-file> <target-dir> [--prefix=PREFIX]",
    );
    process.exit(1);
  }

  const backupPath = resolve(backupArg);
  const targetDir = resolve(targetArg);

  if (!existsSync(backupPath)) {
    console.error(`backup file not found: ${backupPath}`);
    process.exit(1);
  }

  let cfg;
  try {
    cfg = loadFromEnv(name, prefix);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  console.log(`[1/3] reading ${backupPath}`);
  const encrypted = await Bun.file(backupPath).bytes();

  console.log(`[2/3] decrypting with key+salt from env`);
  const zipBytes = await decrypt(
    encrypted,
    cfg.encryption.key,
    cfg.encryption.salt,
  );

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
