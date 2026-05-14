#!/usr/bin/env bun
// Single CLI entry point. Dispatches to the per-subcommand modules.
//
// All subcommands accept (and many require):
//   <env>            positional — lowercase: dev, local, production, …
//   --repo=<name>    override the auto-detected repo name
//                    (env SECRETS_SYNC_REPO → package.json::name → git basename)
//   --interactive    force interactive prompts even when flags provided
//
// Designed for `bunx github:muthuishere/secret-lib <subcommand> ...`.

const SUBCOMMANDS = [
  "initapp",
  "init",
  "export",
  "import",
  "push",
  "pull",
  "link",
  "show-key",
  "delete-key",
  "restore-backup",
  "sync-secrets",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function usage(code = 0): never {
  const out = code === 0 ? console.log : console.error;
  out("usage: secret-lib <subcommand> [args...]");
  out("");
  out("bootstrap");
  out("  initapp [flags]                 scaffold .env stubs + infra/vault + Taskfile in this repo");
  out("");
  out("setup + sharing");
  out("  init <env> [flags]              create config file + generate AES key");
  out("  export <env> [--out=path]       write a passphrase-encrypted share file");
  out("  import <env> <share-file>       restore a share file into local config + keychain");
  out("  link <env> --key=<key>          save a key to the keychain (when file already exists)");
  out("");
  out("day-to-day");
  out("  push <env>                      upload local .env + vault to S3");
  out("  pull <env>                      download from S3");
  out("  restore-backup <env> <bk> <to>  unzip a local backup with the keychain key");
  out("");
  out("inspection");
  out("  show-key <env> [--yes]          print the key (requires confirmation)");
  out("  delete-key <env> [--yes]        remove the key from the keychain");
  out("");
  out("other");
  out("  sync-secrets <env> <gh|gcp>     push the rendered .env to GitHub / GCP Secret Manager");
  out("");
  out("All commands accept --repo=<name> (defaults: $SECRETS_SYNC_REPO →");
  out("package.json::name → git basename → cwd basename).");
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
  case "initapp": {
    const { main } = await import("./initapp");
    await main(subArgv);
    break;
  }
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
  case "link": {
    const { main } = await import("./link");
    await main(subArgv);
    break;
  }
  case "show-key": {
    const { main } = await import("./show-key");
    await main(subArgv);
    break;
  }
  case "delete-key": {
    const { main } = await import("./delete-key");
    await main(subArgv);
    break;
  }
  case "restore-backup": {
    const { main } = await import("./restore-backup");
    await main(subArgv);
    break;
  }
  case "sync-secrets": {
    const { main } = await import("./sync-secrets");
    await main(subArgv);
    break;
  }
}
