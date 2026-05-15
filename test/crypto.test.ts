import { test, expect, describe } from "bun:test";
import { encrypt, decrypt } from "../src/crypto";

// PBKDF2 with 600k iterations is intentionally slow (~1-2s per derivation
// on M-series Macs). Tests that perform 2+ derivations under concurrent
// suite load can blow Bun's default 5s test timeout — bump to 15s on
// every PBKDF2-bound test in this file.
const PBKDF2_TIMEOUT = 15000;

describe("crypto", () => {
  test("encrypt → decrypt roundtrips bytes", async () => {
    const data = new TextEncoder().encode("hello world");
    const enc = await encrypt(data, "password", "salt");
    const dec = await decrypt(enc, "password", "salt");
    expect(new TextDecoder().decode(dec)).toBe("hello world");
  }, PBKDF2_TIMEOUT);

  test("encrypted output starts with RQE1 magic", async () => {
    const enc = await encrypt(new TextEncoder().encode("x"), "p", "s");
    expect(enc[0]).toBe(0x52); // R
    expect(enc[1]).toBe(0x51); // Q
    expect(enc[2]).toBe(0x45); // E
    expect(enc[3]).toBe(0x31); // 1
  }, PBKDF2_TIMEOUT);

  test("each encryption uses a fresh random IV", async () => {
    const data = new TextEncoder().encode("same input both times");
    const a = await encrypt(data, "p", "s");
    const b = await encrypt(data, "p", "s");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  }, PBKDF2_TIMEOUT);

  test("decrypt with wrong password fails", async () => {
    const enc = await encrypt(new TextEncoder().encode("secret"), "right", "salt");
    expect(decrypt(enc, "wrong", "salt")).rejects.toThrow();
  }, PBKDF2_TIMEOUT);

  test("decrypt with wrong salt fails", async () => {
    const enc = await encrypt(new TextEncoder().encode("secret"), "pass", "salt-a");
    expect(decrypt(enc, "pass", "salt-b")).rejects.toThrow();
  }, PBKDF2_TIMEOUT);

  test("decrypt rejects payload without RQE1 magic", async () => {
    const bad = new Uint8Array(64); // zeros
    expect(decrypt(bad, "p", "s")).rejects.toThrow(/magic/);
  }, PBKDF2_TIMEOUT);

  test("decrypt rejects too-short payload", async () => {
    const bad = new Uint8Array(4);
    expect(decrypt(bad, "p", "s")).rejects.toThrow(/too short/);
  });

  test("handles binary data with NUL bytes", async () => {
    const data = new Uint8Array([0, 1, 2, 0, 255, 0]);
    const enc = await encrypt(data, "p", "s");
    const dec = await decrypt(enc, "p", "s");
    expect(Array.from(dec)).toEqual(Array.from(data));
  }, PBKDF2_TIMEOUT);
});
