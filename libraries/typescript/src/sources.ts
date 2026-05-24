// Two-input bootstrap resolution for VSYNC_CONFIG + VSYNC_PASSPHRASE.
//
// Per v0.12 §2:
//   - `_FILE` variant wins if both forms are set.
//   - Env-direct passphrase is verbatim (a leading space is part of it).
//   - File-backed value has trailing whitespace stripped.
//   - Neither form set → ConfigMissingError.
//
// Per v0.12 §13 (file-permissions policy):
//   - 0600 / 0400              → silent read.
//   - 0640 / 0644              → read + stderr warning.
//   - 0666 / 0777 (world-w)    → refuse → ConfigMissingError.
//   - ENOENT / EACCES          → ConfigMissingError with hint.
//
// On Windows, the permission check is skipped (POSIX mode bits aren't a
// meaningful concept there).

import { readFileSync, statSync } from "node:fs";
import { ConfigMissingError } from "./errors.js";

export const CONFIG_ENV = "VSYNC_CONFIG";
export const CONFIG_ENV_FILE = "VSYNC_CONFIG_FILE";
export const PASSPHRASE_ENV = "VSYNC_PASSPHRASE";
export const PASSPHRASE_ENV_FILE = "VSYNC_PASSPHRASE_FILE";

export type BootstrapInputs = {
  /** Raw bytes of the VSYNC_CONFIG blob (`vsync-cfg-v1:...`). */
  config: Uint8Array;
  /** Passphrase as a string. */
  passphrase: string;
};

type EnvLike = Record<string, string | undefined>;

function isWindows(): boolean {
  return process.platform === "win32";
}

function checkFileMode(path: string): void {
  if (isWindows()) return;
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === "ENOENT") {
      throw new ConfigMissingError(
        `vsync: ${path} does not exist — fix the deploy config`,
      );
    }
    if (err && err.code === "EACCES") {
      throw new ConfigMissingError(
        `vsync: cannot access ${path}: permission denied — check ownership / mode bits`,
      );
    }
    throw new ConfigMissingError(`vsync: stat(${path}) failed: ${String(e)}`);
  }
  if (mode & 0o002) {
    throw new ConfigMissingError(
      `vsync: refusing to read world-writable file ${path} (mode 0${mode.toString(8)}) — narrow to 0600`,
    );
  }
  if (mode & 0o044) {
    console.error(
      `vsync: ${path} is world/group-readable (mode 0${mode.toString(8)}); narrow to 0600`,
    );
  }
}

function readFileStripped(path: string): Buffer {
  checkFileMode(path);
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === "ENOENT") {
      throw new ConfigMissingError(
        `vsync: ${path} does not exist — fix the deploy config`,
      );
    }
    if (err && err.code === "EACCES") {
      throw new ConfigMissingError(
        `vsync: cannot read ${path}: permission denied`,
      );
    }
    throw new ConfigMissingError(`vsync: read(${path}) failed: ${String(e)}`);
  }
  // rstrip whitespace bytes ("\r\n\t ")
  let end = data.byteLength;
  while (end > 0) {
    const b = data[end - 1];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) end--;
    else break;
  }
  return data.subarray(0, end);
}

function resolveOne(
  envName: string,
  fileName: string,
  env: EnvLike,
): Buffer | null {
  const filePath = env[fileName];
  if (filePath !== undefined && filePath !== "") {
    return readFileStripped(filePath);
  }
  const raw = env[envName];
  if (raw !== undefined) {
    return Buffer.from(raw, "utf8");
  }
  return null;
}

/**
 * Resolve (VSYNC_CONFIG bytes, VSYNC_PASSPHRASE string).
 * Reads from `process.env` by default; pass an explicit env to override
 * (handy for tests).
 */
export function resolveBootstrapInputs(env?: EnvLike): BootstrapInputs {
  const e: EnvLike = env ?? (process.env as EnvLike);

  const cfgBuf = resolveOne(CONFIG_ENV, CONFIG_ENV_FILE, e);
  if (cfgBuf === null) {
    throw new ConfigMissingError(
      `vsync: neither ${CONFIG_ENV} nor ${CONFIG_ENV_FILE} is set — fix the deploy config (v0.12 §2)`,
    );
  }

  // For the passphrase we want different rules for "env-direct" vs "file":
  // env-direct is verbatim (leading space preserved); file is stripped.
  const filePath = e[PASSPHRASE_ENV_FILE];
  let passphrase: string;
  if (filePath !== undefined && filePath !== "") {
    passphrase = readFileStripped(filePath).toString("utf8");
  } else {
    const raw = e[PASSPHRASE_ENV];
    if (raw === undefined) {
      throw new ConfigMissingError(
        `vsync: neither ${PASSPHRASE_ENV} nor ${PASSPHRASE_ENV_FILE} is set — fix the deploy config (v0.12 §2)`,
      );
    }
    passphrase = raw;
  }

  return {
    config: new Uint8Array(cfgBuf.buffer, cfgBuf.byteOffset, cfgBuf.byteLength),
    passphrase,
  };
}
