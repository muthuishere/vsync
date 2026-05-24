// Help-text conformance tests.
//
// Every `vsync <subcommand> --help` (and the top-level `vsync --help`) must
// print a detailed reference block to stdout and exit 0. We programmatically
// invoke each subcommand's `main(argv)` with `--help` / `-h` and assert the
// output carries the standard headers + the subcommand name.
//
// New subcommand? Add it to SUBCOMMANDS below; the table-driven tests will
// pick it up automatically.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

const SUBCOMMANDS = [
  "init",
  "export",
  "import",
  "use",
  "push",
  "pull",
  "versions",
  "sync",
  "audit",
  "docs",
  "profile",
  "status",
  "runtime-token",
  "rotate-passphrase",
] as const;

const REQUIRED_HEADERS = [
  "NAME",
  "SYNOPSIS",
  "DESCRIPTION",
  "FLAGS",
  "EXAMPLES",
  "EXIT CODES",
  "SEE ALSO",
] as const;

// ─── capture harness ───────────────────────────────────────────────────

let originalExit: typeof process.exit;
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalWrite: typeof process.stdout.write;
let logBuf: string[];
let errBuf: string[];
let stdoutBuf: string[];
let exitCalls: number[];

function captureSetup(): void {
  originalExit = process.exit;
  originalLog = console.log;
  originalErr = console.error;
  originalWrite = process.stdout.write.bind(process.stdout);
  logBuf = [];
  errBuf = [];
  stdoutBuf = [];
  exitCalls = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`__exit:${code ?? 0}`);
  }) as any;
  console.log = (msg?: unknown) => {
    logBuf.push(String(msg ?? ""));
  };
  console.error = (msg?: unknown) => {
    errBuf.push(String(msg ?? ""));
  };
  (process.stdout.write as any) = (chunk: any) => {
    stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
}

function captureRestore(): void {
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalErr;
  process.stdout.write = originalWrite;
}

function combinedStdout(): string {
  return [logBuf.join("\n"), stdoutBuf.join("")].join("\n");
}

async function runHelp(
  subcommand: string,
  flag: "--help" | "-h",
): Promise<{ stdout: string; stderr: string; exit: number }> {
  // Dynamic import keeps each subcommand isolated and avoids any cross-test
  // module caching surprises in Bun's loader.
  const mod = await import(`../bin/${subcommand}`);
  let threw = false;
  try {
    await mod.main([flag]);
  } catch (e: any) {
    threw = true;
    if (!String(e?.message ?? "").startsWith("__exit:")) {
      throw e;
    }
  }
  return {
    stdout: combinedStdout(),
    stderr: errBuf.join("\n"),
    exit: threw ? exitCalls[exitCalls.length - 1] ?? 0 : 0,
  };
}

// ─── per-subcommand tests ──────────────────────────────────────────────

for (const sub of SUBCOMMANDS) {
  describe(`vsync ${sub} --help`, () => {
    beforeEach(() => captureSetup());
    afterEach(() => captureRestore());

    test("exits 0", async () => {
      const r = await runHelp(sub, "--help");
      expect(r.exit).toBe(0);
    });

    test("prints to stdout (not stderr)", async () => {
      const r = await runHelp(sub, "--help");
      expect(r.stdout.length).toBeGreaterThan(0);
      // stderr may carry deprecation notices etc., but the bulk of the help
      // belongs on stdout so it survives piping into a pager.
      expect(r.stdout.length).toBeGreaterThan(r.stderr.length);
    });

    for (const header of REQUIRED_HEADERS) {
      test(`output contains "${header}" header`, async () => {
        const r = await runHelp(sub, "--help");
        expect(r.stdout).toContain(header);
      });
    }

    test("mentions the subcommand name", async () => {
      const r = await runHelp(sub, "--help");
      expect(r.stdout).toContain(`vsync ${sub}`);
    });

    test("-h short flag works the same", async () => {
      const r = await runHelp(sub, "-h");
      expect(r.exit).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(0);
      for (const header of REQUIRED_HEADERS) {
        expect(r.stdout).toContain(header);
      }
    });
  });
}

// ─── top-level dispatcher ──────────────────────────────────────────────

describe("vsync --help (top-level)", () => {
  beforeEach(() => captureSetup());
  afterEach(() => captureRestore());

  test("usage text lists every subcommand", async () => {
    // bin/vsync.ts isn't a `main()` module — it runs at import time and
    // dispatches off process.argv. Rather than re-execute that whole flow,
    // test the usage text directly by spawning a subprocess.
    const repoRoot = new URL("..", import.meta.url).pathname;
    const proc = Bun.spawn({
      cmd: ["bun", `${repoRoot}bin/vsync.ts`, "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exit).toBe(0);
    for (const sub of SUBCOMMANDS) {
      expect(stdout).toContain(sub);
    }
    // Should advertise the per-subcommand --help convention.
    expect(stdout).toMatch(/<subcommand>\s*--help|subcommand.*--help/i);
  });
});
