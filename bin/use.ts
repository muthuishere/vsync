#!/usr/bin/env bun
// Usage: vsync use <env> [--link=<path>] [--repo=<name>]
//        vsync use [--link=<path>]                (no env → print current target)
//
// Creates a symlink at `<link>` (default `./.env`) pointing at
// `<vaultFolder>/.env.<env>`, so apps can just `dotenv.config()` and pick up
// vault contents. Switch envs with `vsync use <other-env>`.
//
// Examples:
//   vsync use dev                                # ./.env → infra/vault/dev/.env.dev
//   vsync use dev --link=.env.dev                # ./.env.dev → … (keep .env free)
//   vsync use prod --link=apps/web/.env          # ./apps/web/.env → … (monorepo)
//
// Safety:
// - If <link> is a regular file (not a symlink) we NEVER touch it — even
//   with a flag. The user must rename or delete it first.
// - An existing symlink at <link> is replaced silently (cheap to recreate).
// - Warns if the link's basename isn't covered by `.gitignore`.
//
// Cross-platform: uses POSIX symlinks via `symlink(target, path, "file")`.
// Works on macOS / Linux / WSL out of the box. On Windows, requires
// Developer Mode (Settings → Privacy & security → For developers) OR an
// elevated terminal — Windows file symlinks are a privileged op. Junctions
// are dir-only and don't apply here.

import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "../src/argv";
import { wantsHelp, printHelp } from "../src/help";
import { getRepoName, getRepoRoot, getVaultRoot } from "../src/repo";
import { loadConfigFile } from "../src/repoconfig";

const HELP = `
NAME
  vsync use — symlink ./.env (or any path) to the vault's .env.<env>

SYNOPSIS
  vsync use <env> [--link=<path>] [--repo=<name>]
  vsync use [--link=<path>]                 (no env: print current target)

DESCRIPTION
  Creates a POSIX symlink at <link> (default ./.env, resolved against the
  repo root) pointing at <vaultFolder>/.env.<env>. Apps that already
  \`dotenv.config()\` then pick up vault contents without code changes.
  Switch envs by re-running with a different <env>.

  Without <env>, prints the current target of <link> (or "(no <link>)" if
  absent). If <link> exists as a regular file the command refuses to touch
  it — rename or delete it first. Existing symlinks at <link> are replaced
  silently. Warns when <link>'s basename isn't covered by .gitignore.

  Cross-platform: macOS / Linux / WSL work out of the box. On Windows the
  process needs Developer Mode or an elevated terminal — Windows file
  symlinks are a privileged op.

FLAGS
  --link=<path>            link path, resolved against the repo root
                           default: <repo-root>/.env
  --repo=<name>            override the auto-detected repo name
  --help, -h               print this help and exit

EXAMPLES
  # Default — ./.env → infra/vault/dev/.env.dev
  vsync use dev

  # Keep ./.env free; use ./.env.dev instead
  vsync use dev --link=.env.dev

  # Monorepo — drop the link inside an app folder
  vsync use prod --link=apps/web/.env

  # Print the current target without changing anything
  vsync use

EXIT CODES
  0    symlink created / already correct, or current target printed
  1    missing config, target .env.<env> not pulled yet, or <link> is a
       regular file (refuses to clobber), or Windows symlink-permission denied

SEE ALSO
  vsync pull(1)            populate <vaultFolder>/.env.<env> before \`use\`
  vsync init(1)            sets vaultFolder; \`use\` follows it transparently
  docs/guide/use.md
`;

