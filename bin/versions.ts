#!/usr/bin/env bun
// Usage: vsync versions <env> [--repo=<name>]
//
// Lists s3://<bucket>/<env>/versions/ — one line per <ts>.enc with size
// and age, with a `* latest` marker on the version <env>/latest currently
// points at. Read-only; doesn't decrypt anything (so no keychain key is
// needed — just the per-repo file with S3 creds).

import { parseArgs } from "../src/argv";
import { getRepoName } from "../src/repo";
import { loadConfigFile, configFilePath } from "../src/repoconfig";
import { makeClient } from "../src/s3";

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  if (!env) {
    console.error("usage: vsync versions <env> [--repo=<name>]");
    process.exit(1);
  }
  const repo = await getRepoName({ override: flags.repo });

  const cfg = await loadConfigFile(repo, env);
  if (!cfg) {
    console.error(
      `no config file for ${repo}/${env} at ${configFilePath(repo, env)}.\n` +
        `Run 'vsync init ${env}' first, or 'vsync import ${env} <share-file>' if a teammate sent you one.`,
    );
    process.exit(1);
  }

  const client = makeClient(cfg.s3);
  const prefix = `${repo}/${env.toLowerCase()}/versions/`;

  let listing;
  try {
    listing = await client.list({ prefix });
  } catch (e) {
    console.error(`failed to list s3://${cfg.s3.bucket}/${prefix}: ${(e as Error).message}`);
    process.exit(1);
  }

  // Read the latest pointer in parallel with the listing — empty/missing
  // is OK (means no successful push yet).
  let latestTs = "";
  try {
    latestTs = (await client.file(`${repo}/${env.toLowerCase()}/latest`).text()).trim();
  } catch {
    // No pointer yet.
  }

  const objects = (listing?.contents ?? [])
    .filter((o: any) => typeof o?.key === "string" && o.key.endsWith(".enc"))
    .map((o: any) => {
      const fname = o.key.slice(prefix.length); // <ts>.enc
      const ts = fname.replace(/\.enc$/, "");
      return {
        ts,
        key: o.key as string,
        size: typeof o.size === "number" ? o.size : 0,
        lastModified:
          o.lastModified instanceof Date
            ? o.lastModified
            : o.lastModified
              ? new Date(o.lastModified)
              : null,
      };
    })
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first

  if (objects.length === 0) {
    console.log(`(no versions yet at s3://${cfg.s3.bucket}/${prefix})`);
    return;
  }

  console.log(`s3://${cfg.s3.bucket}/${prefix}  (${objects.length} version${objects.length === 1 ? "" : "s"})`);
  for (const o of objects) {
    const marker = o.ts === latestTs ? " *" : "  ";
    const size = formatSize(o.size);
    const age = o.lastModified ? formatAge(o.lastModified) : "?";
    console.log(`${marker} ${o.ts}   ${size.padStart(8)}   ${age}`);
  }
  if (latestTs && !objects.some((o) => o.ts === latestTs)) {
    console.log(`\n⚠  pointer claims ${latestTs} but no matching version object found.`);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(d: Date): string {
  const ms = Date.now() - d.getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
