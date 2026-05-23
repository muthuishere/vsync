"""Error taxonomy for vsync-s3-client.

Class names below are the canonical taxonomy from
`docs/specs/v0.12-vsync-s3-client.md` §11 and the cross-language
conformance vectors at `docs/specs/test-vectors/`. They must not be
renamed without also updating the spec and the corpus — the test-vector
loader matches on `__class__.__name__`.
"""


class VSyncError(Exception):
    """Common root for everything raised by this library."""


class ConfigMissingError(VSyncError):
    """`VSYNC_CONFIG` / `VSYNC_PASSPHRASE` unset, or magic prefix wrong."""


class ConfigUnsupportedVersionError(VSyncError):
    """Inner JSON `v:` is newer than this library understands."""


class S3UnreachableError(VSyncError):
    """Network, DNS, TLS, or HTTP 4xx/5xx on the S3 fetch."""


class ManifestNotFoundError(VSyncError):
    """Bucket reachable, `<prefix>manifest` absent — run `vsync push` first."""


class WrongPassphraseError(VSyncError):
    """AES-GCM auth tag rejected the passphrase."""


class BundleCorruptError(VSyncError):
    """Magic byte mismatch, truncated read, or manifest pointer dangling."""


class UnsupportedSpecVersionError(VSyncError):
    """Unknown `RQE1` / `RQEM0001` envelope version — upgrade the library."""


__all__ = [
    "VSyncError",
    "ConfigMissingError",
    "ConfigUnsupportedVersionError",
    "S3UnreachableError",
    "ManifestNotFoundError",
    "WrongPassphraseError",
    "BundleCorruptError",
    "UnsupportedSpecVersionError",
]
