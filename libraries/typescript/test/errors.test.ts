import { describe, expect, test } from "vitest";
import {
  BundleCorruptError,
  ConfigMissingError,
  ConfigUnsupportedVersionError,
  ManifestNotFoundError,
  S3UnreachableError,
  UnsupportedSpecVersionError,
  VSyncError,
  WrongPassphraseError,
} from "../src/errors.js";

// v0.12 §11 — the error taxonomy is the cross-language contract.
// Class identity is matched on `name` (so conformance vectors can pin
// "WrongPassphraseError" verbatim) and `code` is the machine handle.

describe("VSyncError taxonomy", () => {
  test("VSyncError is the common Error subclass", () => {
    const e = new VSyncError("x");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(VSyncError);
    expect(e.name).toBe("VSyncError");
    expect(e.message).toBe("x");
  });

  test("every taxonomy class subclasses VSyncError and pins its name", () => {
    const cases: { ctor: new (m: string) => VSyncError; name: string; code: string }[] = [
      { ctor: ConfigMissingError, name: "ConfigMissingError", code: "VSYNC_CONFIG_MISSING" },
      {
        ctor: ConfigUnsupportedVersionError,
        name: "ConfigUnsupportedVersionError",
        code: "VSYNC_CONFIG_UNSUPPORTED_VERSION",
      },
      { ctor: S3UnreachableError, name: "S3UnreachableError", code: "VSYNC_S3_UNREACHABLE" },
      { ctor: ManifestNotFoundError, name: "ManifestNotFoundError", code: "VSYNC_MANIFEST_NOT_FOUND" },
      { ctor: WrongPassphraseError, name: "WrongPassphraseError", code: "VSYNC_WRONG_PASSPHRASE" },
      { ctor: BundleCorruptError, name: "BundleCorruptError", code: "VSYNC_BUNDLE_CORRUPT" },
      {
        ctor: UnsupportedSpecVersionError,
        name: "UnsupportedSpecVersionError",
        code: "VSYNC_UNSUPPORTED_SPEC_VERSION",
      },
    ];
    for (const c of cases) {
      const e = new c.ctor("hello");
      expect(e).toBeInstanceOf(VSyncError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(c.name);
      expect(e.code).toBe(c.code);
      expect(e.message).toBe("hello");
    }
  });

  test("instanceof discriminates between subclasses", () => {
    const e = new WrongPassphraseError("x");
    expect(e instanceof WrongPassphraseError).toBe(true);
    expect(e instanceof VSyncError).toBe(true);
    expect(e instanceof BundleCorruptError).toBe(false);
  });

  test("stack traces are preserved", () => {
    const e = new BundleCorruptError("boom");
    expect(typeof e.stack).toBe("string");
    expect(e.stack).toContain("BundleCorruptError");
  });
});
