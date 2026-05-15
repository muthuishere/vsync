import { test, expect, describe } from "bun:test";
import { buildShareFile, parseShareFile } from "../src/sharefile";
import { EXPORT_BLOB_VERSION, type ExportPayload } from "../src/envconfig";
import { generatePassphrase } from "../src/passphrase";

const payload: ExportPayload = {
  version: EXPORT_BLOB_VERSION,
  repo: "acme",
  env: "dev",
  config: {
    version: 1,
    s3: {
      endpoint: "hel1.example.com",
      bucket: "b",
      region: "r",
      useSsl: true,
      accessKeyId: "akid",
      secretAccessKey: "sec",
    },
    encryption: { salt: "long-enough-salt-string" },
  },
  key: "test-only-key-meeting-minimum-length-",
};

describe("share file round-trip", () => {
  test("build → parse roundtrips with same passphrase", async () => {
    const pp = generatePassphrase();
    const bytes = await buildShareFile(payload, pp);
    const back = await parseShareFile(bytes, pp);
    expect(back).toEqual(payload);
  });

  test("output starts with the 'SLS1' magic header", async () => {
    const bytes = await buildShareFile(payload, generatePassphrase());
    expect(bytes[0]).toBe(0x53); // S
    expect(bytes[1]).toBe(0x4c); // L
    expect(bytes[2]).toBe(0x53); // S
    expect(bytes[3]).toBe(0x31); // 1
  });

  test("parse rejects the wrong passphrase", async () => {
    const bytes = await buildShareFile(payload, "right-passphrase-abcd");
    await expect(parseShareFile(bytes, "wrong-passphrase-xyz")).rejects.toThrow(
      /decrypt/,
    );
  });

  test("parse rejects a tampered ciphertext", async () => {
    const pp = generatePassphrase();
    const bytes = await buildShareFile(payload, pp);
    // Flip a byte well into the ciphertext (past header + salt).
    bytes[bytes.length - 1] ^= 0xff;
    await expect(parseShareFile(bytes, pp)).rejects.toThrow();
  });

  test("parse rejects a file missing the magic header", async () => {
    const bytes = await buildShareFile(payload, generatePassphrase());
    bytes[0] = 0;
    await expect(parseShareFile(bytes, "x".repeat(12))).rejects.toThrow(
      /magic/,
    );
  });

  test("parse rejects a file truncated mid-salt", async () => {
    const bytes = await buildShareFile(payload, generatePassphrase());
    const truncated = bytes.subarray(0, 5);
    await expect(parseShareFile(truncated, "x".repeat(12))).rejects.toThrow();
  });

  test("two shares of the same payload differ (random salt + IV)", async () => {
    const pp = generatePassphrase();
    const a = await buildShareFile(payload, pp);
    const b = await buildShareFile(payload, pp);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
  });

  test("rejects a payload with the wrong version", async () => {
    const wrong = { ...payload, version: 99 } as any;
    await expect(buildShareFile(wrong, "x".repeat(12))).rejects.toThrow(
      /version/,
    );
  });
});
