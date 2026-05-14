#!/usr/bin/env bun
// Usage:
//   secret-lib init <env> [flags] [--interactive]
//
// Sets up a new (repo, env) pair locally:
//   1. Collects S3 bucket creds + file paths (via flags, prompts, or both)
//   2. Generates a fresh AES key
//   3. Writes the config file to ~/.config/deemwar/config/<repo>/env_<env>
//   4. Saves the key to the OS keychain via Bun.secrets
//   5. Hints at `secret-lib export <env>` for sharing with teammates
//
// Driven by flags (scripting) OR interactive prompts (humans). The
// `--interactive` flag forces prompts even when every flag is provided —
// useful for double-checking on first run.
//
// Flags (any can be passed to skip its prompt):
//   --repo=<name>            Override auto-detected repo name
//   --bucket=<name>          S3 bucket
//   --endpoint=<url>         S3 endpoint (e.g. https://s3.eu-central-003.backblazeb2.com)
//   --region=<name>          S3 region (e.g. eu-central-003)
//   --access-key=<id>        S3 access key ID
//   --secret-key=<secret>    S3 secret access key
//   --use-ssl=<true|false>   Force TLS (default true)
//   --env-file=<path>        Path to the .env file to sync (default .env.<env>)
//   --vault-folder=<path>    Path to the vault folder to sync (default infra/vault/<env>)
//   --salt=<string>          Pin a specific salt (default: random 24-char base64)
//   --interactive            Prompt even for fields already provided via flags

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { saveConfigFile, configFilePath, type ConfigFile } from "../src/configfile";
import { setKey, generateKey } from "../src/keychain";
import { askText, askBool, isTty } from "../src/prompt";

function envFromArg(env?: string): string {
  if (!env) throw new Error("env is required (e.g. dev, local, production)");
  if (!/^[a-z][a-z0-9_-]*$/.test(env)) {
    throw new Error(
      `env must be lowercase letters/digits/underscore/hyphen (got "${env}")`,
    );
  }
  return env;
}

function randomSalt(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = envFromArg(positional[0]);
  const interactive = flags.interactive === "true";

  const repo = await getRepoName({ override: flags.repo });

  // Each field uses (flag value | prompt | default). Pure-flag mode skips
  // the prompt; pure-interactive mode (no flags) prompts for everything.
  const ask = (label: string, def?: string): string => {
    if (!isTty()) {
      if (def !== undefined) return def;
      throw new Error(
        `missing ${label} (no TTY for prompts — pass --${label.toLowerCase().replace(/\s+/g, "-")}=…)`,
      );
    }
    return askText(label, def);
  };

  const get = (flagKey: string, label: string, def?: string): string => {
    const v = flags[flagKey];
    if (v !== undefined && v !== "" && !interactive) return v;
    return ask(label, v ?? def);
  };

  console.log(`Setting up ${repo} / ${env}\n`);
  console.log(`Repo: ${repo}   (override with --repo=<name>)`);
  console.log(`Env:  ${env}`);
  console.log("Press Ctrl-C to abort. Defaults shown in [brackets].\n");

  const endpoint = get("endpoint", "S3 endpoint URL");
  const region = get("region", "S3 region");
  const bucket = get("bucket", "S3 bucket name");
  const accessKeyId = get("access-key", "S3 access key ID");
  const secretAccessKey = get("secret-key", "S3 secret access key");
  const useSslRaw = flags["use-ssl"];
  const useSsl =
    useSslRaw !== undefined && !interactive
      ? useSslRaw !== "false"
      : isTty()
        ? askBool("Use TLS for S3?", useSslRaw !== "false")
        : true;
  const envFile = get("env-file", "Env file (relative to repo root)", `.env.${env}`);
  const vaultFolder = get(
    "vault-folder",
    "Vault folder (relative to repo root)",
    `infra/vault/${env}`,
  );
  const salt = flags.salt && !interactive ? flags.salt : flags.salt ?? randomSalt();

  const cfg: ConfigFile = {
    s3: {
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      useSsl,
    },
    encryption: { salt },
    files: { envFile, vaultFolder },
  };

  const filePath = await saveConfigFile(repo, env, cfg);

  const key = generateKey();
  await setKey(repo, env, key);

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("✅ Setup complete");
  console.log("─────────────────────────────────────────────────────────────\n");
  console.log(`  config file: ${filePath} (0600)`);
  console.log(
    `  key:         OS keychain (service=com.deemwar.secret-lib, account=${repo}/${env})\n`,
  );
  console.log("Next steps:");
  console.log(`  1. Push your local .env + vault to S3:`);
  console.log(`        secret-lib push ${env}\n`);
  console.log(`  2. Share with a teammate (one file + one passphrase, sent on different channels):`);
  console.log(`        secret-lib export ${env}\n`);
  console.log(`     They'll run:`);
  console.log(`        secret-lib import ${env} <share-file>`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
