// Lazy materialization of vault assets to a per-handle tempdir.
//
// Some SDKs only accept a filesystem path (GOOGLE_APPLICATION_CREDENTIALS,
// OpenSSL cert paths, …). For those, `assetPath()` writes the asset
// bytes to a 0600 file inside a 0700 per-handle tempdir and returns the
// path. `assetBytes()` (on the Vsync handle) should be the default in
// new code — it never touches the filesystem.
//
// Honest limits: SIGKILL does not run `close()`. A file may leak until
// next reboot (tmpfs) or until a sweep. v0.12 §6.

import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** On Linux, prefer /dev/shm (tmpfs) so the bytes never hit the platter. */
function preferredTmpdirBase(): string {
  if (process.platform === "linux" && existsSync("/dev/shm")) return "/dev/shm";
  return tmpdir();
}

export class AssetMaterializer {
  private tempdir: string | null = null;
  private cache = new Map<string, string>();
  private closed = false;

  /** Lazily create the per-handle tempdir with mode 0700. */
  private ensureDir(): string {
    if (this.tempdir === null) {
      this.tempdir = mkdtempSync(join(preferredTmpdirBase(), `vsync-${process.pid}-`));
      try {
        // mkdtemp creates with the process umask applied; force 0700.
        chmodSync(this.tempdir, 0o700);
      } catch {
        // Non-POSIX platforms (Windows) may reject; ignore.
      }
    }
    return this.tempdir;
  }

  /**
   * Write `payload` under a sanitised `name` and return its absolute path.
   * Repeat calls with the same name return the cached path; the original
   * bytes are NOT overwritten.
   */
  materialize(name: string, payload: Uint8Array): string {
    if (this.closed) {
      throw new Error("AssetMaterializer: already closed");
    }
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;

    // Defang the asset name: take basename only so a vault entry like
    // "../../etc/passwd" can't escape the tempdir. v0.12 makes no claim
    // against caller-controlled names (vault is operator-trusted), but
    // containment is the polite default.
    const safe = basename(name) || "_asset";
    const dir = this.ensureDir();
    const p = join(dir, safe);

    // O_WRONLY|O_CREAT|O_TRUNC with explicit 0600 — process umask is
    // irrelevant because we pass mode to open(2) directly.
    const fd = openSync(p, "w", 0o600);
    try {
      // node's writeSync accepts a Uint8Array.
      const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
      writeSync(fd, buf);
    } finally {
      closeSync(fd);
    }
    try {
      // Re-chmod in case the platform's open(2) didn't honour mode exactly
      // (umask gets applied on some setups).
      chmodSync(p, 0o600);
    } catch {
      // Same caveat as ensureDir.
    }
    this.cache.set(name, p);
    return p;
  }

  /** Best-effort cleanup. Idempotent. Failures are swallowed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tempdir !== null) {
      try {
        rmSync(this.tempdir, { recursive: true, force: true });
      } catch {
        // The process is exiting; the OS will reclaim tmpfs on reboot.
      }
      this.tempdir = null;
    }
    this.cache.clear();
  }
}
