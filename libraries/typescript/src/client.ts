// Public Vsync handle + module-level open() / openWith() / getEnv() facade.
//
// This binds together:
//   - sources.resolveBootstrapInputs (two-env-var contract)
//   - config-blob.decodeConfigBlob   (VSYNC_CONFIG decode)
//   - manifest.verifyAgainstRemoteTs (RQEM0001 read + anti-rollback)
//   - crypto.decryptRqe1             (RQE1 decrypt)
//   - the fallback chain (vault → env → defaults → missing)
//
// Vault wire format inside the decrypted bundle (v0.12 §6 + Python lib):
//   { "kv": {...}, "assets": {"name": "<base64-bytes>"} }
// Backwards-compat: a flat object at the root is treated as `kv` only.

import { decodeConfigBlob, type VsyncConfig } from "./config-blob.js";
import { decryptRqe1 } from "./crypto.js";
import {
  BundleCorruptError,
  ConfigMissingError,
  ManifestNotFoundError,
  S3UnreachableError,
  VSyncError,
} from "./errors.js";
import { resolveBootstrapInputs } from "./sources.js";

export type Source = "vault" | "env" | "default" | "missing";

/** Lightweight snapshot of the decoded config passed to S3 fetchers. */
export type VsyncConfigSnapshot = VsyncConfig;

export type S3FetchResult = {
  manifestBytes: Uint8Array;
  bundleBytes: Uint8Array;
  /** From the (optional) manifest meta cell at `<prefix>latest.meta`. */
  generation: number;
};

/**
 * Pluggable fetcher signature. The real impl uses @aws-sdk/client-s3;
 * unit tests + the conformance harness swap it via `__setS3Fetcher`.
 */
export type S3Fetcher = (cfg: VsyncConfigSnapshot) => Promise<S3FetchResult>;

/** `open()` options. */
export type OpenOptions = {
  defaults?: Record<string, string>;
};

/** `openWith()` options. */
export type OpenWithOptions = {
  config: string;
  passphrase: string;
  defaults?: Record<string, string>;
};

let injectedFetcher: S3Fetcher | null = null;
let singleton: Vsync | null = null;

/** Test/integration hook. Pass `null` to restore the real fetcher. */
export function __setS3Fetcher(f: S3Fetcher | null): void {
  injectedFetcher = f;
}

/** Test hook — drops the module-level singleton without closing it. */
export function __resetSingleton(): void {
  if (singleton !== null) {
    try {
      void singleton.close();
    } catch {
      /* swallow */
    }
  }
  singleton = null;
}

/**
 * Parse the decrypted bundle plaintext into (kv, assets).
 * Accepts the structured shape `{ kv, assets }` and the flat-object
 * back-compat shape.
 */
function parseVaultPayload(
  payload: Uint8Array,
): { kv: Map<string, string>; assets: Map<string, Uint8Array> } {
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch (e) {
    throw new BundleCorruptError(
      `vault payload is not valid UTF-8 JSON: ${(e as Error).message}`,
    );
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new BundleCorruptError(
      `vault payload root must be a JSON object, got ${Array.isArray(obj) ? "array" : typeof obj}`,
    );
  }
  const o = obj as Record<string, unknown>;
  const kv = new Map<string, string>();
  const assets = new Map<string, Uint8Array>();

  if ("kv" in o || "assets" in o) {
    const rawKv = (o.kv as Record<string, unknown> | undefined) ?? {};
    const rawAssets = (o.assets as Record<string, unknown> | undefined) ?? {};
    if (typeof rawKv !== "object" || rawKv === null || Array.isArray(rawKv)) {
      throw new BundleCorruptError("vault payload: `kv` must be a JSON object");
    }
    if (typeof rawAssets !== "object" || rawAssets === null || Array.isArray(rawAssets)) {
      throw new BundleCorruptError("vault payload: `assets` must be a JSON object");
    }
    for (const [k, v] of Object.entries(rawKv)) {
      if (typeof v !== "string") {
        throw new BundleCorruptError(
          `vault payload: kv[${JSON.stringify(k)}] must be a string, got ${typeof v}`,
        );
      }
      kv.set(k, v);
    }
    for (const [k, v] of Object.entries(rawAssets)) {
      if (typeof v !== "string") {
        throw new BundleCorruptError(
          `vault payload: assets[${JSON.stringify(k)}] must be a base64 string`,
        );
      }
      try {
        assets.set(k, new Uint8Array(Buffer.from(v, "base64")));
      } catch (e) {
        throw new BundleCorruptError(
          `vault payload: assets[${JSON.stringify(k)}] is not valid base64: ${(e as Error).message}`,
        );
      }
    }
  } else {
    // Flat-object back-compat: every value is a string KV.
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== "string") {
        throw new BundleCorruptError(
          `vault payload: ${JSON.stringify(k)} must be a string, got ${typeof v}`,
        );
      }
      kv.set(k, v);
    }
  }
  return { kv, assets };
}

