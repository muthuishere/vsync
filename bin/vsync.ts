#!/usr/bin/env bun
// Single CLI entry point. Dispatches to the per-subcommand modules.
//
// All subcommands accept (and many require):
//   <env>            positional — lowercase: dev, local, production, …
//   --repo=<name>    override the auto-detected repo name
//                    (env SECRETS_SYNC_REPO → package.json::name → git basename → cwd)
//   --interactive    force interactive prompts even when flags provided
//
// Designed for `bunx @muthuishere/vsync <subcommand> ...`.

import { migrateLegacyDefaultsIfNeeded } from "../src/migration";

// One-shot migration check for v0.13: if a legacy ~/.config/vsync/defaults
// file is present and no profiles/ dir exists yet, rename it to
// defaults.bak and print a notice to stderr. Idempotent — quiet on
// subsequent runs. See docs/specs/v0.13-profiles-init-status.md §5.
migrateLegacyDefaultsIfNeeded();

const SUBCOMMANDS = [
  "init",
  "export",
  "import",
  "use",
  "push",
  "pull",
  "versions",
  "sync",
  "audit",
  "docs",
  "profile",
  "status",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function usage(code = 0): never {
  const out = code === 0 ? console.log : console.error;
  out("usage: vsync <subcommand> [args...]");
  out("");
  out("setup");
  out("  init <env> --profile=<name>     create per-(repo, env) config + AES key from a named profile");
  out("");
  out("profiles");
  out("  profile list                    list named S3-credential profiles");
  out("  profile show <name>             show one profile (secret masked unless --reveal-secret)");
  out("  profile add  <name>             interactively create a new profile");
  out("  profile remove <name>           delete a profile (refuses without confirm)");
  out("");
  out("visibility (offline)");
  out("  status                          summarise local configs, profiles, and orphans");
  out("");
  out("sharing");
  out("  export <env> [--out=path]       write a passphrase-encrypted .share file");
  out("  import <env> <share-file>       restore a .share file into local config + keychain");
  out("");
  out("environment switch");
  out("  use <env> [--link=<path>]       symlink <path> (default ./.env) → <vaultFolder>/.env.<env>");
  out("  use                             print current ./.env (or --link=<path>) target");
  out("");
  out("day-to-day");
  out("  push <env>                      encrypt + upload local vault folder to s3://<bucket>/<repo>/<env>/");
  out("  pull <env>                      download from s3://<bucket>/<repo>/<env>/ + decrypt + unpack");
  out("  versions <env>                  list versions on S3 for this (repo, env) (read-only)");
  out("");
  out("external fanout");
  out("  sync <env> <target>             push <vaultFolder>/.env.<env> KVs to a secret store");
  out("                                  targets: gh | gcp | aws | azure | vault");
  out("");
  out("visibility");
  out("  audit <env> [--limit=N|--all|--csv]   show the append-only S3 audit log for this (repo, env)");
  out("");
  out("docs");
  out("  docs                            print the onboarding reference to stdout");
  out("");
  out("All commands accept --repo=<name> (defaults: $SECRETS_SYNC_REPO →");
  out("package.json::name → git basename → cwd basename) and --interactive.");
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
  case "init": {
    const { main } = await import("./init");
    await main(subArgv);
    break;
  }
  case "export": {
    const { main } = await import("./export");
    await main(subArgv);
    break;
  }
  case "import": {
    const { main } = await import("./import");
    await main(subArgv);
    break;
  }
  case "use": {
    const { main } = await import("./use");
    await main(subArgv);
    break;
  }
  case "push": {
    const { main } = await import("./push");
    await main(subArgv);
    break;
  }
  case "pull": {
    const { main } = await import("./pull");
    await main(subArgv);
    break;
  }
  case "versions": {
    const { main } = await import("./versions");
    await main(subArgv);
    break;
  }
  case "sync": {
    const { main } = await import("./sync");
    await main(subArgv);
    break;
  }
  case "audit": {
    const { main } = await import("./audit");
    await main(subArgv);
    break;
  }
  case "docs": {
    const { main } = await import("./docs");
    await main(subArgv);
    break;
  }
  case "profile": {
    const { main } = await import("./profile");
    await main(subArgv);
    break;
  }
  case "status": {
    const { main } = await import("./status");
    await main(subArgv);
    break;
  }
}
