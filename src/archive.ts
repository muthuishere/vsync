// Folder ⇄ zip helpers. Shells out to system `zip` / `unzip`.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Zip a folder's contents into a temp .zip file. Returns the path to the zip.
// The folder's children are placed at the zip root (preserves subdirectory
// structure inside the folder, but not the folder name itself).
export async function zipFolder(folderPath: string): Promise<string> {
  const out = join(
    tmpdir(),
    `pkg-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
  );
  const proc = Bun.spawn(["zip", "-r", "-q", out, "."], {
    cwd: folderPath,
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`zip exited ${code}: ${err.trim()}`);
  }
  return out;
}

// Zip a list of paths (files and/or folders) relative to baseDir into one
// temp zip. Paths are stored at their relative locations, so unzipping back
// at baseDir restores them exactly. Returns the zip's path.
export async function zipPaths(
  baseDir: string,
  paths: string[],
): Promise<string> {
  if (paths.length === 0) {
    throw new Error("zipPaths: no paths supplied");
  }
  const out = join(
    tmpdir(),
    `bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
  );
  const proc = Bun.spawn(["zip", "-r", "-q", out, ...paths], {
    cwd: baseDir,
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`zip exited ${code}: ${err.trim()}`);
  }
  return out;
}

// Zip a list of paths (files and/or folders) relative to baseDir into a zip
// at outPath. Paths are stored at their relative locations, so unzipping at
// baseDir restores them exactly.
export async function zipPaths(
  baseDir: string,
  paths: string[],
  outPath: string,
): Promise<void> {
  if (paths.length === 0) {
    throw new Error("zipPaths: no paths supplied");
  }
  const proc = Bun.spawn(["zip", "-r", "-q", outPath, ...paths], {
    cwd: baseDir,
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`zip exited ${code}: ${err.trim()}`);
  }
}

// Extract zipPath into targetFolder, creating it if missing. Overwrites.
export async function unzipTo(
  zipPath: string,
  targetFolder: string,
): Promise<void> {
  mkdirSync(targetFolder, { recursive: true });
  const proc = Bun.spawn(["unzip", "-q", "-o", zipPath, "-d", targetFolder], {
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`unzip exited ${code}: ${err.trim()}`);
  }
}