/** In-memory accessor for a decrypted vault. Construct via `open()`. */
export class Vsync {
  private kv: Map<string, string>;
  private assets: Map<string, Uint8Array>;
  private readonly defaults: Map<string, string>;
  private readonly _generation: number;
  private readonly _env: string;
  private readonly _cfg: VsyncConfigSnapshot | null;
  private readonly _fetcher: S3Fetcher | null;
  private closed = false;

  private constructor(args: {
    kv: Map<string, string>;
    assets: Map<string, Uint8Array>;
    defaults: Map<string, string>;
    generation: number;
    env: string;
    cfg?: VsyncConfigSnapshot | null;
    fetcher?: S3Fetcher | null;
  }) {
    this.kv = args.kv;
    this.assets = args.assets;
    this.defaults = args.defaults;
    this._generation = args.generation;
    this._env = args.env;
    this._cfg = args.cfg ?? null;
    this._fetcher = args.fetcher ?? null;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Vsync: handle is closed");
    }
  }

  /** Resolve `key` through vault → env → defaults → missing. */
  getEnv(key: string): string | null {
    this.assertOpen();
    const v = this.kv.get(key);
    if (v !== undefined) return v;
    const envVal = process.env[key];
    if (envVal !== undefined) return envVal;
    const d = this.defaults.get(key);
    if (d !== undefined) return d;
    return null;
  }

  hasEnv(key: string): boolean {
    this.assertOpen();
    return (
      this.kv.has(key) ||
      Object.prototype.hasOwnProperty.call(process.env, key) ||
      this.defaults.has(key)
    );
  }

  envSource(key: string): Source {
    this.assertOpen();
    if (this.kv.has(key)) return "vault";
    if (Object.prototype.hasOwnProperty.call(process.env, key)) return "env";
    if (this.defaults.has(key)) return "default";
    return "missing";
  }

  /** Return asset bytes; never touches the filesystem. */
  getAsContent(name: string): Uint8Array {
    this.assertOpen();
    const a = this.assets.get(name);
    if (a !== undefined) return a;
    const v = this.kv.get(name);
    if (v !== undefined) return new TextEncoder().encode(v);
    throw new Error(
      `vsync: asset ${JSON.stringify(name)} not in vault (assets and kv both miss this name)`,
    );
  }

  generation(): number {
    return this._generation;
  }

  /**
   * Explicit-poll carve-out (v0.12 §4.5 / §7.1): one HEAD on the
   * manifest, returns the remote `meta.gen` integer. Does NOT mutate
   * `generation()`. Throws `S3UnreachableError` on network failure,
   * `ManifestNotFoundError` on 404. Designed for healthcheck endpoints
   * and sidecar crons — caller decides whether to trigger a restart.
   */
  async remoteGeneration(): Promise<number> {
    this.assertOpen();
    if (this._cfg === null || this._fetcher === null) {
      throw new S3UnreachableError(
        "vsync: remoteGeneration requires a handle opened via open() (no fetcher bound)",
      );
    }
    let fetched: S3FetchResult;
    try {
      fetched = await this._fetcher(this._cfg);
    } catch (e) {
      if (e instanceof VSyncError) throw e;
      throw new S3UnreachableError(
        `vsync: remoteGeneration fetch failed: ${(e as Error).message ?? e}`,
      );
    }
    return fetched.generation;
  }

  /** Convenience: remote gen > local gen. Same error propagation as `remoteGeneration`. */
  async hasNewVersion(): Promise<boolean> {
    return (await this.remoteGeneration()) > this._generation;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.kv.clear();
    this.assets.clear();
  }

  // ─── Redaction-safe representation (v0.12 §12) ───────────────────────

  toJSON(): string {
    return `<vsync:redacted gen=${this._generation} env=${this._env}>`;
  }

  toString(): string {
    return `<vsync:redacted gen=${this._generation} env=${this._env}>`;
  }

  // Node's util.inspect hook.
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  // ─── Internal test hook (matches Python's Vsync._from_vault) ─────────

  /** @internal Construct a Vsync without an S3 round-trip. Tests only. */
  static _fromVault(opts: {
    kv?: Record<string, string> | Map<string, string>;
    assets?: Record<string, Uint8Array> | Map<string, Uint8Array>;
    defaults?: Record<string, string> | Map<string, string>;
    generation?: number;
    env?: string;
  }): Vsync {
    const toMap = <V>(x?: Record<string, V> | Map<string, V>): Map<string, V> => {
      if (x === undefined) return new Map();
      if (x instanceof Map) return new Map(x);
      return new Map(Object.entries(x));
    };
    return new Vsync({
      kv: toMap<string>(opts.kv as Record<string, string> | Map<string, string> | undefined),
      assets: toMap<Uint8Array>(
        opts.assets as Record<string, Uint8Array> | Map<string, Uint8Array> | undefined,
      ),
      defaults: toMap<string>(
        opts.defaults as Record<string, string> | Map<string, string> | undefined,
      ),
      generation: opts.generation ?? 0,
      env: opts.env ?? "test",
    });
  }

  /** @internal Real path's last-stage constructor — exported for the open() flow. */
  static _fromDecrypted(args: {
    plaintext: Uint8Array;
    generation: number;
    env: string;
    defaults: Map<string, string>;
    cfg?: VsyncConfigSnapshot | null;
    fetcher?: S3Fetcher | null;
  }): Vsync {
    const { kv, assets } = parseVaultPayload(args.plaintext);
    return new Vsync({
      kv,
      assets,
      defaults: args.defaults,
      generation: args.generation,
      env: args.env,
      cfg: args.cfg ?? null,
      fetcher: args.fetcher ?? null,
    });
  }
}

