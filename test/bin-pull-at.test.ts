// bin-pull-at.test.ts — end-to-end coverage for `vsync pull --at=<ts>`.
//
// Closes the gap the stress test flagged: --at shipped with only its argument
// validation verified. This drives the whole path against a mocked bucket —
// download the requested version, decrypt, verify the manifest seal, unzip —
// and asserts the two properties that make time travel safe:
//
//   1. the OLD version's content actually lands in the vault, and
//   2. the remote pointer is never written.
//
// S3 is injected via bin/pull.ts::__setS3Mock, mirroring the seam
// bin-rotate-passphrase.test.ts uses.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main as pullMain, __setS3Mock, type PullS3 } from "../bin/pull";
import { setupTestRepo } from "./helpers/test-repo";
import { saveConfigFile } from "../src/repoconfig";
import { setKey, deleteKey, generateKey } from "../src/keychain";
import { zipPaths } from "../src/archive";
import { wrap } from "../src/manifest";
import { encrypt } from "../src/crypto";

const TEST_REPO = "pullat_fixture";
const ENV = "dev";
const SALT = "c2FsdHktc2FsdA==";
const VAULT = `infra/vault/${ENV}`;

const OLD_TS = "20260101-090000";
const NEW_TS = "20260610-120000";

const prefixKey = `${TEST_REPO}/${ENV}/`;
const pointerKey = `${prefixKey}latest`;

let repoHandle: ReturnType<typeof setupTestRepo>;
let prevXdg: string | undefined;
let xdgDir: string;
let key: string;

const sampleConfig = {
  version: 1 as const,
  s3: {
    endpoint: "https://s3.example.com",
    region: "eu-central-1",
    bucket: "vault-bucket",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret-example",
    useSsl: true,
  },
  encryption: { salt: SALT },
  prefix: `${ENV}/`,
};

/**
 * Build a real encrypted bundle whose zip contains `<VAULT>/.env.dev` with
 * `marker` as its body — the same envelope push produces: zip → wrap(ts) →
 * encrypt(key, salt).
 */
async function makeBundle(ts: string, marker: string): Promise<Uint8Array> {
  const staging = mkdtempSync(join(tmpdir(), "vsync-bundle-"));
  mkdirSync(join(staging, VAULT), { recursive: true });
  writeFileSync(join(staging, VAULT, `.env.${ENV}`), marker);
  // NB: src/archive.ts declares two `zipPaths` bodies; the 3-arg one shadows
  // the 2-arg one at runtime, so only this form actually works. Output goes
  // outside `staging` so the archive can't contain itself.
  const zipPath = join(tmpdir(), `vsync-bundle-${ts}-${Math.random().toString(36).slice(2)}.zip`);
  await zipPaths(staging, [VAULT], zipPath);
  const zipBytes = new Uint8Array(readFileSync(zipPath));
  rmSync(staging, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  return await encrypt(wrap(ts, zipBytes), key, SALT);
}

/** In-memory bucket exposing only what pull reads, recording every access. */
function makeS3(store: Map<string, Uint8Array | string>): PullS3 & {
  reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    file(k: string) {
      reads.push(k);
      return {
        async text() {
          const v = store.get(k);
          if (v === undefined) throw new Error(`mock S3: not found ${k}`);
          return typeof v === "string" ? v : new TextDecoder().decode(v);
        },
        async bytes() {
          const v = store.get(k);
          if (v === undefined) throw new Error(`mock S3: not found ${k}`);
          return typeof v === "string" ? new TextEncoder().encode(v) : v;
        },
      };
    },
  };
}

function vaultEnvPath(): string {
  return join(repoHandle.workdir, VAULT, `.env.${ENV}`);
}

// process.exit throws so a failing path is observable instead of killing the run.
let originalExit: typeof process.exit;
let exitCalls: number[];

beforeAll(async () => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  xdgDir = mkdtempSync(join(tmpdir(), "vsync-pullat-xdg-"));
  process.env.XDG_CONFIG_HOME = xdgDir;

  repoHandle = setupTestRepo(TEST_REPO);

  key = generateKey();
  await saveConfigFile(TEST_REPO, ENV, sampleConfig);
  await setKey(TEST_REPO, ENV, key);
});

afterAll(async () => {
  await deleteKey(TEST_REPO, ENV);
  repoHandle.restore();
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(xdgDir, { recursive: true, force: true });
});

beforeEach(() => {
  originalExit = process.exit;
  exitCalls = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`__exit:${code ?? 0}`);
  }) as never;
});

afterEach(() => {
  process.exit = originalExit;
  __setS3Mock(null);
  rmSync(join(repoHandle.workdir, VAULT), { recursive: true, force: true });
});

