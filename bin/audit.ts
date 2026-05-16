#!/usr/bin/env bun
// Usage: vsync audit <env> [--limit=N] [--all] [--csv] [--repo=<name>]
//
// Fetches s3://<bucket>/<repo>/<env>/audit.csv and prints it. Default is a
// pretty table of the last 50 rows (newest first); --all shows everything;
// --limit=N picks a custom cap; --csv passes the raw CSV through for piping
// into shell tools or spreadsheets.
//
// Read-only: per spec §6, observing the log must not perturb it — this
// command does NOT append an audit row of its own.

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { loadConfigFile, configFilePath } from "../src/repoconfig";
import {
  makeAuditClient,
  readAuditLog,
  formatAuditTable,
  formatAuditCsv,
} from "../src/audit";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  if (!env) {
    console.error("usage: vsync audit <env> [--limit=N] [--all] [--csv] [--repo=<name>]");
    process.exit(1);
  }
  const repo = await getRepoName({ override: flags.repo });

  const cfg = await loadConfigFile(repo, env);
  if (!cfg) {
    console.error(
      `no config file for ${repo}/${env} at ${configFilePath(repo, env)}.\n` +
        `Run 'vsync init ${env}' first, or 'vsync import ${env} <share-file>' if a teammate sent you one.`,
    );
    process.exit(1);
  }

  const client = makeAuditClient(cfg.s3);

  let rows;
  try {
    rows = await readAuditLog(client, repo, env);
  } catch (e) {
    console.error(
      `failed to read audit log for ${repo}/${env}: ${(e as Error).message}`,
    );
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log(`(no audit log yet for ${repo}/${env})`);
    return;
  }

  if (flags.csv === "true") {
    process.stdout.write(formatAuditCsv(rows));
    return;
  }

  const all = flags.all === "true";
  const limit = flags.limit !== undefined ? parseInt(flags.limit, 10) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    console.error(`--limit must be a positive integer (got "${flags.limit}")`);
    process.exit(1);
  }
  console.log(formatAuditTable(rows, { limit, all }));
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
