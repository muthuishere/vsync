#!/usr/bin/env bun
// Usage: pull-env <NAME> [--prefix=PREFIX]
//
// Reads <PREFIX>_<NAME>. If a local .env or vault folder already exists,
// encrypts them (same key+salt) and stores the encrypted zip at
// ~/.config/localdevconfig/<name>-<ts>.zip.enc (rolling 2-deep backup).
// Then downloads the latest encrypted bundle from S3, decrypts, verifies
// the embedded manifest timestamp matches the `latest` pointer, and
// unzips into the repo root — replacing local files.

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/argv";
import { loadFromEnv } from "../src/envconfig";
import { unzipTo } from "../src/archive";
import { decrypt } from "../src/crypto";
import { unwrap } from "../src/manifest";
import { makeClient } from "../src/s3";
import { getRepoRoot } from "../src/repo";
import { makeBackup } from "../src/backup";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const name = positional[0];
  const prefix = flags.prefix;

  if (!name) {
    console.error("usage: pull-env <NAME> [--prefix=PREFIX]");
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

  const prefixKey = `${name.toLowerCase()}/`;
  const pointerKey = `${prefixKey}latest`;
  const client = makeClient(cfg.s3);

  console.log(`[1/6] backing up local files (if any)`);
  const backup = await makeBackup(
    name,
    root,
    [cfg.files.envFile, cfg.files.vaultFolder],
    cfg.encryption,
  );
  if (backup) {
    console.log(`      → ${backup}`);
  } else {
    console.log(`      (no local files yet, skipping)`);
  }

  console.log(`[2/6] reading pointer s3://${cfg.s3.bucket}/${pointerKey}`);
  const remoteTs = (await client.file(pointerKey).text()).trim();
  if (!remoteTs) {
    console.error(
      `pointer is empty — push-env first to seed the bucket at s3://${cfg.s3.bucket}/${prefixKey}`,
    );
    process.exit(1);
  }

  const versionKey = `${prefixKey}versions/${remoteTs}.enc`;
  console.log(`[3/6] downloading version ${remoteTs} (${versionKey})`);
  const encrypted = await client.file(versionKey).bytes();

  console.log(`[4/6] decrypting`);
  const wrapped = await decrypt(
    encrypted,
    cfg.encryption.key,
    cfg.encryption.salt,
  );

  console.log(`[5/6] verifying manifest ts`);
  const { ts: embeddedTs, payload: zipBytes } = unwrap(wrapped);
  if (embeddedTs !== remoteTs) {
    console.error(
      `pointer claims ${remoteTs} but bundle was sealed as ${embeddedTs} — refusing.`,
    );
    console.error(
      `someone with bucket write may have repointed 'latest' to a renamed older version.`,
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
    console.log(`✅ pulled version ${remoteTs}`);
  } finally {
    if (existsSync(tmpZip)) unlinkSync(tmpZip);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