async function run(args: string[]): Promise<void> {
  try {
    await pullMain(args);
  } catch (e: any) {
    if (!String(e.message).startsWith("__exit:0")) throw e;
  }
}

describe("pull --at — time travel", () => {
  test("without --at, pulls whatever the pointer names", async () => {
    const store = new Map<string, Uint8Array | string>([
      [pointerKey, NEW_TS],
      [`${prefixKey}versions/${OLD_TS}.enc`, await makeBundle(OLD_TS, "OLD_VALUE")],
      [`${prefixKey}versions/${NEW_TS}.enc`, await makeBundle(NEW_TS, "NEW_VALUE")],
    ]);
    __setS3Mock(makeS3(store));

    await run([ENV, "--no-audit"]);

    expect(readFileSync(vaultEnvPath(), "utf8")).toBe("NEW_VALUE");
  });

  test("--at=<old ts> lands the OLD content in the vault", async () => {
    const store = new Map<string, Uint8Array | string>([
      [pointerKey, NEW_TS],
      [`${prefixKey}versions/${OLD_TS}.enc`, await makeBundle(OLD_TS, "OLD_VALUE")],
      [`${prefixKey}versions/${NEW_TS}.enc`, await makeBundle(NEW_TS, "NEW_VALUE")],
    ]);
    const s3 = makeS3(store);
    __setS3Mock(s3);

    await run([ENV, `--at=${OLD_TS}`, "--force", "--no-audit"]);

    expect(readFileSync(vaultEnvPath(), "utf8")).toBe("OLD_VALUE");
    // It downloaded the requested version, not the pointer's.
    expect(s3.reads).toContain(`${prefixKey}versions/${OLD_TS}.enc`);
    expect(s3.reads).not.toContain(`${prefixKey}versions/${NEW_TS}.enc`);
  });

  test("--at never writes to the remote — the pointer is untouched", async () => {
    const store = new Map<string, Uint8Array | string>([
      [pointerKey, NEW_TS],
      [`${prefixKey}versions/${OLD_TS}.enc`, await makeBundle(OLD_TS, "OLD_VALUE")],
    ]);
    __setS3Mock(makeS3(store));

    await run([ENV, `--at=${OLD_TS}`, "--force", "--no-audit"]);

    // The mock exposes no write surface at all; the pointer value is unchanged.
    expect(store.get(pointerKey)).toBe(NEW_TS);
  });

  test("--at equal to the pointer behaves like a normal pull", async () => {
    const store = new Map<string, Uint8Array | string>([
      [pointerKey, NEW_TS],
      [`${prefixKey}versions/${NEW_TS}.enc`, await makeBundle(NEW_TS, "NEW_VALUE")],
    ]);
    __setS3Mock(makeS3(store));

    await run([ENV, `--at=${NEW_TS}`, "--force", "--no-audit"]);

    expect(readFileSync(vaultEnvPath(), "utf8")).toBe("NEW_VALUE");
  });
});

describe("pull --at — failure paths", () => {
  test("a version that doesn't exist exits 1 and names `vsync versions`", async () => {
    const store = new Map<string, Uint8Array | string>([[pointerKey, NEW_TS]]);
    __setS3Mock(makeS3(store));

    await expect(
      pullMain([ENV, "--at=20200101-000000", "--force", "--no-audit"]),
    ).rejects.toThrow("__exit:1");
    expect(exitCalls).toContain(1);
    expect(existsSync(vaultEnvPath())).toBe(false);
  });

  test("a bundle sealed as a different ts is refused (rename-attack defence)", async () => {
    // Object stored at OLD_TS but sealed as NEW_TS — i.e. someone renamed a
    // version on the bucket. The manifest check must catch it under --at too,
    // not just on the pointer path.
    const store = new Map<string, Uint8Array | string>([
      [pointerKey, NEW_TS],
      [`${prefixKey}versions/${OLD_TS}.enc`, await makeBundle(NEW_TS, "TAMPERED")],
    ]);
    __setS3Mock(makeS3(store));

    await expect(
      pullMain([ENV, `--at=${OLD_TS}`, "--force", "--no-audit"]),
    ).rejects.toThrow("__exit:1");
    expect(existsSync(vaultEnvPath())).toBe(false);
  });

  test("a malformed --at is rejected before any S3 access", async () => {
    const s3 = makeS3(new Map());
    __setS3Mock(s3);

    await expect(pullMain([ENV, "--at=yesterday", "--no-audit"])).rejects.toThrow(
      "__exit:1",
    );
    expect(s3.reads).toEqual([]);
  });
});
