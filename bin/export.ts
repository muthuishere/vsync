#!/usr/bin/env bun
// Usage: secret-lib export <env> [--repo=<name>] [--out=<path>] [--passphrase=<pp>] [--interactive]
//
// Bundles the on-disk config file + the keychain-stored AES key into a
// passphrase-encrypted file that's safe to send via any channel
// (Slack/AirDrop/email — same envelope used by S3 pushes). The passphrase
// is auto-generated if not supplied and printed to stdout for the user
// to copy.
//
// Default output path: ./<repo>-<env>.share

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { loadConfigFile, configFilePath } from "../src/configfile";
import { getKey } from "../src/keychain";
import { EXPORT_BLOB_VERSION, type ExportPayload } from "../src/envconfig";
import { buildShareFile } from "../src/sharefile";
import { generatePassphrase } from "../src/passphrase";
import { askText, isTty } from "../src/prompt";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  if (!env) {
    console.error("usage: secret-lib export <env> [--repo=<name>] [--out=<path>] [--passphrase=<pp>]");
    process.exit(1);
  }
  const interactive = flags.interactive === "true";
  const repo = await getRepoName({ override: flags.repo });

  const cfg = await loadConfigFile(repo, env);
  if (!cfg) {
    console.error(
      `no config file for ${repo}/${env} at ${configFilePath(repo, env)}.\n` +
        `Run 'secret-lib init ${env}' first, or 'secret-lib import ${env} <share-file>' if a teammate sent you one.`,
    );
    process.exit(1);
  }
  const key = await getKey(repo, env);
  if (!key) {
    console.error(
      `encryption key for ${repo}/${env} not found in OS keychain.\n` +
        `Either re-run 'secret-lib init ${env}' (generates a new key) or 'secret-lib link ${env} --key=<key>' (saves an existing one).`,
    );
    process.exit(1);
  }

  let passphrase = flags.passphrase;
  if ((!passphrase || interactive) && isTty()) {
    const generated = generatePassphrase();
    if (interactive) {
      const custom = askText(
        `Passphrase to encrypt the share file (blank → use generated "${generated}")`,
      );
      passphrase = custom || generated;
    } else {
      passphrase = generated;
    }
  }
  if (!passphrase) {
    passphrase = generatePassphrase();
  }

  const out = resolve(flags.out ?? `./${repo}-${env}.share`);

  const payload: ExportPayload = {
    version: EXPORT_BLOB_VERSION,
    repo,
    env,
    config: cfg,
    key,
  };

  const bytes = await buildShareFile(payload, passphrase);
  await writeFile(out, bytes, { mode: 0o600 });

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("✅ Share file written");
  console.log("─────────────────────────────────────────────────────────────\n");
  console.log(`  file:        ${out}`);
  console.log(`  passphrase:  ${passphrase}\n`);
  console.log("Send the file and the passphrase to your teammate on TWO different channels");
  console.log("(e.g. file via Slack DM, passphrase via SMS).\n");
  console.log("They will run:");
  console.log(`  secret-lib import ${env} ${out.split("/").pop()}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
