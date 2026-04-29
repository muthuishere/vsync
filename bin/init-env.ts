#!/usr/bin/env bun
// Usage: init-env <NAME> [path-to-json] [--prefix=PREFIX]
//
// Reads a JSON config file (default: <scripts-dir>/envconfig.<lowercase-name>.json)
// matching the shape in envconfig.sample.json, validates it, gzip+base64-encodes
// it, and prints the `export <PREFIX>_<NAME>='...'` line ready to paste into
// your shell rc / 1Password.
//
// PREFIX defaults to $SECRETS_SYNC_PREFIX or SECRETS_ENV.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "../src/argv";
import { encode, envVarName, validate, type EnvConfig } from "../src/envconfig";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const name = positional[0];
  const customPath = positional[1];
  const prefix = flags.prefix;

  if (!name) {
    console.error("usage: init-env <NAME> [path-to-json] [--prefix=PREFIX]");
    console.error("");
    console.error("  NAME           UPPER_SNAKE_CASE (e.g. LOCAL, DEV, PRODUCTION)");
    console.error("  path-to-json   optional; defaults to envconfig.<lowercase-name>.json");
    console.error("                 next to scripts/. See envconfig.sample.json for shape.");
    console.error("  --prefix=      optional; falls back to $SECRETS_SYNC_PREFIX or SECRETS_ENV");
    process.exit(1);
  }

  let ENV_VAR: string;
  try {
    ENV_VAR = envVarName(name, prefix);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const scriptsDir = resolve(import.meta.dir, "..");
  const defaultPath = join(scriptsDir, `envconfig.${name.toLowerCase()}.json`);
  const configPath = customPath ? resolve(customPath) : defaultPath;

  if (!existsSync(configPath)) {
    const samplePath = join(scriptsDir, "envconfig.sample.json");
    console.error(`config file not found: ${configPath}`);
    console.error("");
    console.error("Copy the sample to that path and fill in real values:");
    console.error(`  cp ${samplePath} ${configPath}`);
    console.error("");
    console.error("(envconfig.*.json is gitignored — only envconfig.sample.json is committed.)");
    process.exit(1);
  }

  let raw: string;
  try {
    raw = await Bun.file(configPath).text();
  } catch (e) {
    console.error(`failed to read ${configPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`${configPath} is not valid JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  try {
    validate(parsed);
  } catch (e) {
    console.error(`config validation failed: ${(e as Error).message}`);
    process.exit(1);
  }

  let encoded: string;
  try {
    encoded = encode(parsed as EnvConfig);
  } catch (e) {
    console.error("encode failed:", (e as Error).message);
    process.exit(1);
  }

  console.log("\n✅ Encoded.\n");
  console.log("─────────────────────────────────────────────────────────────");
  console.log("Next steps");
  console.log("─────────────────────────────────────────────────────────────\n");
  console.log("1. Add this line to your shell rc (~/.zshrc or ~/.bashrc):\n");
  console.log(`   export ${ENV_VAR}='${encoded}'\n`);
  console.log("2. Reload the shell (`source ~/.zshrc`) or open a new tab.\n");
  console.log("3. First-time push (uploads your local .env + vault folder to the bucket):\n");
  console.log(`   secret-lib push-env ${name}${prefix ? ` --prefix=${prefix}` : ""}\n`);
  console.log("⚠️  The export line contains your S3 credentials and encryption key.");
  console.log("   Store it in 1Password / Bitwarden — never commit it.");
  console.log(`⚠️  ${configPath} is gitignored, but it contains plaintext secrets.`);
  console.log("   Delete it after you've saved the export line, or keep it out of");
  console.log("   backups, cloud sync, and screen-shares.\n");
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
