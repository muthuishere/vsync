import { describe, expect, test } from "bun:test";
import { HANDLERS, type TargetName } from "../../src/synctargets";

describe("HANDLERS registry", () => {
  test("contains exactly the 5 expected targets", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([
      "aws",
      "azure",
      "gcp",
      "gh",
      "vault",
    ]);
  });

  test("each handler exposes name + bin matching its key", () => {
    for (const [key, h] of Object.entries(HANDLERS)) {
      expect(h.name).toBe(key);
      expect(typeof h.bin).toBe("string");
      expect(h.bin.length).toBeGreaterThan(0);
    }
  });

  test("each handler implements the interface", () => {
    for (const h of Object.values(HANDLERS)) {
      expect(typeof h.banner).toBe("function");
      expect(typeof h.resolveRouting).toBe("function");
      expect(typeof h.runSync).toBe("function");
    }
  });

  test("TargetName enumerates the 5 keys at the type level", () => {
    // Compile-time assertion via exhaustive switch.
    const seen: Record<TargetName, true> = {
      gh: true,
      gcp: true,
      aws: true,
      azure: true,
      vault: true,
    };
    expect(Object.keys(seen).length).toBe(5);
  });
});
