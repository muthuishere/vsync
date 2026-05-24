import { afterEach, describe, expect, test } from "vitest";
import { Vsync } from "../src/client.js";

const created: Vsync[] = [];

afterEach(async () => {
  for (const v of created.splice(0)) await v.close();
});

function fromVault(opts: Parameters<typeof Vsync._fromVault>[0]): Vsync {
  const v = Vsync._fromVault(opts);
  created.push(v);
  return v;
}

describe("Vsync.getAsContent — bytes only (v0.12 §6)", () => {
  test("returns raw asset bytes", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const v = fromVault({ assets: { "svc.json": bytes } });
    const out = v.getAsContent("svc.json");
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  test("falls back to kv (utf8-encoded) when name not in assets", () => {
    const v = fromVault({ kv: { CERT: "-----BEGIN CERT-----\n" } });
    const out = v.getAsContent("CERT");
    expect(Buffer.from(out).toString("utf8")).toBe("-----BEGIN CERT-----\n");
  });

  test("throws when name absent from both assets and kv", () => {
    const v = fromVault({});
    expect(() => v.getAsContent("nope")).toThrow();
  });

  test("is synchronous — returns a Uint8Array, not a Promise", () => {
    const v = fromVault({ assets: { x: new Uint8Array([1]) } });
    const result = v.getAsContent("x");
    // Type-level: getAsContent is sync. Runtime: not a thenable.
    expect(typeof (result as unknown as { then?: unknown }).then).toBe("undefined");
  });

  test("throws after close", async () => {
    const v = fromVault({ assets: { x: new Uint8Array([1]) } });
    await v.close();
    expect(() => v.getAsContent("x")).toThrow(/closed/i);
  });
});
