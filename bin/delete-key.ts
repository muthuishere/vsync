#!/usr/bin/env bun
// Usage: secret-lib delete-key <env> [--repo=<name>] [--yes]
//
// Removes the encryption key for (repo, env) from the OS keychain.
// Idempotent — succeeds if the key was already gone. Requires --yes (or
// an interactive y/N) since this is unrecoverable except by re-import.

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { deleteKey } from "../src/keychain";
import { confirmYes } from "../src/prompt";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  if (!env) {
    console.error("usage: secret-lib delete-key <env> [--repo=<name>] [--yes]");
    process.exit(1);
  }
  const repo = await getRepoName({ override: flags.repo });
  const preApproved = flags.yes === "true";
  if (
    !confirmYes(
      `Delete the encryption key for ${repo}/${env} from OS keychain? (You'll need it again from a teammate to pull from S3.)`,
      preApproved,
    )
  ) {
    console.error("aborted");
    process.exit(1);
  }
  await deleteKey(repo, env);
  console.log(`✅ deleted key for ${repo}/${env}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
