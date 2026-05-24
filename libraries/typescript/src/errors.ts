// Error taxonomy — v0.12 §11. The class names are part of the
// cross-language conformance contract (`docs/specs/test-vectors/` pins
// them on `expected.error`), so do NOT rename them without updating the
// spec and the corpus.
//
// `code` is the stable machine-readable handle for programmatic switching;
// callers should prefer `code` over `instanceof` only when they want to
// stay future-proof against a name churn (which v1.0 won't have, but a
// hypothetical bridge layer might).

export class VSyncError extends Error {
  /** Stable machine-readable code; overridden on every concrete subclass. */
  readonly code: string = "VSYNC_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "VSyncError";
    // Some runtime targets lose the prototype chain across class extends
    // through `super()` (older transpile targets / certain bundlers); the
    // explicit setPrototypeOf is the documented workaround.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigMissingError extends VSyncError {
  override readonly code = "VSYNC_CONFIG_MISSING";
  constructor(message: string) {
    super(message);
    this.name = "ConfigMissingError";
  }
}

export class ConfigUnsupportedVersionError extends VSyncError {
  override readonly code = "VSYNC_CONFIG_UNSUPPORTED_VERSION";
  constructor(message: string) {
    super(message);
    this.name = "ConfigUnsupportedVersionError";
  }
}

export class S3UnreachableError extends VSyncError {
  override readonly code = "VSYNC_S3_UNREACHABLE";
  constructor(message: string) {
    super(message);
    this.name = "S3UnreachableError";
  }
}

export class ManifestNotFoundError extends VSyncError {
  override readonly code = "VSYNC_MANIFEST_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "ManifestNotFoundError";
  }
}

export class WrongPassphraseError extends VSyncError {
  override readonly code = "VSYNC_WRONG_PASSPHRASE";
  constructor(message: string) {
    super(message);
    this.name = "WrongPassphraseError";
  }
}

export class BundleCorruptError extends VSyncError {
  override readonly code = "VSYNC_BUNDLE_CORRUPT";
  constructor(message: string) {
    super(message);
    this.name = "BundleCorruptError";
  }
}

export class UnsupportedSpecVersionError extends VSyncError {
  override readonly code = "VSYNC_UNSUPPORTED_SPEC_VERSION";
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSpecVersionError";
  }
}
