#!/usr/bin/env bun
// Single CLI entry point. Dispatches to the per-subcommand modules.
//
// Usage:
//   secret-lib init-env <NAME> [path-to-json] [--prefix=PREFIX]
//   secret-lib push-env <NAME> [--prefix=PREFIX]
//   secret-lib pull-env <NAME> [--prefix=PREFIX]
//   secret-lib restore-backup <NAME> <backup-file> <target-dir> [--prefix=PREFIX]
//
// Designed for `bunx github:muthuishere/secret-lib <subcommand> ...`.

const SUBCOMMANDS = ["init-env", "push-env", "pull-env", "restore-backup"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function usage(code = 0): never {
  const out = code === 0 ? console.log : console.error;
  out("usage: secret-lib <subcommand> [args...]");
  out("");
  out("subcommands:");
  out("  init-env <NAME> [path-to-json] [--prefix=PREFIX]");
  out("  push-env <NAME> [--prefix=PREFIX]");
  out("  pull-env <NAME> [--prefix=PREFIX]");
  out("  restore-backup <NAME> <backup-file> <target-dir> [--prefix=PREFIX]");
  out("");
  out("PREFIX defaults to $SECRETS_SYNC_PREFIX or SECRETS_ENV.");
  process.exit(code);
}

const subcommand = process.argv[2];
const subArgv = process.argv.slice(3);

if (!subcommand || subcommand === "--help" || subcommand === "-h") usage(0);

if (!SUBCOMMANDS.includes(subcommand as Subcommand)) {
  console.error(`unknown subcommand: ${subcommand}`);
  usage(1);
}

switch (subcommand as Subcommand) {
  case "init-env": {
    const { main } = await import("./init-env");
    await main(subArgv);
    break;
  }
  case "push-env": {
    const { main } = await import("./push-env");
    await main(subArgv);
    break;
  }
  case "pull-env": {
    const { main } = await import("./pull-env");
    await main(subArgv);
    break;
  }
  case "restore-backup": {
    const { main } = await import("./restore-backup");
    await main(subArgv);
    break;
  }
}
