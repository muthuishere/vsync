import { describe, expect, test } from "vitest";
import { unwrapRqem0001, verifyAgainstRemoteTs } from "../src/manifest.js";
import { BundleCorruptError } from "../src/errors.js";

const MAGIC = Buffer.from("RQEM0001", "ascii");
const TS = "20260429-103045";

function buildManifest(ts: string, payload: Buffer | Uint8Array): Buffer {
  const tsBuf = Buffer.from(ts, "ascii");
  return Buffer.concat([MAGIC, tsBuf, Buffer.from(payload)]);
}

describe("unwrapRqem0001", () => {
  test("parses magic + 15-char ts + payload", () => {
    const payload = Buffer.from("hello", "utf8");
    const blob = buildManifest(TS, payload);
    const { ts, payload: out } = unwrapRqem0001(blob);
    expect(ts).toBe(TS);
    expect(Buffer.from(out).equals(payload)).toBe(true);
  });

  test("preserves binary payload (incl. NUL bytes)", () => {
    const payload = Buffer.from([0, 1, 2, 0, 255, 0]);
    const blob = buildManifest(TS, payload);
    const { payload: out } = unwrapRqem0001(blob);
    expect(Array.from(out)).toEqual(Array.from(payload));
  });

  test("rejects too-short input", () => {
    expect(() => unwrapRqem0001(new Uint8Array(8))).toThrow(BundleCorruptError);
    expect(() => unwrapRqem0001(new Uint8Array(8))).toThrow(/too short/i);
  });

  test("rejects missing magic", () => {
    const bad = Buffer.alloc(23, 0); // zeros, wrong magic
    expect(() => unwrapRqem0001(bad)).toThrow(BundleCorruptError);
    expect(() => unwrapRqem0001(bad)).toThrow(/magic/i);
  });

  test("zero-length payload is fine", () => {
    const blob = buildManifest(TS, Buffer.alloc(0));
    const { ts, payload } = unwrapRqem0001(blob);
    expect(ts).toBe(TS);
    expect(payload.byteLength).toBe(0);
  });
});

describe("verifyAgainstRemoteTs", () => {
  test("returns (ts, payload) when remote_ts matches", () => {
    const payload = Buffer.from([1, 2, 3]);
    const blob = buildManifest(TS, payload);
    const { ts, payload: out } = verifyAgainstRemoteTs(blob, TS);
    expect(ts).toBe(TS);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  test("throws BundleCorruptError on ts mismatch (anti-rollback)", () => {
    const blob = buildManifest(TS, Buffer.alloc(0));
    expect(() => verifyAgainstRemoteTs(blob, "20260501-091500")).toThrow(
      BundleCorruptError,
    );
    expect(() => verifyAgainstRemoteTs(blob, "20260501-091500")).toThrow(
      /rollback|mismatch|embedded/i,
    );
  });
});
