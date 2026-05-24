"""vsync-s3-client — read-side runtime library for the vsync ecosystem.

Spec: `docs/specs/v0.12-vsync-s3-client.md`. The CLI (`@muthuishere/vsync`)
is the canonical writer; this library is the reader. Two open paths:
`open()` reads `VSYNC_CONFIG` + `VSYNC_PASSPHRASE` from the env;
`open_with(config=..., passphrase=...)` accepts the strings directly
(for callers that fetch their bootstrap from KMS / Vault / etc.). One
S3 round trip per handle, in-memory accessor with a deterministic
fallback chain. No daemon, no refresh, no filesystem cache.

Quick-start:

    import vsync_s3_client
    with vsync_s3_client.open() as v:
        db_url = v.get_env("DATABASE_URL")

Or, with bootstrap from a custom secrets layer:

    cfg = my_secrets.fetch("vsync-config")
    pp  = my_secrets.fetch("vsync-passphrase")
    with vsync_s3_client.open_with(config=cfg, passphrase=pp) as v:
        db_url = v.get_env("DATABASE_URL")
"""

from .client import Vsync, open, open_with
from .client import get_env as get_env
from .exceptions import (
    BundleCorruptError,
    ConfigMissingError,
    ConfigUnsupportedVersionError,
    ManifestNotFoundError,
    S3UnreachableError,
    UnsupportedSpecVersionError,
    VSyncError,
    WrongPassphraseError,
)

__version__ = "0.12.0"

__all__ = [
    "open",
    "open_with",
    "get_env",
    "Vsync",
    "VSyncError",
    "ConfigMissingError",
    "ConfigUnsupportedVersionError",
    "S3UnreachableError",
    "ManifestNotFoundError",
    "WrongPassphraseError",
    "BundleCorruptError",
    "UnsupportedSpecVersionError",
    "__version__",
]