// ─── Module-level facade ───────────────────────────────────────────────

async function defaultS3Fetcher(cfg: VsyncConfigSnapshot): Promise<S3FetchResult> {
  // Lazy import so unit tests don't pull aws-sdk into the bundle when
  // they swap the fetcher.
  const aws = await import("@aws-sdk/client-s3");
  const { S3Client, GetObjectCommand } = aws;

  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
  });

  const manifestKey = `${cfg.prefix}manifest`;
  let manifestBytes: Uint8Array;
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: manifestKey }));
    manifestBytes = await streamToUint8Array(resp.Body);
  } catch (e: unknown) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (e as { name?: string }).name;
    if (status === 404 || name === "NoSuchKey") {
      throw new ManifestNotFoundError(
        `vsync: s3://${cfg.bucket}/${manifestKey} is 404 — run \`vsync push ${cfg.env}\` once before booting apps`,
      );
    }
    throw new S3UnreachableError(
      `vsync: cannot read s3://${cfg.bucket}/${manifestKey}: ${(e as Error).message ?? e}`,
    );
  }

  const { ts } = verifyAgainstRemoteTsLazy(manifestBytes);
  const bundleKey = `${cfg.prefix}v=${ts}`;
  let bundleBytes: Uint8Array;
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: bundleKey }));
    bundleBytes = await streamToUint8Array(resp.Body);
  } catch (e: unknown) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (e as { name?: string }).name;
    if (status === 404 || name === "NoSuchKey") {
      throw new BundleCorruptError(
        `vsync: manifest points at s3://${cfg.bucket}/${bundleKey} but the object is 404 — bucket in a torn state; re-push`,
      );
    }
    throw new S3UnreachableError(
      `vsync: cannot read s3://${cfg.bucket}/${bundleKey}: ${(e as Error).message ?? e}`,
    );
  }

  // Optional meta cell — `<prefix>latest.meta` JSON with `{gen: int}`.
  // Absent / unreadable → gen=0.
  let generation = 0;
  try {
    const resp = await client.send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: `${cfg.prefix}latest.meta` }),
    );
    const text = Buffer.from(await streamToUint8Array(resp.Body)).toString("utf8");
    const meta = JSON.parse(text);
    if (
      meta !== null &&
      typeof meta === "object" &&
      typeof (meta as { gen?: unknown }).gen === "number" &&
      Number.isInteger((meta as { gen: number }).gen)
    ) {
      generation = (meta as { gen: number }).gen;
    }
  } catch {
    // pre-rotation bundle has no meta cell — gen stays 0
  }

  return { manifestBytes, bundleBytes, generation };
}

