// Tests for scripts/generate-test-vectors.ts — the deterministic generator
// that populates docs/specs/test-vectors/.
//
// Two guarantees worth pinning:
//   1. Determinism — same inputs → same bytes. Two runs back-to-back must
//      produce identical files. If they don't, language ports can't trust
//      `git diff --quiet` after regen.
//   2. Spot-check correctness — for each category, at least one emitted
//      vector decodes cleanly using the existing CLI primitives.
//
// We invoke the generator against a throwaway output directory (NOT the
// real docs/specs/test-vectors/) so the test suite never mutates the
// committed corpus.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAllVectors } from "../scripts/generate-test-vectors";
import { decrypt } from "../src/crypto";
import { unwrap } from "../src/manifest";

const PBKDF2_TIMEOUT = 120000;
const FIXED_SHA = "deadbeefcafef00dba5eba110000000000000000";

let outA: string;
let outB: string;

beforeAll(() => {
  outA = mkdtempSync(join(tmpdir(), "vsync-vec-a-"));
  outB = mkdtempSync(join(tmpdir(), "vsync-vec-b-"));
});

afterAll(() => {
  rmSync(outA, { recursive: true, force: true });
  rmSync(outB, { recursive: true, force: true });
});

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      for (const child of readdirSync(p)) out.push(`${entry}/${child}`);
    }
  }
  return out.sort();
}

