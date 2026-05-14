#!/usr/bin/env bun
// Usage: secret-lib link <env> [--repo=<name>] [--key=<key>] [--interactive]
//
// Saves an encryption key to the OS keychain for an existing (repo, env).
// Use when you already have the config file but the keychain entry is
// gone — typically after a fresh OS install where someone re-shared just
// the key out-of-band. For the common case of joining a project, use
// `secret-lib import` instead (it does both file + key in one go).

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { setKey } from "../src/keychain";
import { askSecret, isTty } from "../src/prompt";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  if (!env) {
    console.error("usage: secret-lib link <env> [--repo=<name>] [--key=<key>]");
    process.exit(1);
  }
  const repo = await getRepoName({ override: flags.repo });

  let key = flags.key;
  if (!key) {
    if (!isTty()) {
      console.error("missing --key=… and stdin is not a TTY");
      process.exit(1);
    }
    key = await askSecret(`Encryption key for ${repo}/${env}`);
  }
  if (!key || key.length < 20) {
    console.error(`key is missing or shorter than 20 chars`);
    process.exit(1);
  }

  await setKey(repo, env, key);
  console.log(
    `✅ linked key for ${repo}/${env} (saved to OS keychain at service=com.deemwar.secret-lib, account=${repo}/${env}).`,
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
