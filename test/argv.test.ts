import { test, expect, describe } from "bun:test";
import { parseArgs } from "../src/argv";

describe("parseArgs", () => {
  test("collects positional args", () => {
    expect(parseArgs(["a", "b", "c"])).toEqual({
      positional: ["a", "b", "c"],
      flags: {},
    });
  });

  test("parses --key=value flags", () => {
    expect(parseArgs(["--prefix=VIDEO_AI_ENV", "LOCAL"])).toEqual({
      positional: ["LOCAL"],
      flags: { prefix: "VIDEO_AI_ENV" },
    });
  });

  test("treats bare --key as boolean true", () => {
    expect(parseArgs(["--verbose", "x"])).toEqual({
      positional: ["x"],
      flags: { verbose: "true" },
    });
  });

  test("preserves flag order independence", () => {
    expect(parseArgs(["X", "--prefix=P", "Y"]).positional).toEqual(["X", "Y"]);
  });

  test("`--` makes everything after positional", () => {
    expect(parseArgs(["a", "--", "--not-a-flag", "b"])).toEqual({
      positional: ["a", "--not-a-flag", "b"],
      flags: {},
    });
  });

  test("empty argv", () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {} });
  });
});
