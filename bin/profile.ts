#!/usr/bin/env bun
// vsync profile — manage named S3-credential profiles.
//
// Usage:
//   vsync profile list
//   vsync profile show <name> [--reveal-secret]
//   vsync profile add <name>
//   vsync profile remove <name> [--yes]
//
// A profile is the named bag of S3 creds that `vsync init` binds to a
// (repo, env). See docs/specs/v0.13-profiles-init-status.md §1-2.

import { parseArgs } from "../src/argv";
import { wantsHelp, printHelp } from "../src/help";
import {
  loadProfile,
  saveProfile,
  listProfiles,
  removeProfile,
  profilePath,
  getProfilesDir,
  isValidProfileName,
  ProfileNotFoundError,
  ProfileAlreadyExistsError,
  type Profile,
  type NamedProfile,
} from "../src/profiles";
import { askText, askSecret, askBool, isTty } from "../src/prompt";

/** Mask access key — show first 4 + last 4, mask the middle. */
export function maskAccessKey(s: string): string {
  if (!s) return "";
  if (s.length <= 4) return "*".repeat(s.length);
  if (s.length <= 8) return s.slice(0, 0).padEnd(s.length - 4, "*") + s.slice(-4);
  const head = s.slice(0, 4);
  const tail = s.slice(-4);
  const masked = "*".repeat(Math.max(1, s.length - 8));
  return `${head}${masked}${tail}`;
}

/** Render the `profile list` output as a single string. */
export function renderProfileList(
  profiles: NamedProfile[],
  dir: string,
): string {
  if (profiles.length === 0) {
    return `no profiles yet — run \`vsync profile add <name>\` to create one.\n(profiles dir: ${dir})`;
  }
  const rows = profiles.map((p) => ({
    name: p.name,
    endpoint: p.endpoint.replace(/^https?:\/\//, ""),
    bucket: p.bucket,
  }));
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    endpoint: Math.max(8, ...rows.map((r) => r.endpoint.length)),
    bucket: Math.max(6, ...rows.map((r) => r.bucket.length)),
  };
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const lines: string[] = [];
  lines.push(
    `${pad("name", widths.name)}  ${pad("endpoint", widths.endpoint)}  ${pad("bucket", widths.bucket)}`,
  );
  for (const r of rows) {
    lines.push(
      `${pad(r.name, widths.name)}  ${pad(r.endpoint, widths.endpoint)}  ${pad(r.bucket, widths.bucket)}`,
    );
  }
  lines.push("");
  const plural = profiles.length === 1 ? "profile" : "profiles";
  lines.push(`${profiles.length} ${plural} at ${dir}/`);
  return lines.join("\n");
}

export type RenderProfileShowOptions = {
  revealSecret?: boolean;
};

/** Render the `profile show <name>` output as a single string. */
export function renderProfileShow(
  name: string,
  p: Profile,
  filePath: string,
  opts: RenderProfileShowOptions = {},
): string {
  const lines: string[] = [];
  const reveal = opts.revealSecret === true;
  const secret = reveal ? p.secretAccessKey : "****";
  const access = maskAccessKey(p.accessKeyId);
  lines.push(`profile:           ${name}`);
  lines.push(`path:              ${filePath} (0600)`);
  lines.push(`endpoint:          ${p.endpoint}`);
  lines.push(`region:            ${p.region}`);
  lines.push(`bucket:            ${p.bucket}`);
  lines.push(`prefix:            ${p.prefix ?? "(none)"}`);
  lines.push(`accessKeyId:       ${access}`);
  lines.push(`secretAccessKey:   ${secret}`);
  return lines.join("\n");
}

function usage(toErr = false): void {
  const out = toErr ? console.error : console.log;
  out("usage: vsync profile <list|show|add|remove> [args]");
  out("");
  out("  list                          list profiles (name, endpoint, bucket)");
  out("  show <name> [--reveal-secret] show profile (secret masked unless --reveal-secret)");
  out("  add  <name>                   interactively create a new profile");
  out("  remove <name> [--yes]         delete a profile (refuses without confirm)");
}

