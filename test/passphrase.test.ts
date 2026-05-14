import { test, expect, describe } from "bun:test";
import {
  generatePassphrase,
  normalizePassphrase,
  PASSPHRASE_MIN_LEN,
} from "../src/passphrase";

describe("generatePassphrase", () => {
  test("default shape: 3 groups of 4 chars separated by hyphens", () => {
    const p = generatePassphrase();
    expect(p).toMatch(/^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/);
  });

  test("excludes visually confusable characters", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassphrase();
      expect(p.includes("0")).toBe(false);
      expect(p.includes("O")).toBe(false);
      expect(p.includes("1")).toBe(false);
      expect(p.includes("l")).toBe(false);
      expect(p.includes("I")).toBe(false);
    }
  });

  test("custom group count + size", () => {
    const p = generatePassphrase(4, 5);
    expect(p.split("-")).toHaveLength(4);
    for (const g of p.split("-")) {
      expect(g).toHaveLength(5);
    }
  });

  test("rejects nonsense args", () => {
    expect(() => generatePassphrase(0, 4)).toThrow();
    expect(() => generatePassphrase(3, 1)).toThrow();
  });

  test("two passphrases drawn back-to-back differ", () => {
    expect(generatePassphrase()).not.toBe(generatePassphrase());
  });
});

describe("normalizePassphrase", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizePassphrase("  abcd-1234-efgh  ")).toBe("abcd-1234-efgh");
  });

  test("rejects too-short input", () => {
    expect(() => normalizePassphrase("short")).toThrow(/at least/);
  });

  test("rejects empty/null input", () => {
    expect(() => normalizePassphrase("")).toThrow();
    // @ts-expect-error testing runtime guard
    expect(() => normalizePassphrase(undefined)).toThrow();
  });

  test("PASSPHRASE_MIN_LEN exported", () => {
    expect(PASSPHRASE_MIN_LEN).toBeGreaterThanOrEqual(8);
  });
});
