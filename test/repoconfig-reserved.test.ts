// Found by stress test: a repo named `profiles` wrote its config INTO
// vsyncBaseDir()/profiles/ — the same directory holding myprofile.json — so it
// collided with vsync's own state and vanished from `vsync keystore list`.
// `backups` (src/vaultbackup.ts) has the identical problem. Pre-existing since
// the profiles layout landed in v0.13; surfaced by machine-wide enumeration.

import { describe, expect, test } from "bun:test";
import { assertUsableRepoName, configFilePath } from "../src/repoconfig";
import { ledgerPath } from "../src/ledger";

describe("reserved repo names", () => {
  for (const name of ["profiles", "backups"]) {
    test(`"${name}" is refused — it collides with vsync's own directory`, () => {
      expect(() => assertUsableRepoName(name)).toThrow(/reserved/);
      expect(() => configFilePath(name, "dev")).toThrow(/reserved/);
      expect(() => ledgerPath(name, "dev")).toThrow(/reserved/);
    });
  }

  test("the check is case-insensitive", () => {
    expect(() => assertUsableRepoName("Profiles")).toThrow(/reserved/);
    expect(() => assertUsableRepoName("BACKUPS")).toThrow(/reserved/);
  });

  test("ordinary repo names are unaffected", () => {
    for (const ok of ["acme_web", "myapp", "profiles_v2", "my-backups"]) {
      expect(() => assertUsableRepoName(ok)).not.toThrow();
    }
  });
});
