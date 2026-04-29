import { test, expect, describe } from "bun:test";
import { encodeGzipBase64, decodeGzipBase64 } from "../src/codec";

describe("codec", () => {
  test("encode → decode roundtrips a JSON object", () => {
    const obj = { a: 1, nested: { b: "hello", c: [1, 2, 3] }, n: null };
    const enc = encodeGzipBase64(JSON.stringify(obj));
    const dec = JSON.parse(decodeGzipBase64(enc));
    expect(dec).toEqual(obj);
  });

  test("encoded output is base64", () => {
    const enc = encodeGzipBase64('{"hello":"world"}');
    expect(enc).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("encode rejects non-JSON input", () => {
    expect(() => encodeGzipBase64("not json")).toThrow();
  });

  test("decode rejects garbage base64", () => {
    expect(() => decodeGzipBase64("###not-base64###")).toThrow();
  });

  test("decode rejects empty input", () => {
    expect(() => decodeGzipBase64("")).toThrow();
  });

  test("compression actually shrinks repetitive payloads", () => {
    const big = JSON.stringify({ data: "a".repeat(2000) });
    const enc = encodeGzipBase64(big);
    expect(enc.length).toBeLessThan(big.length / 5);
  });
});
