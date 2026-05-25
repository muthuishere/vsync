#!/usr/bin/env bun
// Usage:
//   vsync init <env> --profile=<name> [flags] [--interactive]
//
// Sets up a new (repo, env) pair locally from a named profile:
//   1. Resolves the profile (flag, TTY picker, or fail with hint).
//   2. Composes the per-(repo, env) prefix = (profile.prefix ?? "") + env + "/"
//      (or prompts for it if the profile has no prefix).
//   3. Generates a fresh AES-256 key.
//   4. Writes the self-contained per-repo file to
//      ~/.config/vsync/<repo>/env_<env> with `initProfile` + `prefix`.
//   5. Saves the key to the OS keychain via Bun.secrets.
//   6. Creates the resolved vault folder (infra/vault/<env>, or whatever
//      --vault-folder set).
//   7. If a root .env.<env> exists and the new vault folder doesn't have
//      one, prompts to mv it.
//   8. Warns if `infra/vault/` (or the vault folder's parent) isn't in
//      .gitignore.
//   9. Prints the dotenv snippet so the consuming app can find the .env.
//
// On existing config: four-way prompt (keep / overwrite / edit / abort),
// with overwrite gated behind a typed 'o' (no bare-Enter shortcut).
// See docs/specs/v0.13-profiles-init-status.md §3.

import { existsSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "../src/argv";
import { wantsHelp, printHelp } from "../src/help";
import { getRepoName, getRepoRoot } from "../src/repo";
import { writeVsyncFile } from "../src/vsyncfile";
import {
  saveConfigFile,
  loadConfigFile,
  configFilePath,
  DEFAULT_AUDIT_ENABLED,
  type ConfigFile,
} from "../src/repoconfig";
import { setKey, generateKey, getKey } from "../src/keychain";
import {
  loadProfile,
  listProfiles,
  profileExists,
  ProfileNotFoundError,
  type Profile,
} from "../src/profiles";
import { askText, askBool, isTty } from "../src/prompt";

const HELP = `
NAME
  vsync init — create a per-(repo, env) config + AES key from a named profile

SYNOPSIS
  vsync init <env> --profile=<name> [flags]

DESCRIPTION
  Sets up a fresh (repo, env) pair on this machine: composes the S3 prefix
  from the named profile, generates a 256-bit AES key, writes the per-repo
  config file to ~/.config/vsync/<repo>/env_<env> (mode 0600), saves the key
  to the OS keychain (service tools.vsync / account <repo>/<env>), and
  creates the vault folder (default infra/vault/<env>). If a root .env.<env>
  exists it offers to move it into the vault folder. Warns when the vault
  folder's parent isn't covered by .gitignore.

  On an already-initialised (repo, env) the command refuses on non-TTY and
  presents a four-way prompt on a TTY (keep / overwrite / edit / abort).

  See docs/specs/v0.13-profiles-init-status.md §3 for the full flow.

FLAGS
  --profile=<name>         named S3-credential profile to bind to this env
                           (create with \`vsync profile add\`)
  --vault-folder=<path>    override the vault folder (default: infra/vault/<env>)
  --audit=on|off           enable / disable audit-log append for this env
                           (default: on)
  --migrate-from=<path>    custom source path for the root-→-vault migration
                           (default: .env.<env>)
  --no-migrate             skip the root .env.<env> migration prompt entirely
  --repo=<name>            override the auto-detected repo name
  --interactive            force interactive prompts (overrides --audit, vault-folder)
  --help, -h               print this help and exit

EXAMPLES
  # Fresh setup from a profile
  vsync init dev --profile=hetzner-personal

  # Custom vault folder + opt out of audit
  vsync init prod --profile=acme-prod --vault-folder=secrets/prod --audit=off

  # Re-prompt with current values as defaults
  vsync init dev --profile=hetzner-personal --interactive

  # Skip the migrate-from-root-env prompt (CI / scripted setup)
  vsync init dev --profile=hetzner-personal --no-migrate

EXIT CODES
  0    success (new config + key written, or kept existing on user 'keep')
  1    invalid input, profile not found, or non-TTY collision

SEE ALSO
  vsync profile add(1)     create a profile before \`vsync init\` can bind to it
  vsync push(1)            seal + upload the freshly created vault to S3
  vsync export(1)          hand off this (repo, env) to a teammate
  docs/specs/v0.13-profiles-init-status.md
`;

function envFromArg(env?: string): string {
  if (!env) {
    console.error("usage: vsync init <env> --profile=<name> [flags]");
    console.error(
      "  e.g. vsync init dev --profile=hetzner-personal",
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

/** Pick a profile interactively on a TTY. Returns null on quit/empty. */
async function pickProfileInteractive(): Promise<string | null> {
  const all = await listProfiles();
  if (all.length === 0) {
    console.error(
      "no profiles configured. Run `vsync profile add <name>` first, " +
        "then `vsync init <env> --profile=<name>`.",
    );
    process.exit(1);
  }
  console.log("Pick a profile:");
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    const ep = p.endpoint.replace(/^https?:\/\//, "");
    console.log(`  ${i + 1}) ${p.name}       ${ep} / ${p.bucket}`);
  }
  console.log("  q) quit");
  console.log("");

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = askText(">", "");
    const t = raw.trim().toLowerCase();
    if (!t || t === "q") return null;
    const n = Number.parseInt(t, 10);
    if (Number.isInteger(n) && n >= 1 && n <= all.length) {
      return all[n - 1].name;
    }
    console.log(`invalid selection "${raw}". Try again (1..${all.length} or q).`);
  }
  console.error("too many invalid attempts.");
  process.exit(1);
}

/** Resolve the chosen profile name from flags or interactive picker. */
async function resolveProfileName(
  flags: Record<string, string>,
): Promise<string> {
  const flagged = flags.profile;
  if (flagged && flagged !== "") {
    if (!(await profileExists(flagged))) {
      const existing = (await listProfiles()).map((p) => p.name);
      console.error(`profile "${flagged}" not found.`);
      if (existing.length > 0) {
        console.error(`Existing: ${existing.join(", ")}.`);
      } else {
        console.error("(no profiles on this machine yet)");
      }
      console.error(`Run \`vsync profile add ${flagged}\` to create.`);
      process.exit(1);
    }
    return flagged;
  }

  if (!isTty()) {
    console.error(
      "missing --profile=<name>. Run `vsync profile list` to see available profiles.",
    );
    process.exit(1);
  }

  const picked = await pickProfileInteractive();
  if (picked === null) {
    process.exit(0);
  }
  return picked;
}

/** Compose the env prefix from a profile.  */
async function resolvePrefix(
  profile: Profile,
  repo: string,
  env: string,
  interactive: boolean,
  existing?: string,
): Promise<string> {
  if (profile.prefix !== undefined) {
    return `${profile.prefix}${env}/`;
  }
  // Profile has no prefix — prompt for the full prefix.
  const suggestion = existing ?? `${repo}/${env}/`;
  if (!isTty()) {
    return suggestion;
  }
  console.log(`\nProfile has no prefix.`);
  let raw = askText(`Full S3 prefix for this env`, suggestion);
  if (!raw) raw = suggestion;
  if (!raw.endsWith("/")) raw += "/";
  return raw;
}

type ExistingConfigChoice = "keep" | "overwrite" | "edit" | "abort";

/**
 * Render existing-config summary and ask the four-way prompt. Decision-only;
 * the caller acts on it.
 */
function promptExistingConfig(
  cfg: ConfigFile,
  repo: string,
  env: string,
  profileStillPresent: boolean,
): ExistingConfigChoice {
  console.log(`\nConfig exists for ${repo} / ${env}:`);
  const profileName = cfg.initProfile ?? "(none recorded)";
  const profileSuffix = cfg.initProfile
    ? profileStillPresent
      ? " [still present]"
      : " [REMOVED]"
    : "";
  console.log(`  profile (at init):  ${profileName}${profileSuffix}`);
  console.log(`  endpoint:           ${cfg.s3.endpoint}`);
  console.log(`  bucket:             ${cfg.s3.bucket}`);
  console.log(`  prefix:             ${cfg.prefix ?? "(implicit)"}`);
  console.log(`  vault folder:       ${cfg.files?.vaultFolder ?? `infra/vault/${env}`}`);
  console.log("");
  console.log("What now?");
  console.log("  [k] keep      — exit, no changes               (default)");
  console.log("  [o] overwrite — re-init this env from scratch");
  console.log("  [e] edit      — re-prompt with current values as defaults");
  console.log("  [a] abort     — exit, no changes (alias of keep)");

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = askText(">", "");
    const t = raw.trim().toLowerCase();
    if (!t || t === "k" || t === "keep") return "keep";
    if (t === "a" || t === "abort") return "abort";
    if (t === "e" || t === "edit") return "edit";
    // Overwrite MUST be typed explicitly — no bare-Enter shortcut.
    if (t === "o" || t === "overwrite") return "overwrite";
    console.log(`invalid choice "${raw}". Try k, o, e, or a.`);
  }
  console.error("too many invalid attempts.");
  process.exit(1);
}

/**
 * Prompt for a four-way choice when the existing config cannot be decrypted
 * (keychain entry is gone). Only overwrite/abort are offered.
 */
function promptCorruptExisting(
  repo: string,
  env: string,
  filePath: string,
): "overwrite" | "abort" {
  console.log(
    `\nConfig exists at ${filePath} but no keychain key for ${repo}/${env}.`,
  );
  console.log("Cannot show current values.");
  console.log("");
  console.log("  [o] overwrite — re-init this env from scratch");
  console.log("  [a] abort     — exit, no changes               (default)");

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = askText(">", "");
    const t = raw.trim().toLowerCase();
    if (!t || t === "a" || t === "abort") return "abort";
    if (t === "o" || t === "overwrite") return "overwrite";
    console.log(`invalid choice "${raw}". Try o or a.`);
  }
  console.error("too many invalid attempts.");
  process.exit(1);
}

export async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) printHelp(HELP);
  const { positional, flags } = parseArgs(argv);
  const env = envFromArg(positional[0]);
  const interactive = flags.interactive === "true";

  const repo = await getRepoName({ override: flags.repo });
  const root = await getRepoRoot();

  const targetConfigPath = configFilePath(repo, env);
  const existingConfigOnDisk = existsSync(targetConfigPath);

  // ─── Existing-config branch ──────────────────────────────────────────
  let editDefaults: ConfigFile | null = null;
  if (existingConfigOnDisk) {
    if (!isTty()) {
      console.error(`✗ Config already exists at:`);
      console.error(`    ${targetConfigPath}`);
      console.error("");
      console.error(
        `config exists for ${repo}/${env}; pass --interactive on a TTY to choose ` +
          `keep/overwrite/edit, or remove ~/.config/vsync/<repo>/env_${env} manually.`,
      );
      process.exit(1);
    }

    // On a TTY — try to decrypt to show the user a summary first.
    let cfgOnDisk: ConfigFile | null = null;
    try {
      cfgOnDisk = await loadConfigFile(repo, env);
    } catch {
      cfgOnDisk = null;
    }
    const keyPresent = (await getKey(repo, env)) !== null;

    if (!cfgOnDisk || !keyPresent) {
      const choice = promptCorruptExisting(repo, env, targetConfigPath);
      if (choice === "abort") {
        return;
      }
      // overwrite: fall through to the normal flow.
    } else {
      // We have full visibility — show summary + 4-way.
      const profileStillPresent =
        cfgOnDisk.initProfile === undefined
          ? false
          : await profileExists(cfgOnDisk.initProfile);
      const choice = promptExistingConfig(cfgOnDisk, repo, env, profileStillPresent);
      if (choice === "keep" || choice === "abort") {
        console.log("no changes.");
        return;
      }
      if (choice === "edit") {
        editDefaults = cfgOnDisk;
      }
      // overwrite & edit: fall through.
    }
  }

  // ─── Profile resolution ──────────────────────────────────────────────
  // For edit mode, default the picker to the recorded profile.
  let profileName: string;
  if (editDefaults && !flags.profile) {
    flags.profile = editDefaults.initProfile ?? "";
  }
  if (editDefaults && flags.profile && !(await profileExists(flags.profile))) {
    // The recorded profile was removed since init — fall back to a fresh pick.
    delete flags.profile;
  }
  profileName = await resolveProfileName(flags);

  let profile: Profile;
  try {
    profile = await loadProfile(profileName);
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  console.log(`\nSetting up ${repo} / ${env} with profile "${profileName}"\n`);

  // ─── Prefix combination ─────────────────────────────────────────────
  const existingPrefix = editDefaults?.prefix;
  const prefix = await resolvePrefix(
    profile,
    repo,
    env,
    interactive,
    existingPrefix,
  );

  // ─── useSsl derivation ──────────────────────────────────────────────
  // Endpoint scheme is the source of truth (decision: useSsl removed from profile).
  const useSsl = !profile.endpoint.toLowerCase().startsWith("http://");

  // ─── Audit + vault-folder ───────────────────────────────────────────
  const vaultFolderOverride = flags["vault-folder"];
  const defaultVaultFolder =
    editDefaults?.files?.vaultFolder ?? `infra/vault/${env}`;
  let vaultFolder = vaultFolderOverride ?? defaultVaultFolder;
  if (interactive && isTty()) {
    vaultFolder = askText("Vault folder", vaultFolder);
  }
  const hasVaultOverride =
    !!vaultFolder && vaultFolder !== `infra/vault/${env}`;

  const auditFlag = flags.audit;
  let auditEnabled: boolean;
  if (auditFlag !== undefined && !interactive) {
    auditEnabled = parseOnOff(auditFlag, "--audit");
  } else if (isTty() && (interactive || auditFlag === undefined)) {
    const prefilled =
      auditFlag !== undefined
        ? parseOnOff(auditFlag, "--audit")
        : (editDefaults?.audit?.enabled ?? DEFAULT_AUDIT_ENABLED);
    auditEnabled = askBool("Enable audit log?", prefilled);
  } else {
    auditEnabled =
      auditFlag !== undefined
        ? parseOnOff(auditFlag, "--audit")
        : (editDefaults?.audit?.enabled ?? DEFAULT_AUDIT_ENABLED);
  }

  const cfg: ConfigFile = {
    version: 1,
    s3: {
      endpoint: profile.endpoint,
      region: profile.region,
      bucket: profile.bucket,
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey,
      useSsl,
    },
    encryption: { salt: randomSalt() },
    ...(hasVaultOverride ? { files: { vaultFolder } } : {}),
    audit: { enabled: auditEnabled },
    initProfile: profileName,
    prefix,
  };

  const filePath = await saveConfigFile(repo, env, cfg);
  const key = generateKey();
  await setKey(repo, env, key);

  // Write / verify the committed `.vsync` identity pin (v0.16).
  // No-op if it already exists and matches; throws VsyncFileClobberError if
  // an existing pin's `repo=` differs (caught at bin/vsync.ts and rendered
  // cleanly). The resolver already validated this on the way in, so a write
  // here is either the first write or a no-op.
  const vsyncWrite = writeVsyncFile(root, repo);

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
  console.log(`  profile:     ${profileName}`);
  console.log(`  prefix:      ${prefix}`);
  console.log(`  vault:       ${absVault}`);
  if (vsyncWrite.written) {
    console.log(
      `  .vsync:      ${root}/.vsync (identity pin — please commit)`,
    );
  }
  console.log("");
  console.log("In your app, point dotenv (or equivalent) at the vault:");
  console.log(`  dotenv.config({ path: \`${vaultFolder}/.env.\${env}\` });\n`);
  console.log("Next steps:");
  let step = 1;
  if (vsyncWrite.written) {
    console.log(`  ${step}. Commit the identity pin so teammates resolve to the same repo:`);
    console.log(`        git add .vsync && git commit -m "vsync: add identity pin"`);
    step++;
  }
  console.log(`  ${step}. Put your secrets into ${vaultFolder}/.env.${env} (and any vault files alongside).`);
  step++;
  console.log(`  ${step}. Push to S3:`);
  console.log(`        vsync push ${env}`);
  step++;
  console.log(`  ${step}. Share with a teammate (one file + one passphrase, sent on different channels):`);
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