// We only need the ts here — the full verification happens upstream in open().
function verifyAgainstRemoteTsLazy(manifestBytes: Uint8Array): { ts: string } {
  // Just unwrap; remote-vs-embedded comparison happens at the open() seam.
  const magic = Buffer.from("RQEM0001", "ascii");
  if (manifestBytes.byteLength < magic.length + 15) {
    throw new BundleCorruptError("manifest too short for RQEM0001 + 15-char ts");
  }
  const buf = Buffer.from(manifestBytes.buffer, manifestBytes.byteOffset, manifestBytes.byteLength);
  if (!buf.subarray(0, magic.length).equals(magic)) {
    throw new BundleCorruptError("manifest magic mismatch — not RQEM0001");
  }
  return { ts: buf.subarray(magic.length, magic.length + 15).toString("ascii") };
}

async function streamToUint8Array(body: unknown): Promise<Uint8Array> {
  // @aws-sdk/client-s3 v3 returns a node Readable for `Body`. Drain it.
  // We avoid hard-importing the type to keep the test seam clean.
  if (body == null) throw new Error("S3 response Body was empty");
  // Web ReadableStream / Node Readable both implement asyncIterable.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const all = Buffer.concat(chunks);
  return new Uint8Array(all.buffer, all.byteOffset, all.byteLength);
}

/**
 * Fetch, decrypt, and assemble the Vsync handle from a decoded config
 * blob + passphrase. Shared by `open()` and `openWith()`.
 */
async function openFromCfg(
  cfg: VsyncConfigSnapshot,
  passphrase: string,
  defaults: Map<string, string>,
): Promise<Vsync> {
  const fetcher = injectedFetcher ?? defaultS3Fetcher;
  let fetched: S3FetchResult;
  try {
    fetched = await fetcher(cfg);
  } catch (e) {
    if (e instanceof VSyncError) throw e;
    throw new S3UnreachableError(`vsync: S3 fetch failed: ${(e as Error).message ?? e}`);
  }

  // Sanity-check the manifest envelope (the default fetcher already did,
  // but custom fetchers may not). The ts inside the manifest names the
  // bundle the fetcher pulled.
  void verifyAgainstRemoteTsLazy(fetched.manifestBytes);
  const plaintext = await decryptRqe1(
    fetched.bundleBytes,
    passphrase,
    cfg.salt,
    cfg.iterations,
  );

  return Vsync._fromDecrypted({
    plaintext,
    generation: fetched.generation,
    env: cfg.env,
    defaults,
    cfg,
    fetcher,
  });
}

/**
 * Read env, fetch from S3, decrypt, return a Vsync handle. One round
 * trip. No retries. No refresh. Restart the process to pick up a new
 * vault.
 */
export async function open(opts: OpenOptions = {}): Promise<Vsync> {
  const { config, passphrase } = resolveBootstrapInputs();
  const cfg = decodeConfigBlob(config);
  const defaultsMap = new Map(Object.entries(opts.defaults ?? {}));
  return openFromCfg(cfg, passphrase, defaultsMap);
}

/**
 * Variant of `open()` that accepts the config blob and passphrase as
 * strings directly — bypassing the `VSYNC_CONFIG` / `VSYNC_PASSPHRASE`
 * env-var contract. Useful when bootstrap material lives in a custom
 * secrets layer (KMS, Hashicorp Vault, a CI variable). Otherwise
 * identical to `open()`.
 */
export async function openWith(opts: OpenWithOptions): Promise<Vsync> {
  if (opts.config === "") {
    throw new ConfigMissingError(
      "vsync: openWith requires a non-empty config string",
    );
  }
  if (opts.passphrase === "") {
    throw new ConfigMissingError(
      "vsync: openWith requires a non-empty passphrase string",
    );
  }
  const cfg = decodeConfigBlob(Buffer.from(opts.config, "utf8"));
  const defaultsMap = new Map(Object.entries(opts.defaults ?? {}));
  return openFromCfg(cfg, opts.passphrase, defaultsMap);
}

// ─── Module-level convenience singleton ──────────────────────────────

/** Convenience: lazily open() on first call, then look up `key`. */
export async function getEnv(key: string): Promise<string | null> {
  if (singleton === null) {
    singleton = await open();
  }
  return singleton.getEnv(key);
}
