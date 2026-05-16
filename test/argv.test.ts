import { test, expect, describe } from "bun:test";
import { parseArgs } from "../src/argv";

describe("parseArgs", () => {
  test("collects positional args", () => {
    expect(parseArgs(["a", "b", "c"])).toEqual({
      positional: ["a", "b", "c"],
      flags: {},
      lists: {},
    });
  });

  test("parses --key=value flags", () => {
    expect(parseArgs(["--prefix=VIDEO_AI_ENV", "LOCAL"])).toEqual({
      positional: ["LOCAL"],
      flags: { prefix: "VIDEO_AI_ENV" },
      lists: { prefix: ["VIDEO_AI_ENV"] },
    });
  });

  test("treats bare --key as boolean true", () => {
    expect(parseArgs(["--verbose", "x"])).toEqual({
      positional: ["x"],
      flags: { verbose: "true" },
      lists: { verbose: ["true"] },
    });
  });

  test("preserves flag order independence", () => {
    expect(parseArgs(["X", "--prefix=P", "Y"]).positional).toEqual(["X", "Y"]);
  });

  test("`--` makes everything after positional", () => {
    expect(parseArgs(["a", "--", "--not-a-flag", "b"])).toEqual({
      positional: ["a", "--not-a-flag", "b"],
      flags: {},
      lists: {},
    });
  });

  test("empty argv", () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {}, lists: {} });
  });

  describe("repeated flags", () => {
    test("flags keeps the last value (back-compat)", () => {
      const r = parseArgs(["--meta=k=v", "--meta=k2=v2"]);
      expect(r.flags.meta).toBe("k2=v2");
    });

    test("lists collects every occurrence in order", () => {
      const r = parseArgs(["--meta=k=v", "--meta=k2=v2", "--meta=k3=v3"]);
      expect(r.lists.meta).toEqual(["k=v", "k2=v2", "k3=v3"]);
    });

    test("lists records single-occurrence flags too", () => {
      const r = parseArgs(["--repo=acme"]);
      expect(r.lists.repo).toEqual(["acme"]);
      expect(r.flags.repo).toBe("acme");
    });

    test("flags and lists agree when there are no repeats", () => {
      const r = parseArgs(["--a=1", "--b=2"]);
      expect(r.flags).toEqual({ a: "1", b: "2" });
      expect(r.lists).toEqual({ a: ["1"], b: ["2"] });
    });
  });
});
