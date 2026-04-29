import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  encode,
  decode,
  validate,
  envVarName,
  loadFromEnv,
  resolvePrefix,
  FALLBACK_PREFIX,
  MIN_KEY_LEN,
  MIN_SALT_LEN,
  type EnvConfig,
} from "../src/envconfig";

const valid: EnvConfig = {
  s3: {
    endpoint: "hel1.example.com",
    bucket: "b",
    region: "r",
    useSsl: true,
    accessKeyId: "akid",
    secretAccessKey: "sec",
  },
  encryption: {
    key: "long-enough-passphrase-for-validation",
    salt: "long-enough-salt-value",
  },
  files: { envFile: ".env", vaultFolder: "infra/vault/local" },
};

describe("envconfig encode/decode", () => {
  test("encode → decode roundtrips", () => {
    const enc = encode(valid);
    expect(decode(enc)).toEqual(valid);
  });

  test("encoded output is base64", () => {
    expect(encode(valid)).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("decode rejects garbage", () => {
    expect(() => decode("###not-base64###")).toThrow();
  });
});

describe("envconfig validate", () => {
  test("accepts a complete config", () => {
    expect(() => validate(structuredClone(valid))).not.toThrow();
  });

  for (const k of [
    "endpoint",
    "bucket",
    "region",
    "accessKeyId",
    "secretAccessKey",
  ] as const) {
    test(`rejects missing s3.${k}`, () => {
      const c: any = structuredClone(valid);
      delete c.s3[k];
      expect(() => validate(c)).toThrow(new RegExp(`s3\\.${k}`));
    });
  }

  test("rejects missing s3.useSsl", () => {
    const c: any = structuredClone(valid);
    delete c.s3.useSsl;
    expect(() => validate(c)).toThrow(/useSsl/);
  });

  test("rejects non-boolean s3.useSsl", () => {
    const c: any = structuredClone(valid);
    c.s3.useSsl = "true"; // string, not boolean
    expect(() => validate(c)).toThrow(/useSsl/);
  });

  test("rejects missing encryption.key", () => {
    const c: any = structuredClone(valid);
    delete c.encryption.key;
    expect(() => validate(c)).toThrow(/encryption\.key/);
  });

  test(`rejects encryption.key shorter than ${MIN_KEY_LEN} chars`, () => {
    const c: any = structuredClone(valid);
    c.encryption.key = "a".repeat(MIN_KEY_LEN - 1);
    expect(() => validate(c)).toThrow(/encryption\.key.*characters/);
  });

  test(`accepts encryption.key of exactly ${MIN_KEY_LEN} chars`, () => {
    const c: any = structuredClone(valid);
    c.encryption.key = "a".repeat(MIN_KEY_LEN);
    expect(() => validate(c)).not.toThrow();
  });

  test(`rejects encryption.salt shorter than ${MIN_SALT_LEN} chars`, () => {
    const c: any = structuredClone(valid);
    c.encryption.salt = "a".repeat(MIN_SALT_LEN - 1);
    expect(() => validate(c)).toThrow(/encryption\.salt.*characters/);
  });

  test("rejects missing files.envFile", () => {
    const c: any = structuredClone(valid);
    delete c.files.envFile;
    expect(() => validate(c)).toThrow(/files\.envFile/);
  });

  test("encode rejects an invalid config (delegates to validate)", () => {
    const c: any = structuredClone(valid);
    delete c.s3.bucket;
    expect(() => encode(c)).toThrow(/s3\.bucket/);
  });
});

describe("resolvePrefix", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.SECRETS_SYNC_PREFIX;
    delete process.env.SECRETS_SYNC_PREFIX;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.SECRETS_SYNC_PREFIX;
    else process.env.SECRETS_SYNC_PREFIX = saved;
  });

  test("falls back to SECRETS_ENV when nothing supplied", () => {
    expect(resolvePrefix()).toBe(FALLBACK_PREFIX);
  });

  test("explicit arg wins over env var", () => {
    process.env.SECRETS_SYNC_PREFIX = "FROM_ENV";
    expect(resolvePrefix("FROM_ARG")).toBe("FROM_ARG");
  });

  test("env var wins over fallback when no arg", () => {
    process.env.SECRETS_SYNC_PREFIX = "FROM_ENV";
    expect(resolvePrefix()).toBe("FROM_ENV");
  });

  test("rejects malformed prefix", () => {
    expect(() => resolvePrefix("not-upper")).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => resolvePrefix("1STARTS_DIGIT")).toThrow(/UPPER_SNAKE_CASE/);
  });
});

describe("envVarName", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.SECRETS_SYNC_PREFIX;
    delete process.env.SECRETS_SYNC_PREFIX;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.SECRETS_SYNC_PREFIX;
    else process.env.SECRETS_SYNC_PREFIX = saved;
  });

  test("uses fallback prefix by default", () => {
    expect(envVarName("LOCAL")).toBe("SECRETS_ENV_LOCAL");
    expect(envVarName("DEV_2")).toBe("SECRETS_ENV_DEV_2");
  });

  test("respects explicit prefix arg", () => {
    expect(envVarName("LOCAL", "VIDEO_AI_ENV")).toBe("VIDEO_AI_ENV_LOCAL");
    expect(envVarName("PROD", "REQSUME_ENV")).toBe("REQSUME_ENV_PROD");
  });

  test("respects SECRETS_SYNC_PREFIX env var", () => {
    process.env.SECRETS_SYNC_PREFIX = "VIDEO_AI_ENV";
    expect(envVarName("LOCAL")).toBe("VIDEO_AI_ENV_LOCAL");
  });

  test("rejects lowercase name", () => {
    expect(() => envVarName("local")).toThrow();
  });

  test("rejects empty name", () => {
    expect(() => envVarName("")).toThrow();
  });

  test("rejects names starting with a digit", () => {
    expect(() => envVarName("1ST")).toThrow();
  });
});

describe("loadFromEnv", () => {
  test("throws when env var is unset", () => {
    delete process.env.VIDEO_AI_ENV_TESTNOTSET;
    expect(() => loadFromEnv("TESTNOTSET", "VIDEO_AI_ENV")).toThrow(/not set/);
  });

  test("returns the decoded config when env var is set (explicit prefix)", () => {
    process.env.VIDEO_AI_ENV_TESTOK = encode(valid);
    expect(loadFromEnv("TESTOK", "VIDEO_AI_ENV")).toEqual(valid);
    delete process.env.VIDEO_AI_ENV_TESTOK;
  });
});
