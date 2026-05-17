// Unit tests for the pure / output-only helpers in bin/sync.ts.
//
// bin/sync.ts::main shells out to gh/gcloud/which, so end-to-end coverage
// would require process-spawn mocking. What we *can* unit-test cheaply is
// the policy-header output (the v0.7 spec §4.1 user-visible contract).
// Flag-list parsing — `lists["inline-file-suffix"]` and friends — is
// already exercised by test/argv.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { printPolicyHeader } from "../bin/sync";

describe("printPolicyHeader (spec v0.7 §4.1)", () => {
  let lines: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    lines = [];
    originalLog = console.log;
    console.log = (msg?: unknown) => {
      lines.push(String(msg ?? ""));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("both lists empty → 'none' placeholder on each row", () => {
    printPolicyHeader([], []);
    expect(lines).toEqual([
      "\nParser policy:",
      "  inline-file-suffix: (none — file refs disabled)",
      "  exclude-property:   (none — nothing skipped)",
    ]);
  });

  test("v0.6-equivalent invocation prints one row per value", () => {
    printPolicyHeader(
      ["_PATH", "_FILE"],
      ["GITHUB_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS"],
    );
    expect(lines).toEqual([
      "\nParser policy:",
      "  inline-file-suffix: _PATH",
      "  inline-file-suffix: _FILE",
      "  exclude-property:   GITHUB_TOKEN",
      "  exclude-property:   GOOGLE_APPLICATION_CREDENTIALS",
    ]);
  });

  test("only suffixes set → excludes still print the 'none' row", () => {
    printPolicyHeader(["_PATH"], []);
    expect(lines).toEqual([
      "\nParser policy:",
      "  inline-file-suffix: _PATH",
      "  exclude-property:   (none — nothing skipped)",
    ]);
  });

  test("only excludes set → suffixes still print the 'none' row", () => {
    printPolicyHeader([], ["GITHUB_TOKEN"]);
    expect(lines).toEqual([
      "\nParser policy:",
      "  inline-file-suffix: (none — file refs disabled)",
      "  exclude-property:   GITHUB_TOKEN",
    ]);
  });

  test("custom suffix and custom key round-trip verbatim", () => {
    printPolicyHeader(["_KEY"], ["STRIPE_TEST"]);
    expect(lines).toEqual([
      "\nParser policy:",
      "  inline-file-suffix: _KEY",
      "  exclude-property:   STRIPE_TEST",
    ]);
  });
});
