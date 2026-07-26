#!/usr/bin/env bun
// Usage:
//   vsync keystore list
//   vsync keystore export [--out=<path>] [--repo=<name>]... [--env=<name>]... [--all]
//   vsync keystore import <file> [--passphrase=<pp>] [--force]
//
// Machine-level view of every (repo, env) this machine knows, plus the
// ability to seal a chosen subset into one `.keytree` file and restore it
// on another machine in a single step.
//
// This is the "reproduce my dev environment" path. `vsync import` restores
// ONE env from a `.share`; this restores a whole selected tree at once, so
// a new laptop doesn't need N share files and N passphrases.
//
// Enumeration note: `Bun.secrets` has get/set/delete but no list, so the
// config tree is the index — see repoconfig.listAllPairs().

import { parseArgs } from "../src/argv";
import { wantsHelp, printHelp } from "../src/help";
import {
  listAllPairs,
  loadConfigFile,
  saveConfigFile,
  configFilePath,
} from "../src/repoconfig";
import { listProfiles, saveProfile, profileExists } from "../src/profiles";
import { getKey, setKey } from "../src/keychain";
import {
  buildKeytreeFile,
  parseKeytreeFile,
  KEYTREE_VERSION,
  type KeytreeEntry,
} from "../src/keytree";
import { generatePassphrase, PASSPHRASE_MIN_LEN } from "../src/passphrase";
import { askSecret, isTty } from "../src/prompt";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const HELP = `
NAME
  vsync keystore — machine-level view of every (repo, env), and bulk
                   export/import of their keys

SYNOPSIS
  vsync keystore list
  vsync keystore export [--out=<path>] [--repo=<name>]... [--env=<name>]... [--all]
  vsync keystore import <file> [--passphrase=<pp>] [--force]

DESCRIPTION
  'list' shows every (repo, env) pair configured on this machine and
  whether the OS keychain still holds its key. A config without a key (or
  the reverse) is an orphan and is flagged.

  'export' seals a CHOSEN SUBSET of those pairs — configs plus keys — into
  a single passphrase-encrypted .keytree file. Select with repeatable
  --repo / --env filters, or take everything with --all. There is no
  implicit "export everything": one keytree can hold every secret on the
  machine, so the selection must be deliberate.

  'import' restores a .keytree on another machine in one step: every
  (repo, env) in the file gets its config written and its key put into the
  OS keychain. Existing pairs are skipped unless --force is passed.

  The passphrase is auto-generated on export and printed once. Send the
  file and the passphrase on DIFFERENT channels — same rule as .share.

FLAGS
  --all                    export every pair on this machine
  --repo=<name>            restrict to this repo (repeatable)
  --env=<name>             restrict to this env (repeatable)
  --out=<path>             output path (default: ./<hostname>.keytree)
  --passphrase=<pp>        supply the passphrase instead of prompting
  --force                  on import, overwrite pairs that already exist
  --help, -h               print this help and exit

EXAMPLES
  # What does this machine know?
  vsync keystore list

  # Everything, for a new laptop
  vsync keystore export --all --out=~/laptop.keytree

  # Just two repos' dev envs, to hand to a contractor
  vsync keystore export --repo=acme_web --repo=acme_api --env=dev

  # Restore on the new machine
  vsync keystore import ~/laptop.keytree

EXIT CODES
  0    listing printed / keytree written / keytree imported
  1    bad selection, no matching pairs, missing key, or decrypt failure

SEE ALSO
  vsync export(1)          single-env .share for onboarding one teammate
  vsync status(1)          per-repo view of the same underlying state
`;

