"""`VSYNC_CONFIG` bootstrap blob decoder.

Wire format (v0.12 §2.1):
    ``vsync-cfg-v1:<base64url-no-pad(gzip(JSON))>``

The magic prefix is also the schema-version handle:
- absent / non-`vsync-cfg-v1:` → ConfigMissingError
- present, base64url body decodes to non-gzip → BundleCorruptError
- present, gzip ok, JSON inner `v != 1` → ConfigUnsupportedVersionError
- standard base64 (`+`, `/`, `=`) MUST be rejected → ConfigUnsupportedVersionError
  (the receiver can't tell whether you intended url-safe and corrupted it,
  or intended standard and shipped the wrong alphabet; either way they're
  holding a blob outside the contract)
"""

from __future__ import annotations

import base64
import gzip
import json
from dataclasses import dataclass
from typing import Union

from .exceptions import (
    BundleCorruptError,
    ConfigMissingError,
    ConfigUnsupportedVersionError,
)

BLOB_MAGIC = "vsync-cfg-v1:"
SUPPORTED_INNER_V = 1
# RFC 4648 §5 alphabet uses '-' and '_' instead of '+' and '/'.
_DISALLOWED_BASE64_CHARS = frozenset("+/=")


@dataclass(frozen=True)
class VsyncConfig:
    """Decoded inner JSON of the `VSYNC_CONFIG` blob.

    Field naming is snake_case on the Python side (idiomatic) while the
    wire JSON keys remain camelCase per v0.12 §2.1. Mapping happens in
    `decode_config_blob`.

    `salt` + `iterations` carry the PBKDF2 parameters needed to derive
    the AES-256 key from `VSYNC_PASSPHRASE`. They land in the blob from
    `vsync runtime-token`; both are required (v0.12 §2.1, post-revision).
    """

    v: int
    endpoint: str
    region: str
    bucket: str
    access_key_id: str
    secret_access_key: str
    prefix: str
    env: str
    salt: str
    iterations: int

    def __repr__(self) -> str:  # redaction — never log credentials
        return (
            f"VsyncConfig(v={self.v}, endpoint={self.endpoint!r}, "
            f"region={self.region!r}, bucket={self.bucket!r}, "
            f"env={self.env!r}, prefix={self.prefix!r}, "
            f"iterations={self.iterations}, "
            f"accessKeyId=<redacted>, secretAccessKey=<redacted>, "
            f"salt=<redacted>)"
        )


def _as_bytes(blob: Union[bytes, bytearray, memoryview, str]) -> bytes:
    if isinstance(blob, str):
        return blob.encode("ascii")
    if isinstance(blob, (bytes, bytearray, memoryview)):
        return bytes(blob)
    raise ConfigMissingError(
        f"VSYNC_CONFIG: expected bytes or str, got {type(blob).__name__}"
    )


def decode_config_blob(
    blob: Union[bytes, bytearray, memoryview, str],
) -> VsyncConfig:
    """Decode a `VSYNC_CONFIG` blob → typed config.

    Raises:
        ConfigMissingError: magic prefix absent or wrong (incl. raw JSON,
            wrong-version magic, empty input).
        ConfigUnsupportedVersionError: inner JSON `v` > 1, or the body uses
            the standard base64 alphabet instead of base64url-no-pad.
        BundleCorruptError: magic + base64 ok but the bytes inside aren't
            gzip / aren't a JSON object.
    """
    data = _as_bytes(blob)
    if not data.startswith(BLOB_MAGIC.encode("ascii")):
        raise ConfigMissingError(
            "VSYNC_CONFIG: missing 'vsync-cfg-v1:' prefix — did you paste "
            "raw JSON, or are you holding a newer (v2+) blob?"
        )
    body = data[len(BLOB_MAGIC):]

    # Strict base64url rejection: any standard-alphabet character or
    # explicit padding is the operator hand-rolling with `base64` instead
    # of `base64url`. Surface that loudly.
    for ch in _DISALLOWED_BASE64_CHARS:
        if ch.encode("ascii") in body:
            raise ConfigUnsupportedVersionError(
                "VSYNC_CONFIG: body must be base64url-no-pad per v0.12 §2.1; "
                f"found disallowed character {ch!r} (use '-' and '_' instead "
                "of '+' and '/'; drop padding '=')"
            )

    # base64url without padding — re-add padding for the decoder.
    pad = b"=" * ((-len(body)) % 4)
    try:
        decoded = base64.urlsafe_b64decode(body + pad)
    except Exception as e:  # noqa: BLE001 - convert to taxonomy
        raise BundleCorruptError(
            f"VSYNC_CONFIG: base64url body failed to decode: {e}"
        ) from e

    try:
        raw_json = gzip.decompress(decoded)
    except Exception as e:  # noqa: BLE001 - covers OSError + EOFError
        raise BundleCorruptError(
            f"VSYNC_CONFIG: gzip decompress failed — body is not a gzip stream: {e}"
        ) from e

    try:
        obj = json.loads(raw_json)
    except json.JSONDecodeError as e:
        raise BundleCorruptError(
            f"VSYNC_CONFIG: inner JSON failed to parse: {e}"
        ) from e
    if not isinstance(obj, dict):
        raise BundleCorruptError(
            f"VSYNC_CONFIG: inner JSON must be an object, got {type(obj).__name__}"
        )

    v = obj.get("v")
    if v != SUPPORTED_INNER_V:
        raise ConfigUnsupportedVersionError(
            f"VSYNC_CONFIG: inner v={v!r}; this library understands v=1 only — "
            "upgrade vsync-s3-client"
        )

    # Required fields per v0.12 §2.1. Missing field → BundleCorrupt (the
    # operator's blob is internally inconsistent with the spec).
    try:
        iters = obj["iterations"]
        if not isinstance(iters, int) or iters <= 0:
            raise BundleCorruptError(
                f"VSYNC_CONFIG: iterations must be a positive int, got {iters!r}"
            )
        return VsyncConfig(
            v=int(obj["v"]),
            endpoint=str(obj["endpoint"]),
            region=str(obj["region"]),
            bucket=str(obj["bucket"]),
            access_key_id=str(obj["accessKeyId"]),
            secret_access_key=str(obj["secretAccessKey"]),
            prefix=str(obj["prefix"]),
            env=str(obj["env"]),
            salt=str(obj["salt"]),
            iterations=iters,
        )
    except KeyError as e:
        raise BundleCorruptError(
            f"VSYNC_CONFIG: inner JSON is missing required field {e.args[0]!r}"
        ) from e


__all__ = ["VsyncConfig", "decode_config_blob"]
