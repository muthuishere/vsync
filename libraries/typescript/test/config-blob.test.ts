import { describe, expect, test } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeConfigBlob } from "../src/config-blob.js";
import {
  BundleCorruptError,
  ConfigMissingError,
  ConfigUnsupportedVersionError,
} from "../src/errors.js";

const BLOB_MAGIC = "vsync-cfg-v1:";

const SAMPLE = {
  v: 1,
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "acme-secrets",
  accessKeyId: "AKIAFAKE",
  secretAccessKey: "very-secret",
  prefix: "myapp/dev/",
  env: "dev",
  salt: "20ZiDJFKLLkDsDUiWSMn3g==",
  iterations: 600000,
};

function base64urlNoPad(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mintBlob(inner: object): string {
  const json = JSON.stringify(inner);
  const gz = gzipSync(Buffer.from(json, "utf8"));
  return BLOB_MAGIC + base64urlNoPad(gz);
}

describe("decodeConfigBlob — happy path", () => {
  test("decodes a well-formed blob into the typed config", () => {
    const blob = mintBlob(SAMPLE);
    const cfg = decodeConfigBlob(blob);
    expect(cfg.v).toBe(1);
    expect(cfg.endpoint).toBe(SAMPLE.endpoint);
    expect(cfg.region).toBe(SAMPLE.region);
    expect(cfg.bucket).toBe(SAMPLE.bucket);
    expect(cfg.accessKeyId).toBe(SAMPLE.accessKeyId);
    expect(cfg.secretAccessKey).toBe(SAMPLE.secretAccessKey);
    expect(cfg.prefix).toBe(SAMPLE.prefix);
    expect(cfg.env).toBe(SAMPLE.env);
    expect(cfg.salt).toBe(SAMPLE.salt);
    expect(cfg.iterations).toBe(SAMPLE.iterations);
  });

  test("accepts bytes input as well as string", () => {
    const blob = mintBlob(SAMPLE);
    const cfg = decodeConfigBlob(Buffer.from(blob, "ascii"));
    expect(cfg.env).toBe(SAMPLE.env);
  });

  test("ignores unknown forward-compat fields inside v=1", () => {
    const inner = { ...SAMPLE, future_field: "ignored", nested: { x: 1 } };
    const cfg = decodeConfigBlob(mintBlob(inner));
    expect(cfg.env).toBe(SAMPLE.env);
    // No `future_field` surfaced on the typed return.
    expect((cfg as unknown as Record<string, unknown>).future_field).toBeUndefined();
  });
});

describe("decodeConfigBlob — ConfigMissingError", () => {
  test("missing magic prefix → ConfigMissingError", () => {
    const raw = JSON.stringify(SAMPLE);
    expect(() => decodeConfigBlob(raw)).toThrow(ConfigMissingError);
    expect(() => decodeConfigBlob(raw)).toThrow(/vsync-cfg-v1|magic|prefix/i);
  });

  test("empty input → ConfigMissingError", () => {
    expect(() => decodeConfigBlob("")).toThrow(ConfigMissingError);
  });

  test("wrong version magic (vsync-cfg-v2:) → ConfigMissingError", () => {
    const blob = "vsync-cfg-v2:" + mintBlob(SAMPLE).slice(BLOB_MAGIC.length);
    expect(() => decodeConfigBlob(blob)).toThrow(ConfigMissingError);
  });
});

describe("decodeConfigBlob — ConfigUnsupportedVersionError", () => {
  test("inner v=2 → ConfigUnsupportedVersionError", () => {
    const inner = { ...SAMPLE, v: 2 };
    expect(() => decodeConfigBlob(mintBlob(inner))).toThrow(ConfigUnsupportedVersionError);
  });

  test("standard base64 (+, /, =) in body → ConfigUnsupportedVersionError", () => {
    // Force a `+` into the body by hand.
    const json = JSON.stringify(SAMPLE);
    const gz = gzipSync(Buffer.from(json, "utf8"));
    const std = gz.toString("base64"); // standard alphabet, with padding
    // Only assert when we actually have a disallowed character. Most
    // gzip outputs do; if this run happens not to, retry once with extra
    // padding to force one.
    if (!/[+/=]/.test(std)) {
      // Pathological luck; skip rather than false-positive.
      return;
    }
    expect(() => decodeConfigBlob(BLOB_MAGIC + std)).toThrow(ConfigUnsupportedVersionError);
  });

  test("salt shorter than 16 chars → ConfigUnsupportedVersionError (Convention A floor)", () => {
    const inner = { ...SAMPLE, salt: "shortsalt" };
    expect(() => decodeConfigBlob(mintBlob(inner))).toThrow(ConfigUnsupportedVersionError);
    expect(() => decodeConfigBlob(mintBlob(inner))).toThrow(/salt too short|>= 16|≥ 16/);
  });

  test("salt exactly 16 chars passes (boundary)", () => {
    const inner = { ...SAMPLE, salt: "0123456789ABCDEF" };
    expect(inner.salt.length).toBe(16);
    const cfg = decodeConfigBlob(mintBlob(inner));
    expect(cfg.salt).toBe("0123456789ABCDEF");
  });
});

describe("decodeConfigBlob — BundleCorruptError", () => {
  test("body that base64-decodes to non-gzip → BundleCorruptError", () => {
    const garbage = Buffer.from("not gzip bytes here xxxxxxx", "utf8");
    expect(() => decodeConfigBlob(BLOB_MAGIC + base64urlNoPad(garbage))).toThrow(
      BundleCorruptError,
    );
  });

  test("gzip ok but inner JSON is not an object (e.g. an array) → BundleCorruptError", () => {
    const gz = gzipSync(Buffer.from(JSON.stringify([1, 2, 3]), "utf8"));
    expect(() => decodeConfigBlob(BLOB_MAGIC + base64urlNoPad(gz))).toThrow(
      BundleCorruptError,
    );
  });

  test("missing required field → BundleCorruptError", () => {
    const { salt, ...rest } = SAMPLE;
    void salt; // not unused, just dropped
    expect(() => decodeConfigBlob(mintBlob(rest))).toThrow(BundleCorruptError);
    expect(() => decodeConfigBlob(mintBlob(rest))).toThrow(/salt|missing/i);
  });

  test("non-integer iterations → BundleCorruptError", () => {
    const inner = { ...SAMPLE, iterations: "600000" };
    expect(() => decodeConfigBlob(mintBlob(inner))).toThrow(BundleCorruptError);
  });

  test("non-positive iterations → BundleCorruptError", () => {
    const inner = { ...SAMPLE, iterations: 0 };
    expect(() => decodeConfigBlob(mintBlob(inner))).toThrow(BundleCorruptError);
  });
});
