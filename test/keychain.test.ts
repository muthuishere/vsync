import {
  test,
  expect,
  describe,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import {
  setKey,
  getKey,
  deleteKey,
  generateKey,
  KEYCHAIN_SERVICE,
} from "../src/keychain";
import { secrets } from "bun";

// Scope every test to a unique repo namespace so failed cleanup never
// leaks into the rest of the developer's keychain.
const REPO = `secret-lib-tests-${Math.random().toString(36).slice(2, 8)}`;
const ENV_A = "alpha";
const ENV_B = "beta";

async function cleanup() {
  for (const env of [ENV_A, ENV_B]) {
    try {
      await secrets.delete({
        service: KEYCHAIN_SERVICE,
        name: `${REPO}/${env}`,
      });
    } catch {
      /* ignore */
    }
  }
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(cleanup);

describe("generateKey", () => {
  test("returns ~44-char base64 string", () => {
    const k = generateKey();
    expect(k).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(k.length).toBeGreaterThanOrEqual(40);
  });
  test("two calls produce different values", () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});

describe("set / get / delete round-trip", () => {
  test("set then get returns the same value", async () => {
    const k = generateKey();
    await setKey(REPO, ENV_A, k);
    expect(await getKey(REPO, ENV_A)).toBe(k);
  });

  test("get returns null for unknown entries", async () => {
    expect(await getKey(REPO, "never-set")).toBeNull();
  });

  test("set overwrites an existing key", async () => {
    await setKey(REPO, ENV_A, "first-key-value-long-enough");
    await setKey(REPO, ENV_A, "second-key-value-also-long");
    expect(await getKey(REPO, ENV_A)).toBe("second-key-value-also-long");
  });

  test("delete removes the entry", async () => {
    await setKey(REPO, ENV_A, "to-be-deleted-value-here");
    await deleteKey(REPO, ENV_A);
    expect(await getKey(REPO, ENV_A)).toBeNull();
  });

  test("delete on a missing entry is a no-op (idempotent)", async () => {
    await expect(deleteKey(REPO, "never-set")).resolves.toBeUndefined();
  });

  test("different envs are isolated", async () => {
    await setKey(REPO, ENV_A, "alpha-key-value-long-enough");
    await setKey(REPO, ENV_B, "beta-key-value-also-long-enough");
    expect(await getKey(REPO, ENV_A)).toBe("alpha-key-value-long-enough");
    expect(await getKey(REPO, ENV_B)).toBe("beta-key-value-also-long-enough");
  });
});

describe("input validation", () => {
  test("setKey rejects empty value", async () => {
    await expect(setKey(REPO, ENV_A, "")).rejects.toThrow();
  });
  test("setKey rejects empty repo / env", async () => {
    await expect(setKey("", ENV_A, "x")).rejects.toThrow();
    await expect(setKey(REPO, "", "x")).rejects.toThrow();
  });
});
