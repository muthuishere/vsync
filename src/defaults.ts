// defaults.ts — optional defaults template at ~/.config/vsync/defaults.
//
// Read by `vsync init` only — pre-fills prompts on subsequent setups
// after the first-ever init writes it. Never consulted by push / pull /
// sync — those resolve everything from the per-repo file (see
// repoconfig.ts) plus the keychain.
//
// Conventions: gzip(JSON), file 0600, parent dir 0700, honours
// XDG_CONFIG_HOME. Same security envelope as the per-repo file.

import { gunzipSync, gzipSync } from "node:zlib";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type Defaults = {
  version: 1;
  s3?: {
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    useSsl?: boolean;
  };
};

const ROOT_DIRNAME = "vsync";
const FILE_NAME = "defaults";

/** Base directory for vsync state. Honours XDG_CONFIG_HOME. */
export function vsyncBaseDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, ROOT_DIRNAME);
}

/** Path to the defaults template. */
export function defaultsFilePath(): string {
  return path.join(vsyncBaseDir(), FILE_NAME);
}

/** Persist the defaults template (creates the dir tree if needed). */
export async function saveDefaults(d: Defaults): Promise<string> {
  validateDefaults(d);
  const file = defaultsFilePath();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Non-fatal; some filesystems don't honour chmod.
  }
  const json = JSON.stringify(d);
  const gz = gzipSync(Buffer.from(json, "utf8"));
  await fs.writeFile(file, gz, { mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Same caveat as above.
  }
  return file;
}

/** Read the defaults template; returns null if absent. Throws on corruption. */
export async function loadDefaults(): Promise<Defaults | null> {
  const file = defaultsFilePath();
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
    throw err;
  }
  const json = gunzipSync(buf).toString("utf8");
  const parsed = JSON.parse(json);
  validateDefaults(parsed);
  return parsed;
}

/** Defensive shape check. */
export function validateDefaults(d: unknown): asserts d is Defaults {
  const x = d as Partial<Defaults> | null;
  if (!x || typeof x !== "object") throw new Error("defaults: not an object");
  if (x.version !== 1) {
    throw new Error(`defaults: unsupported version ${x.version} (expected 1)`);
  }
  if (x.s3 !== undefined && (typeof x.s3 !== "object" || x.s3 === null)) {
    throw new Error("defaults: s3 field must be an object if present");
  }
}
