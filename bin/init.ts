#!/usr/bin/env bun
// Usage:
//   vsync init <env> [flags] [--interactive]
//
// Sets up a new (repo, env) pair locally:
//   1. Collects S3 bucket creds (via flags, prompts, or both — pre-fills
//      from ~/.config/vsync/defaults if a previous init wrote it).
//   2. Generates a fresh AES-256 key.
//   3. Writes the self-contained per-repo file to
//      ~/.config/vsync/<repo>/env_<env>.
//   4. Saves the key to the OS keychain via Bun.secrets.
//   5. On first-ever init: writes ~/.config/vsync/defaults from the
//      supplied values so later inits are zero-prompt.
//   6. Creates the resolved vault folder
//      (infra/vault/<env>, or whatever --vault-folder set).
//   7. If a root .env.<env> exists and the new vault folder doesn't have
//      one, prompts to mv it.
//   8. Warns if `infra/vault/` (or the vault folder's parent) isn't in
//      .gitignore.
//   9. Prints the dotenv snippet so the consuming app can find the .env.
//
// Flags (any can be passed to skip its prompt):
//   --repo=<name>            Override auto-detected repo name
//   --bucket=<name>          S3 bucket
//   --endpoint=<url>         S3 endpoint
//   --region=<name>          S3 region
//   --access-key=<id>        S3 access key ID
//   --secret-key=<secret>    S3 secret access key
//   --use-ssl=<true|false>   Force TLS (default true)
//   --vault-folder=<path>    Override default infra/vault/<env> for monorepos
//   --migrate-from=<path>    Use a non-default source for the .env relocation
//   --no-migrate             Skip the root .env.<env> migration prompt entirely
//   --audit=on|off           Enable/disable the per-(repo, env) audit log
//                            (default on; prompted interactively when unset)
//   --interactive            Prompt even for fields already provided via flags

import { existsSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "../src/argv";
import { getRepoName, getRepoRoot } from "../src/repo";
import {
  saveConfigFile,
  configFilePath,
  DEFAULT_AUDIT_ENABLED,
  type ConfigFile,
} from "../src/repoconfig";
import { setKey, generateKey } from "../src/keychain";
import {
  loadDefaults,
  saveDefaults,
  defaultsFilePath,
  type Defaults,
} from "../src/defaults";
import { askText, askBool, isTty } from "../src/prompt";

function envFromArg(env?: string): string {
  if (!env) {
    console.error("usage: vsync init <env> [flags]");
    console.error(
      "  e.g. vsync init dev --bucket=my-bucket --endpoint=https://s3.example.com",
    );
    process.exit(1);
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(env)) {
    console.error(
      `env must be lowercase letters/digits/underscore/hyphen (got "${env}")`,
    );
    process.exit(1);
  }
  return env;
}

function randomSalt(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

function parseOnOff(raw: string, label: string): boolean {
  const v = raw.toLowerCase();
  if (v === "on" || v === "true" || v === "yes" || v === "1") return true;
  if (v === "off" || v === "false" || v === "no" || v === "0") return false;
  console.error(`${label} must be "on" or "off" (got "${raw}")`);
  process.exit(1);
}

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = envFromArg(positional[0]);
  const interactive = flags.interactive === "true";

  const repo = await getRepoName({ override: flags.repo });
  const root = await getRepoRoot();

  const existingDefaults = await loadDefaults();
  const defaultS3 = existingDefaults?.s3 ?? {};

  // (flag value | prompt with default | hard default)
  const get = (
    flagKey: string,
    label: string,
    fallback?: string,
  ): string => {
    const v = flags[flagKey];
    if (v !== undefined && v !== "" && !interactive) return v;
    const prefilled = v ?? fallback;
    if (!isTty()) {
      if (prefilled !== undefined && prefilled !== "") return prefilled;
      throw new Error(
        `missing ${label} (no TTY for prompts — pass --${flagKey}=…)`,
      );
    }
    return askText(label, prefilled);
  };

  console.log(`Setting up ${repo} / ${env}\n`);
  console.log(`Repo: ${repo}   (override with --repo=<name>)`);
  console.log(`Env:  ${env}`);
  if (existingDefaults) {
    console.log(`Defaults: ~/.config/vsync/defaults (pre-filling prompts)\n`);
  } else {
    console.log("Press Ctrl-C to abort. Defaults shown in [brackets].\n");
  }

  const endpoint = get("endpoint", "S3 endpoint URL", defaultS3.endpoint);
  const region = get("region", "S3 region", defaultS3.region);
  const bucket = get("bucket", "S3 bucket name", defaultS3.bucket);
  const accessKeyId = get("access-key", "S3 access key ID", defaultS3.accessKeyId);
  const secretAccessKey = get(
    "secret-key",
    "S3 secret access key",
    defaultS3.secretAccessKey,
  );
  const useSslRaw = flags["use-ssl"];
  const useSsl =
    useSslRaw !== undefined && !interactive
      ? useSslRaw !== "false"
      : isTty()
        ? askBool("Use TLS for S3?", useSslRaw !== "false" && (defaultS3.useSsl ?? true))
        : defaultS3.useSsl ?? true;

  const vaultFolderOverride = flags["vault-folder"];
  const defaultVaultFolder = `infra/vault/${env}`;
  const vaultFolder = vaultFolderOverride ?? defaultVaultFolder;
  const hasVaultOverride = !!vaultFolderOverride && vaultFolderOverride !== defaultVaultFolder;

  // --audit=on|off — explicit flag wins; otherwise prompt when interactive
  // (or no flag and TTY); otherwise default to enabled.
  const auditFlag = flags.audit;
  let auditEnabled: boolean;
  if (auditFlag !== undefined && !interactive) {
    auditEnabled = parseOnOff(auditFlag, "--audit");
  } else if (isTty() && (interactive || auditFlag === undefined)) {
    const prefilled =
      auditFlag !== undefined ? parseOnOff(auditFlag, "--audit") : DEFAULT_AUDIT_ENABLED;
    auditEnabled = askBool("Enable audit log?", prefilled);
  } else {
    auditEnabled = auditFlag !== undefined ? parseOnOff(auditFlag, "--audit") : DEFAULT_AUDIT_ENABLED;
  }

  const cfg: ConfigFile = {
    version: 1,
    s3: { endpoint, region, bucket, accessKeyId, secretAccessKey, useSsl },
    encryption: { salt: randomSalt() },
    ...(hasVaultOverride ? { files: { vaultFolder } } : {}),
    audit: { enabled: auditEnabled },
  };

  const filePath = await saveConfigFile(repo, env, cfg);
  const key = generateKey();
  await setKey(repo, env, key);

  // First-ever init writes defaults so subsequent inits pre-fill.
  if (!existingDefaults) {
    const defaults: Defaults = {
      version: 1,
      s3: { endpoint, region, bucket, accessKeyId, secretAccessKey, useSsl },
    };
    await saveDefaults(defaults);
    console.log(`  defaults: wrote ${defaultsFilePath()}`);
  }

  // Ensure the vault folder exists.
  const absVault = join(root, vaultFolder);
  mkdirSync(absVault, { recursive: true });

  // Migrate any pre-existing root .env.<env> into the vault folder.
  await maybeMigrate(root, env, vaultFolder, flags);

  // Warn if the vault folder's parent isn't in .gitignore.
  warnIfNotGitignored(root, vaultFolder);

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("✅ Setup complete");
  console.log("─────────────────────────────────────────────────────────────\n");
  console.log(`  config file: ${filePath} (0600)`);
  console.log(
    `  key:         OS keychain (service=tools.vsync, account=${repo}/${env})`,
  );
  console.log(`  vault:       ${absVault}\n`);
  console.log("In your app, point dotenv (or equivalent) at the vault:");
  console.log(`  dotenv.config({ path: \`${vaultFolder}/.env.\${env}\` });\n`);
  console.log("Next steps:");
  console.log(`  1. Put your secrets into ${vaultFolder}/.env.${env} (and any vault files alongside).`);
  console.log(`  2. Push to S3:`);
  console.log(`        vsync push ${env}`);
  console.log(`  3. Share with a teammate (one file + one passphrase, sent on different channels):`);
  console.log(`        vsync export ${env}`);
  console.log(`     They'll run:`);
  console.log(`        vsync import ${env} <share-file>`);
}

async function maybeMigrate(
  root: string,
  env: string,
  vaultFolder: string,
  flags: Record<string, string>,
): Promise<void> {
  if (flags["no-migrate"] === "true") return;

  const sourceRel =
    flags["migrate-from"] && flags["migrate-from"] !== ""
      ? flags["migrate-from"]
      : `.env.${env}`;
  const sourceAbs = join(root, sourceRel);
  const targetAbs = join(root, vaultFolder, `.env.${env}`);

  if (!existsSync(sourceAbs)) return;
  if (existsSync(targetAbs)) {
    console.log(
      `  migrate: ${sourceRel} exists but ${vaultFolder}/.env.${env} also exists — leaving both alone.`,
    );
    return;
  }

  let approved: boolean;
  if (!isTty()) {
    // Non-interactive without --no-migrate → don't silently move user data.
    console.log(
      `  migrate: found ${sourceRel} but no TTY for confirmation; leaving in place. Pass --migrate-from=${sourceRel} interactively or move it manually.`,
    );
    return;
  } else {
    approved = askBool(`Move existing ${sourceRel} to ${vaultFolder}/.env.${env}?`, true);
  }

  if (approved) {
    renameSync(sourceAbs, targetAbs);
    console.log(`  migrate: moved ${sourceRel} → ${vaultFolder}/.env.${env}`);
  } else {
    console.log(
      `  migrate: left ${sourceRel} in place — vsync push will not include it. Move it manually when ready.`,
    );
  }
}

function warnIfNotGitignored(root: string, vaultFolder: string): void {
  const gitignorePath = join(root, ".gitignore");
  if (!existsSync(gitignorePath)) {
    console.log(
      `\n⚠  .gitignore not found at repo root. Add ${dirname(vaultFolder)}/ to keep secrets out of git.`,
    );
    return;
  }
  const content = readFileSync(gitignorePath, "utf8");
  const parent = dirname(vaultFolder);
  const candidates = [
    parent,
    `${parent}/`,
    vaultFolder,
    `${vaultFolder}/`,
  ];
  const covered = candidates.some((c) =>
    content.split(/\r?\n/).some((line) => line.trim() === c),
  );
  if (!covered) {
    console.log(
      `\n⚠  ${parent}/ is not in .gitignore. Add it before committing — secrets in ${vaultFolder} would otherwise be tracked.`,
    );
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
