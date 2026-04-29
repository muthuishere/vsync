// Local rolling backup at ~/.config/localdevconfig/<name>-<ts>.zip.enc.
// Keeps only the 2 most recent backups per name; older ones are pruned.
//
// Backups are encrypted with the same key+salt as the S3 bundle so a
// stolen laptop / cloud-sync leak / Time Machine snapshot does not
// expose decrypted secrets sitting on disk.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { zipPaths } from "./archive";
import { encrypt } from "./crypto";

export const BACKUP_DIR = join(homedir(), ".config", "localdevconfig");
export const BACKUP_EXT = ".zip.enc";
const KEEP = 2;

export function backupDir(): string {
  const dir = process.env.LOCALDEVCONFIG_DIR ?? BACKUP_DIR;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function timestamp(): string {
  // YYYYMMDD-HHmmss UTC, e.g. 20260427-104530
  return new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

// Zip the supplied paths (relative to baseDir), encrypt the zip with the
// given key+salt, and write the encrypted blob to backupDir() as
// <name>-<ts>.zip.enc. Returns the path to the encrypted backup, or null
// if none of the paths existed (nothing to back up).
export async function makeBackup(
  name: string,
  baseDir: string,
  paths: string[],
  encryption: { key: string; salt: string },
): Promise<string | null> {
  const existing = paths.filter((p) => existsSync(join(baseDir, p)));
  if (existing.length === 0) return null;

  const dir = backupDir();
  const ts = timestamp();
  const tmpZip = join(
    tmpdir(),
    `bk-${ts}-${Math.random().toString(36).slice(2)}.zip`,
  );
  const outPath = join(dir, `${name.toLowerCase()}-${ts}${BACKUP_EXT}`);

  try {
    await zipPaths(baseDir, existing, tmpZip);
    const zipBytes = await Bun.file(tmpZip).bytes();
    const encrypted = await encrypt(zipBytes, encryption.key, encryption.salt);
    await Bun.write(outPath, encrypted);
  } finally {
    if (existsSync(tmpZip)) unlinkSync(tmpZip);
  }

  pruneBackups(name);
  return outPath;
}

// Delete all but the KEEP most-recent <name>-*.zip.enc files in the backup dir.
export function pruneBackups(name: string): void {
  const dir = backupDir();
  const prefix = `${name.toLowerCase()}-`;
  const matches = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(BACKUP_EXT))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of matches.slice(KEEP)) {
    unlinkSync(join(dir, f));
  }
}
