// test-repo.ts — helpers for the v0.16+ test pattern.
//
// Old: tests set process.env.SECRETS_SYNC_REPO to control repo identity.
// New: the resolver requires a git tree + (.vsync OR origin URL).
// This helper sets up a tmp git workdir with a .vsync pin so the resolver
// reads `repo=<TEST_REPO>` from the file, mimicking what `vsync init` writes.
//
// Usage:
//
//   import { setupTestRepo } from "./helpers/test-repo";
//
//   beforeAll(() => {
//     const { workdir, restore } = setupTestRepo(TEST_REPO);
//     // process.cwd() is now `workdir`; a git repo is initialised there with
//     // .vsync pinning `repo=TEST_REPO`. Call `restore()` in afterAll.
//   });

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestRepoHandle {
  workdir: string;
  restore: () => void;
}

/**
 * Create an ephemeral git repo + .vsync pin, chdir into it, and return a
 * handle. The returned `restore()` chdirs back and removes the workdir.
 *
 * Caller is responsible for any keychain/config cleanup specific to their
 * tests — this helper only handles the cwd and the tmpdir.
 */
export function setupTestRepo(
  testRepoName: string,
  opts: { remoteUrl?: string } = {},
): TestRepoHandle {
  const prevCwd = process.cwd();
  const workdir = mkdtempSync(join(tmpdir(), `vsync-test-repo-${testRepoName}-`));

  // git init + commit (empty); needed so `git rev-parse --show-toplevel` works.
  execSync("git init -b main", { cwd: workdir });
  execSync(`git config user.email test@example.com`, { cwd: workdir });
  execSync(`git config user.name test`, { cwd: workdir });
  if (opts.remoteUrl) {
    execSync(`git remote add origin ${opts.remoteUrl}`, { cwd: workdir });
  }

  // Write .vsync pin so the resolver reads the expected identity.
  // We could rely on remoteUrl parsing instead, but a file is more deterministic
  // (tests are immune to the parser's edge cases).
  writeFileSync(
    join(workdir, ".vsync"),
    `# test fixture\nrepo=${testRepoName}\n`,
    { mode: 0o644 },
  );

  process.chdir(workdir);

  return {
    workdir,
    restore: () => {
      try {
        process.chdir(prevCwd);
      } catch {
        // ignore cleanup race
      }
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}
