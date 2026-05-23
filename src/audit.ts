// audit.ts — append-only CSV audit log at s3://<bucket>/<repo>/<env>/audit.csv.
//
// Wire format: SPEC-v0.4 §4. Columns are locked; readers parse by header.
// Append protocol: SPEC-v0.4 §5 — ETag-conditional PUT with up to 3 retries
// on 412 Precondition Failed, silent skip on 403, throw on any other error.
//
// NOTE on Bun.S3Client conditional writes
// ----------------------------------------
// Bun 1.3.0's S3Client surface exposes ETag on `stat()` but does NOT accept
// `If-Match` / `If-None-Match` on `write()` — there is no field in
// `S3Options` for it (checked node_modules/bun-types/s3.d.ts). The spec
// assumed it did. So this module uses the Bun client for the *reads*
// (`stat`, `text`) and falls back to a minimal AWS SigV4-signed `fetch`
// PUT for the *write* — that's the only place conditional headers are
// needed. Reads are unchanged; only the append path is hand-signed.
//
// If a future Bun release adds `ifMatch` / `ifNoneMatch` to S3Options,
// `signedPut` can be deleted and the call swapped for `client.file(k).write`.

import * as os from "node:os";
import type { S3Credentials } from "./s3";

// ---------------------------------------------------------------------------
// Types

export type AuditAction = "pull" | "push" | "import" | "export" | "rotate";

export type AuditRow = {
  ts: string;
  action: AuditAction;
  version_ts: string;
  hostname: string;
  local_ip: string;
  os_user: string;
  git_email: string;
  vsync_version: string;
  bun_version: string;
  /** Serialized JSON object, or empty string when no meta was supplied. */
  meta: string;
};

/** CSV header — column order is locked. New columns go to the right. */
export const AUDIT_HEADER =
  "ts,action,version_ts,hostname,local_ip,os_user,git_email,vsync_version,bun_version,meta";

const META_SIZE_LIMIT_BYTES = 2048;

// ---------------------------------------------------------------------------
// Path helpers

/** S3 key for the audit log of a given (repo, env). env is lowercased. */
export function auditKey(repo: string, env: string): string {
  if (!repo) throw new Error("repo is required");
  if (!env) throw new Error("env is required");
  return `${repo}/${env.toLowerCase()}/audit.csv`;
}

// ---------------------------------------------------------------------------
// Row metadata gathering

/** Return the first non-loopback IPv4, else first non-loopback IPv6, else "". */
function firstUsableIp(): string {
  let ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  try {
    ifaces = os.networkInterfaces();
  } catch {
    return "";
  }
  let ipv6Fallback = "";
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const i of list) {
      if (i.internal) continue;
      if (i.family === "IPv4" || (i as any).family === 4) {
        return i.address;
      }
      if (!ipv6Fallback && (i.family === "IPv6" || (i as any).family === 6)) {
        ipv6Fallback = i.address;
      }
    }
  }
  return ipv6Fallback;
}

function safeHostname(): string {
  try {
    return os.hostname() ?? "";
  } catch {
    return "";
  }
}

/** Read `vsync_version` from package.json. Cached after first read. */
let _cachedVsyncVersion: string | null = null;
async function readVsyncVersion(): Promise<string> {
  if (_cachedVsyncVersion !== null) return _cachedVsyncVersion;
  try {
    // The package.json sits two levels up from this module at install time
    // (src/ → repo root). Use Bun.file which handles both source and bundle.
    const url = new URL("../package.json", import.meta.url);
    const text = await Bun.file(url.pathname).text();
    const parsed = JSON.parse(text);
    _cachedVsyncVersion = typeof parsed?.version === "string" ? parsed.version : "";
  } catch {
    _cachedVsyncVersion = "";
  }
  return _cachedVsyncVersion;
}

async function readGitEmail(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "config", "--get", "user.email"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return "";
    return (await new Response(proc.stdout).text()).trim();
  } catch {
    return "";
  }
}

/**
 * Build an AuditRow with every field populated except `meta` (caller fills
 * via buildMeta). `versionTs` is the bundle TS for pull/push; empty for
 * import/export.
 */
