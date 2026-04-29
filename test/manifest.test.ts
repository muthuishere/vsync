import { test, expect, describe } from "bun:test";
import { wrap, unwrap } from "../src/manifest";

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
