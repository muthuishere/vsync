#!/usr/bin/env bun
// Single CLI entry point. Dispatches to the per-subcommand modules.
//
// All subcommands accept (and many require):
//   <env>            positional — lowercase: dev, local, production, …
//   --repo=<name>    override the auto-detected repo name
//                    (resolved from .vsync file → parsed git remote origin URL)
//                    Refuses to clobber a present .vsync that differs.
//   --interactive    force interactive prompts even when flags provided
//
// vsync requires a git repository (see docs/specs/v0.16-repo-identity-git-only.md).
// Outside a git tree, every subcommand errors with NotInGitRepoError.
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
  "keystore",
  "status",
  "runtime-token",
  "rotate-passphrase",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function usage(code = 0): never {
  const out = code === 0 ? console.log : console.error;
  out("usage: vsync <subcommand> [args...]");
  out("");
  out("Encrypted vault-folder sync between teammates, via an S3-compatible");
  out("bucket + OS keychain, with append-only audit log + fanout to GitHub,");
  out("GCP, AWS, Azure and HashiCorp Vault.");
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
  out("this machine");
  out("  keystore list                   every (repo, env) here + whether its key is present");
  out("  keystore export --all           seal chosen (repo,env) pairs + profiles into one .keytree");
  out("  keystore import <file>          restore a .keytree — profiles, configs and keys, in one step");
  out("");
  out("daily");
  out("  push <env>                      encrypt + upload local vault folder to s3://<bucket>/<repo>/<env>/");
  out("  pull <env>                      download from s3://<bucket>/<repo>/<env>/ + decrypt + unpack");
  out("  versions <env>                  list versions on S3 for this (repo, env) (read-only)");
  out("  use <env> [--link=<path>]       symlink <path> (default ./.env) → <vaultFolder>/.env.<env>");
  out("");
  out("teams (onboarding)");
  out("  export <env> [--out=path]       write a passphrase-encrypted .share file");
  out("  import <env> <share-file>       restore a .share file into local config + keychain");
  out("");
  out("deployment (external fanout)");
  out("  sync <env> <target>             push <vaultFolder>/.env.<env> KVs to a secret store");
  out("                                  targets: gh | gcp | aws | azure | vault");
  out("  runtime-token --env=<env>       mint the VSYNC_CONFIG bootstrap blob for runtime libs");
  out("");
  out("rotation");
  out("  rotate-passphrase --env=<env>   re-encrypt the bundle under a new passphrase");
  out("");
  out("info / visibility");
  out("  status                          summarise local configs, profiles, and orphans (offline)");
  out("  audit <env> [--limit=N|--all|--csv]   show the append-only S3 audit log for this (repo, env)");
  out("  docs [<topic>]                  what vsync does + how; or a setup/agent runbook (aws|gcp|custom|agent)");
  out("");
  out("Conventions");
  out("  Every subcommand accepts:");
  out("    --help, -h                    print detailed reference + examples and exit");
  out("    --repo=<name>                 override the auto-detected repo name");
  out("                                  (default: .vsync file → parsed git remote origin URL)");
  out("                                  Refuses to clobber a present .vsync that differs.");
  out("    --interactive                 force interactive prompts (where supported)");
  out("");
  out("Run `vsync <subcommand> --help` for detailed flags, examples, and exit codes.");
  out("Run `vsync --version` to print the installed CLI version.");
  out("");
  out("Provider setup runbooks: `vsync docs aws | gcp | custom`");
  out("AI agents / assistants:  `vsync docs agent` (workflow map: intent → command)");
  process.exit(code);
}

const subcommand = process.argv[2];
const subArgv = process.argv.slice(3);

if (subcommand === "--version" || subcommand === "-v" || subcommand === "version") {
  // Read the shipped package.json so the printed version can never drift from
  // the published package. Bun resolves JSON imports natively.
  const pkg = (await import("../package.json", { with: { type: "json" } }))
    .default as { version?: string };
  console.log(pkg.version ?? "unknown");
  process.exit(0);
}

if (!subcommand || subcommand === "--help" || subcommand === "-h") usage(0);

// Friendly aliases for natural plurals / synonyms — map to the canonical verb.
const ALIASES: Record<string, Subcommand> = { profiles: "profile" };
const canonical: string = ALIASES[subcommand] ?? subcommand;

if (!SUBCOMMANDS.includes(canonical as Subcommand)) {
  console.error(`unknown subcommand: ${subcommand}`);
  usage(1);
}

// Typed-error names that should be printed cleanly (no stack trace) at the
// top level. Each error's message field is already operator-facing.
const CLEAN_ERROR_NAMES = new Set([
  // v0.16 — repo identity
  "NotInGitRepoError",
  "RepoIdentityUnresolvedError",
  "VsyncFileMalformedError",
  "VsyncFileClobberError",
  "ShareRepoMismatchError",
  // v0.17 — pull safety / ledger
  "LocalDirtyError",
  "RemoteAheadError",
  "LedgerMalformedError",
  "SymlinkInVaultError",
]);

async function dispatch(): Promise<void> {
  switch (canonical as Subcommand) {
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
  case "keystore": {
    const { main } = await import("./keystore");
    await main(subArgv);
    break;
  }
  case "status": {
    const { main } = await import("./status");
    await main(subArgv);
    break;
  }
  case "runtime-token": {
    const { main } = await import("./runtime-token");
    await main(subArgv);
    break;
  }
  case "rotate-passphrase": {
    const { main } = await import("./rotate-passphrase");
    await main(subArgv);
    break;
  }
  }
}

try {
  await dispatch();
} catch (err) {
  if (err instanceof Error && CLEAN_ERROR_NAMES.has(err.name)) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