export async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) printHelp(HELP);
  const { positional, flags } = parseArgs(argv);
  const env = positional[0];
  // Two different roots on purpose:
  //   `root`      — THIS worktree's toplevel. The symlink lands here, because
  //                 the app that reads .env runs in this checkout.
  //   `vaultRoot` — where the vault actually lives. Same as `root` in the main
  //                 worktree; the main worktree's toplevel when we're in a
  //                 linked one, so every worktree points at one shared vault
  //                 instead of each needing its own `vsync pull`.
  const root = await getRepoRoot();
  const vaultRoot = await getVaultRoot();
  // All link paths resolve against the repo root — matches every other
  // vsync verb (push, pull, sync, audit). So `vsync use dev --link=.env.dev`
  // lands the symlink at <repoRoot>/.env.dev regardless of cwd.
  const linkPath = flags.link
    ? resolve(root, flags.link)
    : join(root, ".env");

  // No env → print current target (or absence) and exit.
  if (!env) {
    const st = safeLstat(linkPath);
    if (!st) {
      console.log(`(no ${relativeToRoot(linkPath, root)})`);
      return;
    }
    if (st.isSymbolicLink()) {
      console.log(
        `${relativeToRoot(linkPath, root)} → ${readlinkSync(linkPath)}`,
      );
    } else {
      console.log(
        `${relativeToRoot(linkPath, root)} (regular file — not a vsync symlink, untouched)`,
      );
    }
    return;
  }

  const repo = await getRepoName({ override: flags.repo });
  const cfg = await loadConfigFile(repo, env);
  if (!cfg) {
    console.error(
      `no config for ${repo}/${env}. Run 'vsync init ${env}' or 'vsync import ${env} <share-file>' first.`,
    );
    process.exit(1);
  }

  const vaultFolder =
    cfg.files?.vaultFolder ?? `infra/vault/${env.toLowerCase()}`;
  const target = join(vaultRoot, vaultFolder, `.env.${env}`);
  if (!existsSync(target)) {
    console.error(
      `expected ${target} to exist — run 'vsync pull ${env}' first.`,
    );
    process.exit(1);
  }

  if (!existsSync(dirname(linkPath))) {
    console.error(
      `directory ${dirname(linkPath)} does not exist — create it or pick a different --link path.`,
    );
    process.exit(1);
  }

  const existing = safeLstat(linkPath);
  if (existing) {
    if (!existing.isSymbolicLink()) {
      const rel = relativeToRoot(linkPath, root);
      console.error(
        `${rel} exists as a regular file — refusing to touch it (no --force, by design).\n` +
          `Move or delete it first if you want vsync to manage it:\n` +
          `  mv ${rel} ${rel}.local.bak    # or: rm ${rel}\n` +
          `then re-run 'vsync use ${env}${flags.link ? ` --link=${flags.link}` : ""}'.`,
      );
      process.exit(1);
    }
    unlinkSync(linkPath);
  }

  const symlinkTarget = relative(dirname(linkPath), target);
  try {
    // Pass "file" type for Windows; ignored on POSIX.
    symlinkSync(symlinkTarget, linkPath, "file");
  } catch (e: any) {
    if (process.platform === "win32" && (e?.code === "EPERM" || e?.code === "EACCES")) {
      console.error(
        `Windows symlinks require Developer Mode or admin privileges.\n` +
          `Enable Developer Mode: Settings → Privacy & security → For developers,\n` +
          `or run this command in an elevated terminal.`,
      );
      process.exit(1);
    }
    throw e;
  }
  console.log(`✅ ${relativeToRoot(linkPath, root)} → ${symlinkTarget}`);

  // Gitignore hint — only meaningful when the link sits inside the repo.
  const linkRel = relative(root, linkPath);
  if (linkRel.startsWith("..") || resolve(root, linkRel) !== linkPath) {
    return; // link is outside the repo; nothing to gitignore
  }
  const linkBase = basename(linkPath);
  const giPath = join(root, ".gitignore");
  let gitignored = false;
  if (existsSync(giPath)) {
    const lines = readFileSync(giPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    gitignored = lines.some((l) => coversBasename(l, linkBase));
  }
  if (!gitignored) {
    console.error(
      `⚠  ${linkRel} is not covered by .gitignore — add a rule for it before committing`,
    );
  }
}

function safeLstat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function relativeToRoot(p: string, root: string): string {
  const r = relative(root, p);
  return r.startsWith("..") ? p : `./${r}`;
}

function coversBasename(pattern: string, name: string): boolean {
  if (!pattern || pattern.startsWith("#")) return false;
  const p = pattern.replace(/^\//, "").replace(/\/$/, "");
  if (p === name) return true;
  // Common glob patterns we recognise without a full gitignore parser.
  if (p === ".env*" && name.startsWith(".env")) return true;
  if (p === ".env.*" && name.startsWith(".env.")) return true;
  if (p === "*.env" && name.endsWith(".env")) return true;
  if (p === "*" || p === "**") return true;
  return false;
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
