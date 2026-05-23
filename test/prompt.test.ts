import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { askText } from "../src/prompt";

describe("askText", () => {
  let originalPrompt: unknown;

  beforeEach(() => {
    originalPrompt = (globalThis as any).prompt;
  });

  afterEach(() => {
    (globalThis as any).prompt = originalPrompt;
  });

  test("returns default when prompt() returns null and a default is provided", () => {
    (globalThis as any).prompt = () => null;
    expect(askText("Endpoint", "hel1.your-objectstorage.com")).toBe(
      "hel1.your-objectstorage.com",
    );
  });

  test("returns default when prompt() returns undefined and a default is provided", () => {
    (globalThis as any).prompt = () => undefined;
    expect(askText("Endpoint", "hel1.your-objectstorage.com")).toBe(
      "hel1.your-objectstorage.com",
    );
  });

  test("returns default when prompt() returns empty string and a default is provided", () => {
    (globalThis as any).prompt = () => "";
    expect(askText("Endpoint", "hel1.your-objectstorage.com")).toBe(
      "hel1.your-objectstorage.com",
    );
  });

  test("returns default when prompt() returns whitespace and a default is provided", () => {
    (globalThis as any).prompt = () => "   ";
    expect(askText("Endpoint", "hel1.your-objectstorage.com")).toBe(
      "hel1.your-objectstorage.com",
    );
  });

  test("returns the entered value when prompt() returns text", () => {
    (globalThis as any).prompt = () => "s3.amazonaws.com";
    expect(askText("Endpoint", "hel1.your-objectstorage.com")).toBe(
      "s3.amazonaws.com",
    );
  });

  test("trims the entered value", () => {
    (globalThis as any).prompt = () => "  s3.amazonaws.com  ";
    expect(askText("Endpoint")).toBe("s3.amazonaws.com");
  });

  test("throws when prompt() returns null AND no default is provided", () => {
    (globalThis as any).prompt = () => null;
    expect(() => askText("Endpoint")).toThrow("aborted (no input)");
  });

  test("returns empty string when prompt() returns empty string and no default is provided", () => {
    (globalThis as any).prompt = () => "";
    expect(askText("Endpoint")).toBe("");
  });
});
