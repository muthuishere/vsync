import { test, expect, describe } from "bun:test";
import {
  wrap,
  unwrap,
  serializeManifestMeta,
  parseManifestMeta,
  type ManifestMeta,
} from "../src/manifest";

const TS = "20260429-103045";

describe("manifest", () => {
  test("wrap → unwrap roundtrips ts and payload", () => {
    const payload = new TextEncoder().encode("hello world");
    const w = wrap(TS, payload);
    const u = unwrap(w);
    expect(u.ts).toBe(TS);
    expect(new TextDecoder().decode(u.payload)).toBe("hello world");
  });

  test("wrap output starts with RQEM magic", () => {
    const w = wrap(TS, new Uint8Array([0]));
    expect(String.fromCharCode(w[0], w[1], w[2], w[3])).toBe("RQEM");
  });

  test("wrap rejects ts of wrong length", () => {
    expect(() => wrap("short", new Uint8Array([0]))).toThrow(/15/);
    expect(() => wrap("20260429-1030450", new Uint8Array([0]))).toThrow(/15/);
  });

  test("unwrap rejects payload without magic", () => {
    const bad = new Uint8Array(64); // zeros
    expect(() => unwrap(bad)).toThrow(/magic/);
  });

  test("unwrap rejects too-short payload", () => {
    const bad = new Uint8Array(8);
    expect(() => unwrap(bad)).toThrow(/too short/);
  });

  test("preserves binary payload with NUL bytes", () => {
    const payload = new Uint8Array([0, 1, 2, 0, 255, 0]);
    const w = wrap(TS, payload);
    const u = unwrap(w);
    expect(Array.from(u.payload)).toEqual(Array.from(payload));
  });
});

describe("manifest meta cell (v0.10)", () => {
  test("serialize → parse roundtrips gen/prev_gen/rotated_at", () => {
    const meta: ManifestMeta = {
      gen: 3,
      prev_gen: 2,
      rotated_at: "2026-05-23T10:00:00.000Z",
    };
    const json = serializeManifestMeta(meta);
    const parsed = parseManifestMeta(json);
    expect(parsed.gen).toBe(3);
    expect(parsed.prev_gen).toBe(2);
    expect(parsed.rotated_at).toBe("2026-05-23T10:00:00.000Z");
  });

  test("parseManifestMeta tolerates an empty/absent meta object (pre-0.10 bundle)", () => {
    // Empty object — no fields set.
    expect(parseManifestMeta("{}")).toEqual({});
    // Empty string treated as "no meta"; same as `{}`.
    expect(parseManifestMeta("")).toEqual({});
  });

  test("parseManifestMeta ignores unknown fields (forward compat)", () => {
    const json = JSON.stringify({
      gen: 1,
      future_field: "ignored",
      another: { nested: true },
    });
    const parsed = parseManifestMeta(json);
    expect(parsed.gen).toBe(1);
    expect((parsed as any).future_field).toBeUndefined();
  });

  test("serialize accepts a minimal meta (gen only)", () => {
    const json = serializeManifestMeta({ gen: 1 });
    const parsed = parseManifestMeta(json);
    expect(parsed.gen).toBe(1);
    expect(parsed.prev_gen).toBeUndefined();
    expect(parsed.rotated_at).toBeUndefined();
  });

  test("gen counter increments over repeated rotations (0 → 1 → 2 → …)", () => {
    let current: ManifestMeta = {};
    for (let i = 1; i <= 5; i++) {
      const prev = current.gen ?? 0;
      const next: ManifestMeta = {
        gen: prev + 1,
        prev_gen: prev,
        rotated_at: new Date().toISOString(),
      };
      const json = serializeManifestMeta(next);
      current = parseManifestMeta(json);
      expect(current.gen).toBe(i);
      expect(current.prev_gen).toBe(i - 1);
    }
  });

  test("parseManifestMeta rejects malformed JSON", () => {
    expect(() => parseManifestMeta("{not json")).toThrow();
  });

  test("parseManifestMeta rejects non-object payload", () => {
    expect(() => parseManifestMeta('"a string"')).toThrow(/object/);
    expect(() => parseManifestMeta("[1,2,3]")).toThrow(/object/);
  });

  test("rejects negative gen counter", () => {
    expect(() => parseManifestMeta('{"gen":-1}')).toThrow(/gen/);
  });

  test("rejects non-integer gen", () => {
    expect(() => parseManifestMeta('{"gen":1.5}')).toThrow(/gen/);
    expect(() => parseManifestMeta('{"gen":"1"}')).toThrow(/gen/);
  });
});