export async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) printHelp(HELP);
  const { positional, flags, lists } = parseArgs(argv);
  const verb = positional[0] ?? "list";

  switch (verb) {
    case "list":
      return await cmdList();
    case "export":
      return await cmdExport(flags, lists);
    case "import":
      return await cmdImport(positional[1], flags);
    default:
      console.error(
        `unknown subcommand '${verb}'. Expected: list, export, import.\n` +
          `Run 'vsync keystore --help' for usage.`,
      );
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------

async function cmdList(): Promise<void> {
  const pairs = await listAllPairs();
  if (pairs.length === 0) {
    console.log("no (repo, env) pairs configured on this machine.");
    console.log("Run 'vsync init <env>' in a repo to create one.");
    return;
  }

  let orphans = 0;
  let currentRepo = "";
  for (const { repo, env } of pairs) {
    if (repo !== currentRepo) {
      console.log(`\n${repo}`);
      currentRepo = repo;
    }
    const key = await getKey(repo, env);
    const mark = key ? "key" : "NO KEY";
    if (!key) orphans++;
    console.log(`  ${env.padEnd(16)} ${mark}`);
  }

  console.log(`\n${pairs.length} pair(s) across ${countRepos(pairs)} repo(s).`);
  if (orphans > 0) {
    console.log(
      `${orphans} pair(s) have a config but no key in the OS keychain — ` +
        `they cannot pull. Re-run 'vsync import <env> <share-file>' for those.`,
    );
  }
}

function countRepos(pairs: Array<{ repo: string }>): number {
  return new Set(pairs.map((p) => p.repo)).size;
}

// ---------------------------------------------------------------------------

async function cmdExport(
  flags: Record<string, string>,
  lists: Record<string, string[]>,
): Promise<void> {
  const all = flags.all === "true";
  const repoFilter = collectFilter(lists.repo, flags.repo);
  const envFilter = collectFilter(lists.env, flags.env);

  if (!all && repoFilter.length === 0 && envFilter.length === 0) {
    console.error(
      "refusing to export without a selection.\n" +
        "  A keytree can hold every secret on this machine, so the selection must be explicit.\n" +
        "  Use --all to take everything, or narrow with --repo=<name> / --env=<name> (both repeatable).\n" +
        "  Run 'vsync keystore list' to see what's available.",
    );
    process.exit(1);
  }

  const pairs = (await listAllPairs()).filter(
    (p) =>
      (repoFilter.length === 0 || repoFilter.includes(p.repo)) &&
      (envFilter.length === 0 || envFilter.includes(p.env)),
  );

  if (pairs.length === 0) {
    // Distinguish "you filtered everything out" from "there is nothing here" —
    // with --all the user made no selection to get wrong.
    console.error(
      all
        ? "this machine has no (repo, env) pairs to export.\n" +
            "  Run 'vsync init <env>' in a repo first."
        : "no (repo, env) pairs matched that selection.\n" +
            "  Run 'vsync keystore list' to see what this machine knows.",
    );
    process.exit(1);
  }

  // Profiles come along whenever the selection is `--all`, or when asked for
  // explicitly. Without them a restored machine has configs and keys but
  // cannot run `vsync init` for a NEW env, since init requires --profile.
  const wantProfiles = all || flags.profiles === "true";
  const profiles = wantProfiles ? await listProfiles() : [];

  const entries: KeytreeEntry[] = [];
  const skipped: string[] = [];
  for (const { repo, env } of pairs) {
    const cfg = await loadConfigFile(repo, env);
    if (!cfg) {
      skipped.push(`${repo}/${env} (config unreadable at ${configFilePath(repo, env)})`);
      continue;
    }
    const key = await getKey(repo, env);
    if (!key) {
      skipped.push(`${repo}/${env} (no key in OS keychain)`);
      continue;
    }
    entries.push({ repo, env, config: cfg, key });
  }

  for (const s of skipped) console.error(`warning: skipping ${s}`);

  if (entries.length === 0 && profiles.length === 0) {
    console.error("nothing exportable — every matched pair was skipped above.");
    process.exit(1);
  }

  const passphrase = flags.passphrase || generatePassphrase();
  const out = resolve(flags.out ?? `./${safeHostname()}.keytree`);

  const bytes = await buildKeytreeFile(
    {
      version: KEYTREE_VERSION,
      exportedAt: new Date().toISOString(),
      entries,
      profiles,
    },
    passphrase,
  );
  await writeFile(out, bytes, { mode: 0o600 });

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("✅ Keytree written");
  console.log("─────────────────────────────────────────────────────────────\n");
  console.log(`  file:        ${out}`);
  console.log(`  passphrase:  ${passphrase}`);
  console.log(
    `  contains:    ${entries.length} pair(s), ${profiles.length} profile(s)\n`,
  );
  for (const e of entries) console.log(`    ${e.repo}/${e.env}`);
  for (const p of profiles) console.log(`    profile: ${p.name}`);
  console.log(
    "\nSend the file and the passphrase on TWO different channels.\n" +
      "This file contains real keys — treat it like the secrets themselves.\n",
  );
  console.log("On the other machine:");
  console.log(`  vsync keystore import ${out.split("/").pop()}`);
}

function collectFilter(list: string[] | undefined, single: string | undefined): string[] {
  const out = [...(list ?? [])];
  if (single && single !== "true") out.push(single);
  return out;
}

function safeHostname(): string {
  const h = process.env.HOSTNAME || process.env.HOST || "vsync";
  return h.replace(/[^A-Za-z0-9._-]/g, "-");
}

// ---------------------------------------------------------------------------

async function cmdImport(
  file: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  if (!file) {
    console.error("usage: vsync keystore import <file> [--passphrase=<pp>] [--force]");
    process.exit(1);
  }
  const absPath = resolve(file);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(absPath));
  } catch (e) {
    console.error(`cannot read ${absPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  let passphrase = flags.passphrase;
  if (!passphrase) {
    if (!isTty()) {
      console.error(
        "passphrase required and stdin is not a TTY — pass --passphrase=… " +
          "(not recommended; ends up in shell history).",
      );
      process.exit(1);
    }
    passphrase = await askSecret("Keytree passphrase");
  }
  if (!passphrase || passphrase.length < PASSPHRASE_MIN_LEN) {
    console.error(`passphrase is empty or shorter than ${PASSPHRASE_MIN_LEN} characters — refusing.`);
    process.exit(1);
  }

  let payload;
  try {
    payload = await parseKeytreeFile(bytes, passphrase);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const force = flags.force === "true";
  let written = 0;
  let profilesWritten = 0;
  const skipped: string[] = [];

  // Profiles first: a restored (repo, env) config references a profile by
  // name (`initProfile`), and `vsync init` for any NEW env needs one to
  // exist. Restoring them in the other order leaves a window where the
  // configs point at profiles that aren't there yet.
  for (const p of payload.profiles ?? []) {
    const { name, ...profile } = p;
    if ((await profileExists(name)) && !force) {
      skipped.push(`profile:${name}`);
      continue;
    }
    await saveProfile(name, profile);
    profilesWritten++;
    console.log(`  restored profile ${name}`);
  }

  // parseKeytreeFile has already validated every entry and profile, so a
  // malformed file was rejected before we wrote anything. A throw here means
  // a genuine I/O failure (disk full, keychain locked, permissions) partway
  // through — which cannot be prevented, only reported precisely, because
  // the machine is now half-restored.
  for (const entry of payload.entries) {
    const existing = await loadConfigFile(entry.repo, entry.env);
    if (existing && !force) {
      skipped.push(`${entry.repo}/${entry.env}`);
      continue;
    }
    try {
      await saveConfigFile(entry.repo, entry.env, entry.config);
      await setKey(entry.repo, entry.env, entry.key);
    } catch (e) {
      console.error(
        `\nfailed while restoring ${entry.repo}/${entry.env}: ${(e as Error).message}\n` +
          `  ${profilesWritten} profile(s) and ${written} pair(s) were already written before this.\n` +
          `  The import is INCOMPLETE. Fix the cause and re-run — restoring is idempotent,\n` +
          `  and already-present pairs are skipped unless you pass --force.`,
      );
      process.exit(1);
    }
    written++;
    console.log(`  restored ${entry.repo}/${entry.env}`);
  }

  console.log(
    `\n${written} pair(s) and ${profilesWritten} profile(s) restored from ${absPath}.`,
  );
  if (skipped.length > 0) {
    console.log(
      `${skipped.length} already present and left untouched: ${skipped.join(", ")}\n` +
        `  Re-run with --force to overwrite them.`,
    );
  }
  if (written > 0) {
    console.log("\nNext: 'vsync pull <env>' inside each repo to fetch its vault.");
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
