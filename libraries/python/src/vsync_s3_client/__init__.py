"""vsync-s3-client — read-side runtime library for the vsync ecosystem.

Spec: `docs/specs/v0.12-vsync-s3-client.md`. The CLI (`@muthuishere/vsync`)
is the canonical writer; this library is the reader. One process input
pair (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`), one S3 round trip, in-memory
accessor with a deterministic fallback chain. No daemon, no refresh, no
filesystem cache.

Quick-start:

    import vsync_s3_client
    with vsync_s3_client.open() as v:
        db_url = v.get("DATABASE_URL")
"""

from .client import Vsync, open
from .client import get as get
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

__version__ = "0.11.0"

__all__ = [
    "open",
    "get",
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
