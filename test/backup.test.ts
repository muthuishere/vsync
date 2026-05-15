import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBackup, pruneBackups, BACKUP_EXT } from "../src/backup";
import { unzipTo } from "../src/archive";
import { decrypt } from "../src/crypto";

const ENC = { key: "test-passphrase-with-enough-length", salt: "test-salt-long-enough" };

describe("backup", () => {
  let configDir: string;
  let repoDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "ldc-"));
    repoDir = mkdtempSync(join(tmpdir(), "repo-"));
    originalEnv = process.env.VSYNC_BACKUP_DIR;
    process.env.VSYNC_BACKUP_DIR = configDir;
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.VSYNC_BACKUP_DIR;
    else process.env.VSYNC_BACKUP_DIR = originalEnv;
  });

  test("returns null when no source paths exist", async () => {
    const result = await makeBackup("LOCAL", repoDir, [".env", "vault"], ENC);
    expect(result).toBeNull();
  });

  test("creates an encrypted backup when at least one source path exists", async () => {
    await Bun.write(join(repoDir, ".env"), "FOO=bar");
    mkdirSync(join(repoDir, "vault"), { recursive: true });
    await Bun.write(join(repoDir, "vault", "key.txt"), "secret");

    const path = await makeBackup("LOCAL", repoDir, [".env", "vault"], ENC);
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(path!.endsWith(BACKUP_EXT)).toBe(true);
    expect(path!.includes("local-")).toBe(true);

    // The backup is NOT a plain zip — it's an RQE1 encrypted envelope.
    const head = await Bun.file(path!).bytes();
    expect(String.fromCharCode(head[0], head[1], head[2], head[3])).toBe("RQE1");

    // Decrypt → unzip → verify original contents survived the roundtrip.
    const zipBytes = await decrypt(head, ENC.key, ENC.salt);
    const tmpZip = join(tmpdir(), `bk-test-${Math.random().toString(36).slice(2)}.zip`);
    await Bun.write(tmpZip, zipBytes);
    const restoreDir = mkdtempSync(join(tmpdir(), "restore-"));
    try {
      await unzipTo(tmpZip, restoreDir);
      expect(await Bun.file(join(restoreDir, ".env")).text()).toBe("FOO=bar");
      expect(await Bun.file(join(restoreDir, "vault", "key.txt")).text()).toBe(
        "secret",
      );
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
      if (existsSync(tmpZip)) rmSync(tmpZip);
    }
  }, 15000);

  test("decrypt with wrong key fails", async () => {
    await Bun.write(join(repoDir, ".env"), "FOO=bar");
    const path = await makeBackup("LOCAL", repoDir, [".env"], ENC);
    const bytes = await Bun.file(path!).bytes();
    expect(decrypt(bytes, "wrong-key-but-long-enough-x", ENC.salt)).rejects.toThrow();
  }, 15000);

  test("keeps only the 2 most recent backups per name", async () => {
    await Bun.write(join(repoDir, ".env"), "x");
    await makeBackup("LOCAL", repoDir, [".env"], ENC);
    await Bun.sleep(1100);
    await makeBackup("LOCAL", repoDir, [".env"], ENC);
    await Bun.sleep(1100);
    await makeBackup("LOCAL", repoDir, [".env"], ENC);

    const files = readdirSync(configDir).filter(
      (f) => f.startsWith("local-") && f.endsWith(BACKUP_EXT),
    );
    expect(files.length).toBe(2);
  }, 15000);

  test("pruneBackups is name-scoped (other names untouched)", async () => {
    await Bun.write(join(repoDir, ".env"), "x");
    await makeBackup("LOCAL", repoDir, [".env"], ENC);
    await Bun.sleep(1100);
    await makeBackup("DEV", repoDir, [".env"], ENC);
    await Bun.sleep(1100);
    await makeBackup("LOCAL", repoDir, [".env"], ENC);
    await Bun.sleep(1100);
    await makeBackup("LOCAL", repoDir, [".env"], ENC);

    pruneBackups("LOCAL");
    const local = readdirSync(configDir).filter((f) => f.startsWith("local-"));
    const dev = readdirSync(configDir).filter((f) => f.startsWith("dev-"));
    expect(local.length).toBe(2);
    expect(dev.length).toBe(1);
  }, 15000);
});
