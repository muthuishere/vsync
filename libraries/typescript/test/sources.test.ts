import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBootstrapInputs } from "../src/sources.js";
import { ConfigMissingError } from "../src/errors.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vsync-sources-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFile(name: string, content: string, mode: number = 0o600): string {
  const p = join(tmp, name);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

describe("resolveBootstrapInputs — env-direct", () => {
  test("env vars set on both → returns ({config bytes}, {passphrase string})", () => {
    const env = {
      VSYNC_CONFIG: "vsync-cfg-v1:aaaa",
      VSYNC_PASSPHRASE: "the-passphrase",
    };
    const { config, passphrase } = resolveBootstrapInputs(env);
    expect(Buffer.from(config).toString("utf8")).toBe("vsync-cfg-v1:aaaa");
    expect(passphrase).toBe("the-passphrase");
  });

  test("env passphrase verbatim — leading space is preserved", () => {
    const env = {
      VSYNC_CONFIG: "x",
      VSYNC_PASSPHRASE: " leading-space-on-purpose",
    };
    const { passphrase } = resolveBootstrapInputs(env);
    expect(passphrase).toBe(" leading-space-on-purpose");
  });

  test("missing VSYNC_CONFIG → ConfigMissingError", () => {
    expect(() => resolveBootstrapInputs({ VSYNC_PASSPHRASE: "x" })).toThrow(
      ConfigMissingError,
    );
    expect(() => resolveBootstrapInputs({ VSYNC_PASSPHRASE: "x" })).toThrow(
      /VSYNC_CONFIG/,
    );
  });

  test("missing VSYNC_PASSPHRASE → ConfigMissingError", () => {
    expect(() => resolveBootstrapInputs({ VSYNC_CONFIG: "x" })).toThrow(
      ConfigMissingError,
    );
    expect(() => resolveBootstrapInputs({ VSYNC_CONFIG: "x" })).toThrow(
      /VSYNC_PASSPHRASE/,
    );
  });

  test("both missing → ConfigMissingError on the config first", () => {
    expect(() => resolveBootstrapInputs({})).toThrow(ConfigMissingError);
  });
});

describe("resolveBootstrapInputs — _FILE variant", () => {
  test("VSYNC_CONFIG_FILE wins over VSYNC_CONFIG when both set", () => {
    const path = writeFile("config", "vsync-cfg-v1:from-file\n");
    const env = {
      VSYNC_CONFIG: "vsync-cfg-v1:from-env",
      VSYNC_CONFIG_FILE: path,
      VSYNC_PASSPHRASE: "p",
    };
    const { config } = resolveBootstrapInputs(env);
    // Trailing newline stripped per spec.
    expect(Buffer.from(config).toString("utf8")).toBe("vsync-cfg-v1:from-file");
  });

  test("VSYNC_PASSPHRASE_FILE wins; trailing whitespace stripped", () => {
    const path = writeFile("pp", "secret-pass\n");
    const env = {
      VSYNC_CONFIG: "x",
      VSYNC_PASSPHRASE: "from-env",
      VSYNC_PASSPHRASE_FILE: path,
    };
    const { passphrase } = resolveBootstrapInputs(env);
    expect(passphrase).toBe("secret-pass");
  });

  test("file content with leading space is preserved (only trailing stripped)", () => {
    const path = writeFile("pp", " starts-with-space\n\n");
    const env = { VSYNC_CONFIG: "x", VSYNC_PASSPHRASE_FILE: path };
    const { passphrase } = resolveBootstrapInputs(env);
    expect(passphrase).toBe(" starts-with-space");
  });

  test("file does not exist → ConfigMissingError", () => {
    const path = join(tmp, "does-not-exist");
    expect(() =>
      resolveBootstrapInputs({ VSYNC_CONFIG_FILE: path, VSYNC_PASSPHRASE: "p" }),
    ).toThrow(ConfigMissingError);
  });

  test("mixing env config + file passphrase works (resolved per-variable)", () => {
    const path = writeFile("pp", "filepass");
    const env = {
      VSYNC_CONFIG: "vsync-cfg-v1:from-env",
      VSYNC_PASSPHRASE_FILE: path,
    };
    const { config, passphrase } = resolveBootstrapInputs(env);
    expect(Buffer.from(config).toString("utf8")).toBe("vsync-cfg-v1:from-env");
    expect(passphrase).toBe("filepass");
  });
});

describe("resolveBootstrapInputs — file permission policy (v0.12 §13)", () => {
  test("0600 — read silently, no warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const path = writeFile("config", "x", 0o600);
      resolveBootstrapInputs({ VSYNC_CONFIG_FILE: path, VSYNC_PASSPHRASE: "p" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("0644 — read but warn to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const path = writeFile("config", "x", 0o644);
      resolveBootstrapInputs({ VSYNC_CONFIG_FILE: path, VSYNC_PASSPHRASE: "p" });
      const calls = spy.mock.calls.flat().join(" ");
      expect(calls).toMatch(/world|group|readable|narrow|0600/i);
    } finally {
      spy.mockRestore();
    }
  });

  test("0666 (world-writable) — refuse → ConfigMissingError", () => {
    const path = writeFile("config", "x", 0o666);
    expect(() =>
      resolveBootstrapInputs({ VSYNC_CONFIG_FILE: path, VSYNC_PASSPHRASE: "p" }),
    ).toThrow(ConfigMissingError);
    expect(() =>
      resolveBootstrapInputs({ VSYNC_CONFIG_FILE: path, VSYNC_PASSPHRASE: "p" }),
    ).toThrow(/world.writable|0666|narrow/i);
  });
});

describe("resolveBootstrapInputs — env fallback to process.env", () => {
  test("with no env arg, reads process.env", () => {
    const orig = {
      VSYNC_CONFIG: process.env.VSYNC_CONFIG,
      VSYNC_PASSPHRASE: process.env.VSYNC_PASSPHRASE,
    };
    try {
      process.env.VSYNC_CONFIG = "vsync-cfg-v1:from-proc";
      process.env.VSYNC_PASSPHRASE = "proc-pass";
      const { config, passphrase } = resolveBootstrapInputs();
      expect(Buffer.from(config).toString("utf8")).toBe("vsync-cfg-v1:from-proc");
      expect(passphrase).toBe("proc-pass");
    } finally {
      if (orig.VSYNC_CONFIG === undefined) delete process.env.VSYNC_CONFIG;
      else process.env.VSYNC_CONFIG = orig.VSYNC_CONFIG;
      if (orig.VSYNC_PASSPHRASE === undefined) delete process.env.VSYNC_PASSPHRASE;
      else process.env.VSYNC_PASSPHRASE = orig.VSYNC_PASSPHRASE;
    }
  });
});
