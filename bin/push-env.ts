#!/usr/bin/env bun
// Usage: push-env <NAME> [--prefix=PREFIX]
//
// Reads <PREFIX>_<NAME>, zips the configured .env file + vault folder,
// wraps the zip in a plaintext manifest carrying the version timestamp,
// encrypts the bundle with AES-GCM (PBKDF2 from key+salt), uploads to:
//   s3://<bucket>/<name-lowercase>/versions/<timestamp>.enc
//   s3://<bucket>/<name-lowercase>/latest         (pointer to that timestamp)
//
// pull-env will refuse to accept the bundle if the embedded manifest ts
// doesn't match the `latest` pointer, defending against bucket-write
// pointer-swap attacks where an attacker without the encryption key
// repoints `latest` at a renamed copy of an older version.

import { existsSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/argv";
import { loadFromEnv } from "../src/envconfig";
import { zipPaths } from "../src/archive";
import { encrypt } from "../src/crypto";
import { wrap } from "../src/manifest";
import { makeClient } from "../src/s3";
import { getRepoRoot } from "../src/repo";
import { timestamp } from "../src/backup";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const name = positional[0];
  const prefix = flags.prefix;

  if (!name) {
    console.error("usage: push-env <NAME> [--prefix=PREFIX]");
    process.exit(1);
  }

  let cfg;
  try {
    cfg = loadFromEnv(name, prefix);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const root = await getRepoRoot();

  const envFile = cfg.files.envFile;
  const vaultFolder = cfg.files.vaultFolder;

  if (!existsSync(join(root, envFile))) {
    console.error(`env file not found: ${join(root, envFile)}`);
    process.exit(1);
  }
  if (
    !existsSync(join(root, vaultFolder)) ||
    !statSync(join(root, vaultFolder)).isDirectory()
  ) {
    console.error(`vault folder not found: ${join(root, vaultFolder)}`);
    process.exit(1);
  }

  const ts = timestamp();
  const prefixKey = `${name.toLowerCase()}/`;
  const versionKey = `${prefixKey}versions/${ts}.enc`;
  const pointerKey = `${prefixKey}latest`;

  const tmpZip = join(
    tmpdir(),
    `push-${ts}-${Math.random().toString(36).slice(2)}.zip`,
  );

  try {
    console.log(`[1/5] zipping ${envFile} + ${vaultFolder}/`);
    await zipPaths(root, [envFile, vaultFolder], tmpZip);

    console.log(`[2/5] sealing manifest ts=${ts}`);
    const zipBytes = await Bun.file(tmpZip).bytes();
    const wrapped = wrap(ts, zipBytes);

    console.log(`[3/5] encrypting`);
    const encrypted = await encrypt(
      wrapped,
      cfg.encryption.key,
      cfg.encryption.salt,
    );

    console.log(
      `[4/5] uploading ${encrypted.byteLength} bytes → s3://${cfg.s3.bucket}/${versionKey}`,
    );
    const client = makeClient(cfg.s3);
    await client.file(versionKey).write(encrypted);

    console.log(`[5/5] updating pointer → s3://${cfg.s3.bucket}/${pointerKey}`);
    await client.file(pointerKey).write(ts);

    console.log(`✅ pushed (version: ${ts})`);
  } finally {
    if (existsSync(tmpZip)) unlinkSync(tmpZip);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