async function listExistingNames(): Promise<string> {
  const all = await listProfiles();
  if (all.length === 0) return "(none)";
  return all.map((p) => p.name).join(", ");
}

async function cmdList(): Promise<void> {
  const all = await listProfiles();
  console.log(renderProfileList(all, getProfilesDir()));
}

async function cmdShow(
  name: string | undefined,
  reveal: boolean,
): Promise<void> {
  if (!name) {
    console.error("usage: vsync profile show <name> [--reveal-secret]");
    process.exit(1);
  }
  if (!isValidProfileName(name)) {
    console.error(`invalid profile name: "${name}"`);
    process.exit(1);
  }

  let p: Profile;
  try {
    p = await loadProfile(name);
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      const names = await listExistingNames();
      console.error(`profile "${name}" not found.`);
      console.error(`existing: ${names}`);
      console.error(`profiles dir: ${getProfilesDir()}`);
      process.exit(1);
    }
    throw err;
  }

  if (reveal) {
    if (!isTty()) {
      console.error(
        "--reveal-secret refuses to print plaintext outside an interactive session.",
      );
      console.error(
        "If you need the secret in a script, read the file directly (it's already 0600).",
      );
      process.exit(1);
    }
    console.log(
      "\n⚠  --reveal-secret will print the secret access key in cleartext on this",
    );
    console.log(
      "   terminal. Anyone who can see this output (screen-share, scrollback,",
    );
    console.log(
      "   tmux logging, terminal multiplexer history) can exfiltrate the key.\n",
    );
    const ok = askBool(
      "Are you sure? This will print your secret key.",
      false,
    );
    if (!ok) {
      console.log("aborted.");
      return;
    }
    console.log("");
  }

  console.log(renderProfileShow(name, p, profilePath(name), { revealSecret: reveal }));
}