export async function gatherRowMetadata(
  action: AuditAction,
  versionTs: string = "",
): Promise<AuditRow> {
  return {
    ts: new Date().toISOString(),
    action,
    version_ts: versionTs,
    hostname: safeHostname(),
    local_ip: firstUsableIp(),
    os_user: process.env.USER ?? process.env.USERNAME ?? "",
    git_email: await readGitEmail(),
    vsync_version: await readVsyncVersion(),
    bun_version: process.versions.bun ?? "",
    meta: "",
  };
}

// ---------------------------------------------------------------------------
// Meta merging (spec §4.1)

export type BuildMetaInput = {
  /** Raw value of `$VSYNC_AUDIT_META` — a JSON object, or undefined. */
  envMeta?: string;
  /** Raw value of `$VSYNC_AUDIT_NOTE` — free text, or undefined. */
  envNote?: string;
  /** Repeated `--meta key=value` values, in order. */
  flagMetaList?: string[];
  /** Value of `--note=<text>`. */
  flagNote?: string;
};

export type BuildMetaResult = {
  /** Serialized JSON (or `""` when nothing was supplied). */
  json: string;
  /** Human-readable warnings to emit on stderr; empty when clean. */
  warnings: string[];
};

/**
 * Merge the four input sources per spec §4.1 priority order:
 *   envMeta < envNote < flagMetaList < flagNote
 * Last writer wins per key. Returns `""` when no source supplied anything.
 * Enforces the 2KB cap (over → returns `{"_truncated":true}` + warning).
 */
export function buildMeta(opts: BuildMetaInput): BuildMetaResult {
  const warnings: string[] = [];
  const merged: Record<string, string> = {};
  let touched = false;

  // 1. $VSYNC_AUDIT_META — must parse to a JSON object
  if (opts.envMeta !== undefined && opts.envMeta !== "") {
    try {
      const parsed = JSON.parse(opts.envMeta);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          merged[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
        touched = true;
      } else {
        warnings.push(
          "warning: $VSYNC_AUDIT_META is not a JSON object, ignoring",
        );
      }
    } catch (e) {
      warnings.push(
        `warning: $VSYNC_AUDIT_META is not valid JSON, ignoring (${(e as Error).message})`,
      );
    }
  }

  // 2. $VSYNC_AUDIT_NOTE — sugar for { note: <text> }
  if (opts.envNote !== undefined && opts.envNote !== "") {
    merged.note = opts.envNote;
    touched = true;
  }

  // 3. --meta key=value (repeatable)
  if (opts.flagMetaList && opts.flagMetaList.length > 0) {
    for (const raw of opts.flagMetaList) {
      const eq = raw.indexOf("=");
      if (eq === -1) {
        // Per spec §4.1: "--meta key (no =) is a usage error."
        // We surface this as a thrown error so the caller can exit cleanly
        // instead of silently logging.
        throw new Error(`--meta requires key=value form, got: ${raw}`);
      }
      const k = raw.slice(0, eq);
      const v = raw.slice(eq + 1);
      if (!k) throw new Error(`--meta requires a non-empty key, got: ${raw}`);
      merged[k] = v;
      touched = true;
    }
  }

  // 4. --note=<text> — sugar for `--meta note=<text>`, highest precedence
  if (opts.flagNote !== undefined && opts.flagNote !== "") {
    merged.note = opts.flagNote;
    touched = true;
  }

  if (!touched) return { json: "", warnings };

  const json = JSON.stringify(merged);
  if (Buffer.byteLength(json, "utf8") > META_SIZE_LIMIT_BYTES) {
    warnings.push(
      `warning: audit meta exceeded ${META_SIZE_LIMIT_BYTES} bytes, replaced with {"_truncated":true}`,
    );
    return { json: JSON.stringify({ _truncated: true }), warnings };
  }
  return { json, warnings };
}

// ---------------------------------------------------------------------------
// RFC 4180 CSV serialize / parse

