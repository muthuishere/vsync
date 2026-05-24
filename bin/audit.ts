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
import { wantsHelp, printHelp } from "../src/help";
import { getRepoName } from "../src/repo";
import { loadConfigFile, configFilePath } from "../src/repoconfig";
import {
  makeAuditClient,
  readAuditLog,
  formatAuditTable,
  formatAuditCsv,
} from "../src/audit";

const HELP = `
NAME
  vsync audit — show the append-only S3 audit log for this (repo, env)

SYNOPSIS
  vsync audit <env> [--limit=N | --all | --csv] [--repo=<name>]

DESCRIPTION
  Fetches s3://<bucket>/<repo>/<env>/audit.csv and prints it. The log is
  ETag-conditional append-only — every push, pull, export, import, and
  rotate emits a row with timestamp, actor, action, version timestamp,
  and a JSON \`meta\` cell (note + repeatable key=value pairs).

  Default output is a pretty table of the last 50 rows, newest first. Use
  --all to dump everything; --limit=N to pick a custom cap; --csv to emit
  the raw CSV for piping into shell tools or spreadsheets.

  Strictly read-only: per spec §6, observing the log must not perturb it,
  so this command does NOT append an audit row of its own.

  See docs/specs/v0.4-audit-log.md.

FLAGS
  --limit=<N>              show the most recent N rows (positive integer)
                           default: 50
  --all                    show every row (ignores --limit)
  --csv                    emit the raw CSV verbatim (suitable for piping)
  --repo=<name>            override the auto-detected repo name
  --help, -h               print this help and exit

EXAMPLES
  # Last 50 rows in a pretty table
  vsync audit dev

  # Last 200 rows
  vsync audit prod --limit=200

  # Everything
  vsync audit prod --all

  # Raw CSV → spreadsheet / shell pipeline
  vsync audit prod --csv > prod-audit.csv

EXIT CODES
  0    rows printed (zero or more)
  1    missing config, malformed --limit, or S3 read failed

SEE ALSO
  vsync push(1)            emits a \`push\` row (unless --no-audit)
  vsync pull(1)            emits a \`pull\` row (unless --no-audit)
  vsync rotate-passphrase(1) emits a \`rotate\` row
  docs/specs/v0.4-audit-log.md
`;

export async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) printHelp(HELP);
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
