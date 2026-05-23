// migration.ts — one-shot migration check for v0.13: rename the legacy
// `~/.config/vsync/defaults` file to `defaults.bak` and create an empty
// `profiles/` directory alongside it. Print a notice to stderr.
//
// Triggered from `bin/vsync.ts::main` on every invocation. Idempotent —
// second run finds the .bak already there and the dir already created,
// so the trigger doesn't fire. See docs/specs/v0.13-profiles-init-status.md §5.

import {
  existsSync,
  mkdirSync,
  renameSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { vsyncBaseDir } from "./defaults";
import { getProfilesDir } from "./profiles";

const NOTICE = `\
Note: the single-default mechanism was removed in v0.13. Your previous
defaults are at ~/.config/vsync/defaults.bak. Run \`vsync profile add <name>\`
to recreate them as a named profile, then \`vsync init <env> --profile=<name>\`.
`;

export type MigrationOptions = {
  /** Override stderr writer (tests inject a buffer here). */
  writeStderr?: (s: string) => void;
};

/**
 * If `<base>/defaults` exists AND `<base>/profiles/` does NOT, rename
 * defaults → defaults.bak and create profiles/. Returns true when the
 * migration ran, false when it was a no-op.
 */
export function migrateLegacyDefaultsIfNeeded(
  opts: MigrationOptions = {},
): boolean {
  const writeStderr = opts.writeStderr ?? ((s: string) => process.stderr.write(s));

  const base = vsyncBaseDir();
  const defaultsFile = join(base, "defaults");
  const profilesDir = getProfilesDir();

  if (!existsSync(defaultsFile)) return false;
  if (existsSync(profilesDir)) return false;

  // Preserve original mode (typically 0600).
  let mode = 0o600;
  try {
    mode = statSync(defaultsFile).mode & 0o777;
  } catch {
    // Best effort — fall back to 0600.
  }

  const bak = defaultsFile + ".bak";
  renameSync(defaultsFile, bak);
  try {
    chmodSync(bak, mode);
  } catch {
    // Non-fatal; some filesystems don't honour chmod.
  }

  mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(profilesDir, 0o700);
  } catch {
    // Same caveat.
  }

  writeStderr(NOTICE);
  return true;
}