describe("scripts/generate-test-vectors", () => {
  test(
    "is deterministic — two runs produce identical bytes",
    async () => {
      await generateAllVectors({ outDir: outA, sha: FIXED_SHA });
      await generateAllVectors({ outDir: outB, sha: FIXED_SHA });

      const filesA = listFiles(outA);
      const filesB = listFiles(outB);
      expect(filesB).toEqual(filesA);

      for (const rel of filesA) {
        const a = readFileSync(join(outA, rel));
        const b = readFileSync(join(outB, rel));
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      }
    },
    PBKDF2_TIMEOUT,
  );

  test("emits all 7 categories", () => {
    const cats = readdirSync(outA).sort();
    expect(cats).toEqual([
      "asset-path",
      "config-blob",
      "error-taxonomy",
      "fallback-chain",
      "rqe1-decrypt",
      "rqe1-decrypt-error",
      "rqem0001-manifest",
    ]);
  });

  test("removes the example.* placeholders", () => {
    const files = listFiles(outA);
    expect(files.some((f) => f.endsWith("/example.bin"))).toBe(false);
    expect(files.some((f) => f.endsWith("/example.json"))).toBe(false);
  });

  test("every .json carries spec_version v0.12 and the supplied sha — no placeholder flag", () => {
    const jsons = listFiles(outA).filter((f) => f.endsWith(".json"));
    expect(jsons.length).toBeGreaterThan(0);
    for (const rel of jsons) {
      const raw = readFileSync(join(outA, rel), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      const obj = JSON.parse(raw);
      expect(obj.spec_version).toBe("v0.12");
      expect(obj.generated_by).toBe(`vsync@${FIXED_SHA}`);
      expect(obj.placeholder).toBeUndefined();
      expect(typeof obj.description).toBe("string");
      expect(typeof obj.category).toBe("string");
      expect(rel.startsWith(`${obj.category}/`)).toBe(true);
    }
  });

  // ---- spot checks: one decode per category ---------------------------

  test(
    "rqe1-decrypt: a vector round-trips through src/crypto.decrypt",
    async () => {
      const meta = JSON.parse(
        readFileSync(join(outA, "rqe1-decrypt", "hello-world.json"), "utf8"),
      );
      const bin = readFileSync(join(outA, "rqe1-decrypt", "hello-world.bin"));
      const pt = await decrypt(
        new Uint8Array(bin),
        meta.inputs.passphrase,
        meta.inputs.salt,
      );
      expect(Buffer.from(pt).toString("hex")).toBe(meta.expected.plaintext_hex);
      expect(new TextDecoder().decode(pt)).toBe(meta.expected.plaintext_utf8);
    },
    PBKDF2_TIMEOUT,
  );

  test(
    "rqe1-decrypt-error/wrong-passphrase: decrypt with stated wrong passphrase fails",
    async () => {
      const meta = JSON.parse(
        readFileSync(join(outA, "rqe1-decrypt-error", "wrong-passphrase.json"), "utf8"),
      );
      const bin = readFileSync(join(outA, "rqe1-decrypt-error", "wrong-passphrase.bin"));
      expect(meta.expected.error).toBe("WrongPassphraseError");
      await expect(
        decrypt(new Uint8Array(bin), meta.inputs.passphrase, meta.inputs.salt),
      ).rejects.toThrow();
    },
    PBKDF2_TIMEOUT,
  );

  test("rqem0001-manifest: a positive vector unwraps to the embedded ts", () => {
    const meta = JSON.parse(
      readFileSync(join(outA, "rqem0001-manifest", "positive-basic.json"), "utf8"),
    );
    const bin = readFileSync(join(outA, "rqem0001-manifest", "positive-basic.bin"));
    const { ts, payload } = unwrap(new Uint8Array(bin));
    expect(ts).toBe(meta.expected.embedded_ts);
    expect(ts).toBe(meta.inputs.remote_ts);
    expect(Buffer.from(payload).toString("hex")).toBe(meta.expected.payload_hex);
  });

  test("config-blob: a positive vector decodes back to the stated JSON", () => {
    const meta = JSON.parse(
      readFileSync(join(outA, "config-blob", "positive-aws.json"), "utf8"),
    );
    const bin = readFileSync(join(outA, "config-blob", "positive-aws.bin"));
    const text = new TextDecoder().decode(bin);
    expect(text.startsWith("vsync-cfg-v1:")).toBe(true);
    const b64 = text.slice("vsync-cfg-v1:".length);
    // base64url-no-pad — re-pad and translate alphabet so Buffer can parse.
    const std = b64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
    const gz = Buffer.from(padded, "base64");
    const json = Bun.gunzipSync(new Uint8Array(gz));
    const parsed = JSON.parse(new TextDecoder().decode(json));
    expect(parsed).toEqual(meta.expected.config_json);
  });

  test("fallback-chain: JSON-only vectors omit the .bin", () => {
    const files = readdirSync(join(outA, "fallback-chain")).sort();
    const bins = files.filter((f) => f.endsWith(".bin"));
    expect(bins.length).toBe(0);
    const jsons = files.filter((f) => f.endsWith(".json"));
    expect(jsons.length).toBeGreaterThanOrEqual(4);
    for (const j of jsons) {
      const meta = JSON.parse(readFileSync(join(outA, "fallback-chain", j), "utf8"));
      expect(meta.inputs.bin).toBeNull();
      expect(Array.isArray(meta.expected.results)).toBe(true);
    }
  });

  test("asset-path: .bin bytes equal expected.bytes_hex; mode is 0600", () => {
    const meta = JSON.parse(
      readFileSync(join(outA, "asset-path", "pem-key.json"), "utf8"),
    );
    const bin = readFileSync(join(outA, "asset-path", "pem-key.bin"));
    expect(Buffer.from(bin).toString("hex")).toBe(meta.expected.bytes_hex);
    expect(meta.expected.mode_octal).toBe("0600");
  });

  test("error-taxonomy: at least one vector per canonical error class", () => {
    const files = readdirSync(join(outA, "error-taxonomy")).filter((f) =>
      f.endsWith(".json"),
    );
    const errors = new Set<string>();
    for (const f of files) {
      const meta = JSON.parse(readFileSync(join(outA, "error-taxonomy", f), "utf8"));
      expect(typeof meta.expected.error).toBe("string");
      errors.add(meta.expected.error);
    }
    // The canonical classes named in v0.12 §11 must all appear.
    const canonical = [
      "ConfigMissingError",
      "ConfigUnsupportedVersionError",
      "S3UnreachableError",
      "ManifestNotFoundError",
      "WrongPassphraseError",
      "BundleCorruptError",
      "UnsupportedSpecVersionError",
    ];
    for (const c of canonical) expect(errors.has(c)).toBe(true);
  });

  test(
    "minimum vector counts per category match v0.11 expectations",
    () => {
      const counts: Record<string, number> = {};
      for (const cat of readdirSync(outA)) {
        counts[cat] = readdirSync(join(outA, cat)).filter((f) =>
          f.endsWith(".json"),
        ).length;
      }
      expect(counts["rqe1-decrypt"]).toBeGreaterThanOrEqual(3);
      expect(counts["rqe1-decrypt-error"]).toBeGreaterThanOrEqual(5);
      expect(counts["rqem0001-manifest"]).toBeGreaterThanOrEqual(4);
      expect(counts["config-blob"]).toBeGreaterThanOrEqual(6);
      expect(counts["fallback-chain"]).toBeGreaterThanOrEqual(4);
      expect(counts["asset-path"]).toBeGreaterThanOrEqual(2);
      expect(counts["error-taxonomy"]).toBeGreaterThanOrEqual(7);
    },
  );
});