async function cmdAdd(name: string | undefined): Promise<void> {
  if (!name) {
    console.error("usage: vsync profile add <name>");
    process.exit(1);
  }
  if (!isValidProfileName(name)) {
    console.error(`invalid profile name: "${name}"`);
    console.error("allowed: letters, digits, '.', '_', '-' (max 64 chars).");
    process.exit(1);
  }
  if (!isTty()) {
    console.error(
      "vsync profile add requires a TTY (no flag-driven creation in v0.13).",
    );
    console.error(
      "In CI, write the JSON file directly at ~/.config/vsync/profiles/<name>.json (mode 0600).",
    );
    process.exit(1);
  }
  // Up-front collision check so we don't waste prompts on a doomed run.
  try {
    await loadProfile(name);
    // Loaded successfully → exists.
    console.error(`profile "${name}" already exists.`);
    console.error(
      `recovery: vsync profile remove ${name} && vsync profile add ${name}`,
    );
    process.exit(1);
  } catch (err) {
    if (!(err instanceof ProfileNotFoundError)) throw err;
  }

  console.log(`Creating profile "${name}". Defaults shown in [brackets].\n`);
  const endpoint = askText("S3 endpoint URL");
  const region = askText("S3 region", "auto");
  const bucket = askText("S3 bucket name");
  const accessKeyId = askText("S3 access key ID");
  const secretAccessKey = await askSecret("S3 secret access key");
  const prefixRaw = askText(
    "Optional prefix (e.g. video-ai/, leave empty to skip)",
    "",
  );
  const prefix =
    prefixRaw && !prefixRaw.endsWith("/") ? prefixRaw + "/" : prefixRaw;

  const profile: Profile = {
    version: 1,
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(prefix ? { prefix } : {}),
  };

  try {
    const file = await saveProfile(name, profile);
    console.log(`\n✓ Wrote ${file} (0600)\n`);
    console.log("Next step:");
    console.log(`  vsync init <env> --profile=${name}`);
  } catch (err) {
    if (err instanceof ProfileAlreadyExistsError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function cmdRemove(
  name: string | undefined,
  yes: boolean,
): Promise<void> {
  if (!name) {
    console.error("usage: vsync profile remove <name> [--yes]");
    process.exit(1);
  }
  if (!isValidProfileName(name)) {
    console.error(`invalid profile name: "${name}"`);
    process.exit(1);
  }
  let approved = yes;
  if (!approved) {
    if (!isTty()) {
      console.error(
        `vsync profile remove ${name} requires interactive confirmation. Pass --yes to bypass.`,
      );
      process.exit(1);
    }
    approved = askBool(`remove profile ${name}?`, false);
  }
  if (!approved) {
    console.log("aborted.");
    return;
  }
  try {
    await removeProfile(name);
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      console.error(`profile "${name}" not found.`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`✓ Removed ${profilePath(name)}`);
  console.log("");
  console.log(
    "⚠  Any env configs that reference this profile keep working (they",
  );
  console.log(
    "   carry their own creds), but future `vsync init --profile=" +
      name +
      "` will fail.",
  );
}

const HELP = `
NAME
  vsync profile — manage named S3-credential profiles

SYNOPSIS
  vsync profile list
  vsync profile show <name> [--reveal-secret]
  vsync profile add  <name>
  vsync profile remove <name> [--yes]

DESCRIPTION
  A profile is a named bag of S3 credentials (endpoint, region, bucket,
  access key, secret key, optional prefix) stored at
  ~/.config/vsync/profiles/<name>.json (mode 0600). \`vsync init\` binds a
  (repo, env) pair to one profile at setup time and copies the creds into
  the per-(repo, env) config, so removing a profile later does NOT break
  envs that already reference it — but future inits with that profile name
  will fail.

  See docs/specs/v0.13-profiles-init-status.md §1-2.

  Verbs:
    list                   table of name / endpoint / bucket
    show <name>            full record (secret masked unless --reveal-secret)
    add  <name>            interactive create (refuses on non-TTY by design)
    remove <name>          delete the profile (refuses without --yes or prompt)

FLAGS
  --reveal-secret          (show) print the secret access key in cleartext
                           on a TTY only, after a confirmation prompt
  --yes                    (remove) skip the confirmation prompt
  --help, -h               print this help and exit

EXAMPLES
  # See what profiles exist
  vsync profile list

  # Inspect one (secret masked)
  vsync profile show hetzner-personal

  # Inspect with secret revealed (TTY-only, gated by confirm)
  vsync profile show hetzner-personal --reveal-secret

  # Create a profile interactively
  vsync profile add acme-prod

  # Remove with confirmation prompt
  vsync profile remove old-personal

  # Remove without prompting (scripts / CI)
  vsync profile remove old-personal --yes

EXIT CODES
  0    success
  1    missing / invalid name, missing TTY where required, or profile collision

SEE ALSO
  vsync init(1)            bind a (repo, env) to one of these profiles
  vsync status(1)          spot envs whose profile has since been removed
  docs/specs/v0.13-profiles-init-status.md
`;

export async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) printHelp(HELP);
  const { positional, flags } = parseArgs(argv);
  const verb = positional[0];

  if (!verb) {
    usage(true);
    process.exit(1);
  }

  const revealSecret = flags["reveal-secret"] === "true";
  const yes = flags.yes === "true";

  switch (verb) {
    case "list":
      await cmdList();
      return;
    case "show":
      await cmdShow(positional[1], revealSecret);
      return;
    case "add":
      await cmdAdd(positional[1]);
      return;
    case "remove":
    case "rm":
      await cmdRemove(positional[1], yes);
      return;
    default:
      console.error(`unknown profile subcommand: ${verb}`);
      usage(true);
      process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