function csvQuote(field: string): string {
  if (field === "") return "";
  if (/[",\n\r]/.test(field)) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

/** Serialize a row to a single CSV line (no trailing newline). */
export function rowToCsv(row: AuditRow): string {
  return [
    row.ts,
    row.action,
    row.version_ts,
    row.hostname,
    row.local_ip,
    row.os_user,
    row.git_email,
    row.vsync_version,
    row.bun_version,
    row.meta,
  ]
    .map(csvQuote)
    .join(",");
}

/**
 * Parse RFC 4180 CSV into rows (arrays of strings). Handles quoted fields,
 * doubled quotes, embedded `,` and newlines.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      // Eat \r\n as a single break
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      // Skip empty trailing rows (file ends with \n)
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Last field if file lacks trailing newline
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }
  return rows;
}

/** Parse a full CSV (header + rows) into AuditRow[]. */
export function parseAuditCsv(text: string): AuditRow[] {
  const grid = parseCsv(text);
  if (grid.length === 0) return [];
  const header = grid[0];
  const cols = [
    "ts",
    "action",
    "version_ts",
    "hostname",
    "local_ip",
    "os_user",
    "git_email",
    "vsync_version",
    "bun_version",
    "meta",
  ] as const;
  const idx: Record<string, number> = {};
  for (const c of cols) idx[c] = header.indexOf(c);
  const out: AuditRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const get = (k: (typeof cols)[number]) =>
      idx[k] >= 0 ? (row[idx[k]] ?? "") : "";
    out.push({
      ts: get("ts"),
      action: get("action") as AuditAction,
      version_ts: get("version_ts"),
      hostname: get("hostname"),
      local_ip: get("local_ip"),
      os_user: get("os_user"),
      git_email: get("git_email"),
      vsync_version: get("vsync_version"),
      bun_version: get("bun_version"),
      meta: get("meta"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Append protocol — abstract client surface (for tests + real Bun.S3Client)

/**
 * Minimal surface the audit code uses. Real impl is a thin wrapper around
 * Bun's S3 client + a SigV4 fetch for conditional PUT. Tests pass a fake.
 */
export interface AuditClient {
  /** Fetch object; null when 404. Returns text + ETag. */
  read(key: string): Promise<{ text: string; etag: string } | null>;
  /**
   * Conditional PUT. `condition.ifMatch` for "must match this ETag";
   * `condition.ifNoneMatch: "*"` for "object must not exist".
   * Throws an Error whose `.status` is the HTTP status on failure.
   */
  conditionalPut(
    key: string,
    body: string,
    condition: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<void>;
}

/** Error carrying an HTTP-style status code, for retry classification. */
export class AuditHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AuditHttpError";
    this.status = status;
  }
}

/**
 * Append a single row using the ETag-conditional protocol from spec §5.
 *
 *   1. Read existing CSV (if any) + its ETag.
 *   2. Build body (header+row on first write; existing+row on append).
 *   3. PUT with If-None-Match: * (new) or If-Match: <etag> (append).
 *   4. On 412 Precondition Failed → re-read, re-append. Up to 3 attempts.
 *   5. On 403 → silently skip (caller has no write permission).
 *   6. On any other failure → throw (the caller will catch + warn).
 */
export async function appendAuditRow(
  client: AuditClient,
  repo: string,
  env: string,
  row: AuditRow,
): Promise<void> {
  const key = auditKey(repo, env);
  const newLine = rowToCsv(row) + "\n";

  for (let attempt = 1; attempt <= 3; attempt++) {
    let existing: { text: string; etag: string } | null;
    try {
      existing = await client.read(key);
    } catch (e) {
      const status = (e as AuditHttpError).status;
      if (status === 403) return; // read denied → skip silently
      throw e;
    }

    let body: string;
    let condition: { ifMatch?: string; ifNoneMatch?: string };
    if (!existing) {
      body = AUDIT_HEADER + "\n" + newLine;
      condition = { ifNoneMatch: "*" };
    } else {
      // Ensure prior content ends with a newline so rows aren't joined.
      const prior = existing.text.endsWith("\n")
        ? existing.text
        : existing.text + "\n";
      body = prior + newLine;
      condition = { ifMatch: existing.etag };
    }

    try {
      await client.conditionalPut(key, body, condition);
      return; // success
    } catch (e) {
      const status = (e as AuditHttpError).status;
      if (status === 403) return; // write denied → skip silently
      if (status === 412 && attempt < 3) continue; // conflict → retry
      throw e;
    }
  }
  throw new AuditHttpError(
    412,
    "audit append: 3 conflicting writers in a row, giving up",
  );
}

/** Fetch + parse the audit log. Returns `[]` when the object doesn't exist. */
export async function readAuditLog(
  client: AuditClient,
  repo: string,
  env: string,
): Promise<AuditRow[]> {
  const key = auditKey(repo, env);
  const existing = await client.read(key);
  if (!existing) return [];
  return parseAuditCsv(existing.text);
}

// ---------------------------------------------------------------------------
// Pretty-print

/** Raw CSV passthrough (header + each row + trailing newline). */
export function formatAuditCsv(rows: AuditRow[]): string {
  const lines = [AUDIT_HEADER, ...rows.map(rowToCsv)];
  return lines.join("\n") + "\n";
}

type FormatOpts = { limit?: number; all?: boolean };

/**
 * Pretty table, newest first. Default limit 50; `--all` overrides. Unwraps
 * `meta.note` into its own column; remaining meta keys collapse into a
 * `k=v, k2=v2` summary in the `meta` column.
 */
export function formatAuditTable(rows: AuditRow[], opts: FormatOpts = {}): string {
  if (rows.length === 0) return "(no rows)";
  const limit = opts.all ? rows.length : (opts.limit ?? 50);
  // Newest first — `ts` is ISO 8601, so lexical sort works.
  const sorted = [...rows].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const shown = sorted.slice(0, limit);

  type Display = {
    ts: string;
    action: string;
    version_ts: string;
    user: string;
    host: string;
    note: string;
    meta: string;
  };
  const display: Display[] = shown.map((r) => {
    const { note, rest } = splitNote(r.meta);
    return {
      ts: r.ts,
      action: r.action,
      version_ts: r.version_ts,
      user: r.os_user || r.git_email,
      host: r.hostname || r.local_ip,
      note,
      meta: rest,
    };
  });

  const cols: { key: keyof Display; label: string }[] = [
    { key: "ts", label: "TS" },
    { key: "action", label: "ACTION" },
    { key: "version_ts", label: "VERSION" },
    { key: "user", label: "USER" },
    { key: "host", label: "HOST" },
    { key: "note", label: "NOTE" },
    { key: "meta", label: "META" },
  ];
  const widths: Record<string, number> = {};
  for (const c of cols) {
    widths[c.key] = c.label.length;
    for (const d of display) widths[c.key] = Math.max(widths[c.key], d[c.key].length);
  }
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const headerLine = cols.map((c) => pad(c.label, widths[c.key])).join("  ");
  const sep = cols.map((c) => "-".repeat(widths[c.key])).join("  ");
  const bodyLines = display.map((d) =>
    cols.map((c) => pad(d[c.key], widths[c.key])).join("  "),
  );
  const omitted = rows.length - shown.length;
  const footer =
    omitted > 0
      ? `\n(${omitted} older row${omitted === 1 ? "" : "s"} not shown; pass --all to see everything)`
      : "";
  return [headerLine, sep, ...bodyLines].join("\n") + footer;
}

function splitNote(metaCell: string): { note: string; rest: string } {
  if (!metaCell) return { note: "", rest: "" };
  let obj: unknown;
  try {
    obj = JSON.parse(metaCell);
  } catch {
    return { note: "", rest: metaCell };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { note: "", rest: metaCell };
  }
  const o = obj as Record<string, unknown>;
  const note = typeof o.note === "string" ? o.note : "";
  const rest = Object.entries(o)
    .filter(([k]) => k !== "note")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return { note, rest };
}

// ---------------------------------------------------------------------------
// Real AuditClient implementation — Bun.S3Client reads + SigV4 fetch PUT

/**
 * Build a real AuditClient backed by Bun.S3Client (reads) and a hand-signed
 * `fetch` PUT (writes — needed for If-Match / If-None-Match which Bun's
 * S3Options doesn't expose as of 1.3.0).
 */
export function makeAuditClient(creds: S3Credentials): AuditClient {
  return {
    async read(key: string) {
      const client = makeBunS3(creds);
      const f = client.file(key);
      let etag: string;
      try {
        const stat = await f.stat();
        etag = stat.etag;
      } catch (e: any) {
        // Bun throws on 404; detect by name/status.
        if (is404(e)) return null;
        throw classify(e);
      }
      const text = await f.text();
      return { text, etag };
    },
    async conditionalPut(key, body, condition) {
      await sigv4Put(creds, key, body, condition);
    },
  };
}

function makeBunS3(creds: S3Credentials): Bun.S3Client {
  const protocol = creds.useSsl ? "https://" : "http://";
  const endpoint = creds.endpoint.startsWith("http")
    ? creds.endpoint
    : protocol + creds.endpoint;
  return new Bun.S3Client({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: creds.region,
    bucket: creds.bucket,
    endpoint,
  });
}

function is404(e: any): boolean {
  if (!e) return false;
  const msg = String(e?.message ?? e);
  const code = (e as any).code ?? (e as any).status;
  if (code === 404 || code === "NoSuchKey") return true;
  return /NoSuchKey|not found|404|does not exist/i.test(msg);
}

function classify(e: any): Error {
  const msg = String(e?.message ?? e);
  const m = msg.match(/\b(40[0-9]|41[0-9]|42[0-9]|5\d\d)\b/);
  if (m) return new AuditHttpError(parseInt(m[1], 10), msg);
  return e instanceof Error ? e : new Error(msg);
}

// --- SigV4 PUT (audit.csv only) -------------------------------------------

async function sigv4Put(
  creds: S3Credentials,
  key: string,
  body: string,
  condition: { ifMatch?: string; ifNoneMatch?: string },
): Promise<void> {
  const protocol = creds.useSsl ? "https" : "http";
  // Endpoint may be host-only or full URL — normalize to a base URL.
  const baseRaw = creds.endpoint.startsWith("http")
    ? creds.endpoint
    : `${protocol}://${creds.endpoint}`;
  const base = new URL(baseRaw);

  // path-style: <endpoint>/<bucket>/<key>
  const url = new URL(
    `/${creds.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`,
    base,
  );

  const now = new Date();
  const amzDate = isoBasic(now); // 20260516T012233Z
  const dateStamp = amzDate.slice(0, 8); // 20260516

  const bodyBytes = new TextEncoder().encode(body);
  const payloadHash = await sha256Hex(bodyBytes);

  const headers: Record<string, string> = {
    host: url.host,
    "content-type": "text/csv",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (condition.ifMatch) {
    // Strip surrounding quotes — Ceph RGW (Hetzner Object Storage) rejects
    // the quoted form with 412 even when the ETag matches. AWS S3 and MinIO
    // accept either. Bun.S3Client returns ETags pre-quoted, so we strip.
    headers["if-match"] = condition.ifMatch.replace(/^"|"$/g, "");
  }
  if (condition.ifNoneMatch) headers["if-none-match"] = condition.ifNoneMatch;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders =
    signedHeaderNames.map((n) => `${n}:${headers[n].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    "PUT",
    url.pathname,
    "", // canonical querystring (none)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const region = creds.region;
  const service = "s3";
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");

  const kDate = await hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = bytesToHex(await hmac(kSigning, stringToSign));

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const fetchHeaders: Record<string, string> = { ...headers, authorization: authHeader };

  const resp = await fetch(url.toString(), {
    method: "PUT",
    headers: fetchHeaders,
    body: bodyBytes,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new AuditHttpError(resp.status, `S3 PUT ${resp.status}: ${text || resp.statusText}`);
  }
}

function isoBasic(d: Date): string {
  // 2026-05-16T01:22:33.123Z → 20260516T012233Z
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(buf));
}

async function hmac(
  key: string | Uint8Array,
  msg: string,
): Promise<Uint8Array> {
  const keyBytes =
    typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(msg),
  );
  return new Uint8Array(sig);
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
