#!/usr/bin/env bun
// Usage: secret-lib show-key <env> [--repo=<name>] [--yes]
//
// Prints the encryption key for (repo, env) to stdout. Requires --yes (or
// an interactive y/N confirmation) so you don't accidentally leak it
// when sharing a terminal screen.

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { getKey } from "../src/keychain";
import { confirmYes } from "../src/prompt";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  if (!env) {
    console.error("usage: secret-lib show-key <env> [--repo=<name>] [--yes]");
    process.exit(1);
  }
  const repo = await getRepoName({ override: flags.repo });

  const key = await getKey(repo, env);
  if (!key) {
    console.error(
      `no key for ${repo}/${env} in OS keychain. Run 'secret-lib init ${env}' or 'secret-lib link ${env} --key=…'.`,
    );
    process.exit(1);
  }

  const preApproved = flags.yes === "true";
  if (!confirmYes(`Print the encryption key for ${repo}/${env}?`, preApproved)) {
    console.error("aborted");
    process.exit(1);
  }
  console.log(key);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
