#!/usr/bin/env bun
// Usage: secret-lib import <env> [<share-file>] [--repo=<name>] [--passphrase=<pp>] [--interactive]
//
// Reads the encrypted share file produced by `secret-lib export`, prompts
// for (or accepts via flag) the passphrase, decrypts, and installs:
//   - the config payload to ~/.config/deemwar/config/<repo>/env_<env>
//   - the encryption key into the OS keychain (com.deemwar.secret-lib / repo/env)
//
// After import you're ready to `secret-lib push <env>` / `pull <env>`.

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { saveConfigFile, configFilePath } from "../src/configfile";
import { setKey } from "../src/keychain";
import { parseShareFile } from "../src/sharefile";
import { askText, askSecret, isTty } from "../src/prompt";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  let filePath = positional[1] ?? flags.file;
  if (!env) {
    console.error(
      "usage: secret-lib import <env> [<share-file>] [--repo=<name>] [--passphrase=<pp>]",
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
    `  key:         OS keychain (service=com.deemwar.secret-lib, account=${repo}/${env})\n`,
  );
  console.log("Next step:");
  console.log(`  secret-lib pull ${env}   # download the latest .env + vault from S3`);
  console.log("");
  console.log("You can safely delete the .share file now — its contents are installed.");
  // Silence "unused var" linters from finalEnv assignment kept for clarity.
  void finalEnv;
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
