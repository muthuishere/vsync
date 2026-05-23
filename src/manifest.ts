// Plaintext manifest bound into the encrypted bundle. Lets the pull side
// verify that the bundle was actually sealed at the timestamp `latest`
// claims, so an attacker with bucket-write but no encryption key can't
// repoint `latest` at a renamed copy of an older version.
//
// Layout (before encryption):
//   bytes 0..7   — magic "RQEM0001"
//   bytes 8..22  — 15-byte timestamp string "YYYYMMDD-HHmmss"
//   bytes 23..N  — original payload (the zip bytes)

const MAGIC = new TextEncoder().encode("RQEM0001");
const TS_LEN = 15;
const HEADER_LEN = MAGIC.length + TS_LEN; // 23

export function wrap(ts: string, payload: Uint8Array): Uint8Array {
  if (ts.length !== TS_LEN) {
    throw new Error(`manifest ts must be ${TS_LEN} chars (got ${ts.length})`);
  }
  const out = new Uint8Array(HEADER_LEN + payload.byteLength);
  out.set(MAGIC, 0);
  out.set(new TextEncoder().encode(ts), MAGIC.length);
  out.set(payload, HEADER_LEN);
  return out;
}

export function unwrap(blob: Uint8Array): { ts: string; payload: Uint8Array } {
  if (blob.byteLength < HEADER_LEN) {
    throw new Error("manifest too short");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) {
      throw new Error("invalid manifest magic — not an RQEM0001 bundle");
    }
  }
  const ts = new TextDecoder().decode(blob.slice(MAGIC.length, HEADER_LEN));
  const payload = blob.slice(HEADER_LEN);
  return { ts, payload };
}

// ─── Manifest meta cell (v0.10) ─────────────────────────────────────────
//
// The meta cell is a small JSON object describing the rotation state of a
// bundle. It sits alongside the bundle on S3 (e.g. at `<prefix>latest.meta`)
// and is read by `vsync rotate-passphrase` to compute the next `gen`
// counter. Old readers ignore it (the meta cell is a separate S3 object,
// not part of the RQEM0001 wire envelope). Pre-0.10 bundles have no meta
// cell — callers treat that as `gen = 0`.
//
// Forward-compat: unknown JSON fields are dropped on parse, so v0.11+ can
// add fields without breaking v0.10 readers.

/** Manifest meta cell. All fields optional — a pre-0.10 bundle has `{}`. */
export type ManifestMeta = {
  /** Monotonic rotation counter. 0 = never rotated. */
  gen?: number;
  /** Previous `gen`. Always `gen - 1` on rotation; absent on a fresh push. */
  prev_gen?: number;
  /** ISO 8601 timestamp of the rotation that produced this meta. */
  rotated_at?: string;
};

/** Serialise a manifest meta cell to JSON. */
export function serializeManifestMeta(meta: ManifestMeta): string {
  validateManifestMeta(meta);
  const out: Record<string, unknown> = {};
  if (meta.gen !== undefined) out.gen = meta.gen;
  if (meta.prev_gen !== undefined) out.prev_gen = meta.prev_gen;
  if (meta.rotated_at !== undefined) out.rotated_at = meta.rotated_at;
  return JSON.stringify(out);
}

/**
 * Parse a manifest meta cell JSON. Empty string → `{}` (no meta cell on
 * S3 yet, i.e. pre-0.10 bundle). Unknown fields are dropped. Throws on
 * malformed JSON, non-object payload, or a value out of the documented
 * shape (e.g. non-integer / negative `gen`).
 */
export function parseManifestMeta(json: string): ManifestMeta {
  if (!json || json.trim() === "") return {};
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("manifest meta: not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const out: ManifestMeta = {};
  if (obj.gen !== undefined) {
    if (typeof obj.gen !== "number" || !Number.isInteger(obj.gen) || obj.gen < 0) {
      throw new Error("manifest meta: gen must be a non-negative integer");
    }
    out.gen = obj.gen;
  }
  if (obj.prev_gen !== undefined) {
    if (
      typeof obj.prev_gen !== "number" ||
      !Number.isInteger(obj.prev_gen) ||
      obj.prev_gen < 0
    ) {
      throw new Error("manifest meta: prev_gen must be a non-negative integer");
    }
    out.prev_gen = obj.prev_gen;
  }
  if (obj.rotated_at !== undefined) {
    if (typeof obj.rotated_at !== "string") {
      throw new Error("manifest meta: rotated_at must be a string");
    }
    out.rotated_at = obj.rotated_at;
  }
  return out;
}

function validateManifestMeta(meta: ManifestMeta): void {
  if (meta.gen !== undefined) {
    if (!Number.isInteger(meta.gen) || meta.gen < 0) {
      throw new Error("manifest meta: gen must be a non-negative integer");
    }
  }
  if (meta.prev_gen !== undefined) {
    if (!Number.isInteger(meta.prev_gen) || meta.prev_gen < 0) {
      throw new Error("manifest meta: prev_gen must be a non-negative integer");
    }
  }
  if (meta.rotated_at !== undefined && typeof meta.rotated_at !== "string") {
    throw new Error("manifest meta: rotated_at must be a string");
  }
}
