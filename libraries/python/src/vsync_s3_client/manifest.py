"""RQEM0001 manifest pointer-seal — read path only.

The CLI writes manifests as part of push / rotate-passphrase. This
library only reads them. Layout (v0.2 §3):

    bytes 0..7    magic "RQEM0001"
    bytes 8..22   15-char ASCII timestamp "YYYYMMDD-HHmmss"
    bytes 23..N   payload (opaque)

`verify_against_remote_ts` is the load-bearing anti-rollback check —
a bucket-write-only attacker who renames an older `<prefix>v=<ts>` and
swings the manifest pointer at it will lose this comparison.
"""

from __future__ import annotations

from .exceptions import BundleCorruptError

MAGIC = b"RQEM0001"
TS_LEN = 15
HEADER_LEN = len(MAGIC) + TS_LEN  # 23


def unwrap_rqem0001(blob: bytes) -> tuple[str, bytes]:
    """Parse the RQEM0001 envelope; return (ts, payload).

    Raises BundleCorruptError on missing magic, truncation, or non-ASCII
    timestamp bytes. Does NOT verify against a remote ts — that's the
    caller's job via `verify_against_remote_ts`.
    """
    if not isinstance(blob, (bytes, bytearray, memoryview)):
        raise BundleCorruptError(
            f"RQEM0001 manifest: expected bytes-like, got {type(blob).__name__}"
        )
    blob = bytes(blob)
    if len(blob) < HEADER_LEN:
        raise BundleCorruptError(
            f"RQEM0001 manifest too short: {len(blob)} bytes "
            f"(need at least {HEADER_LEN})"
        )
    if blob[: len(MAGIC)] != MAGIC:
        raise BundleCorruptError(
            "RQEM0001 manifest: magic prefix mismatch — not a vsync manifest"
        )
    ts_bytes = blob[len(MAGIC):HEADER_LEN]
    try:
        ts = ts_bytes.decode("ascii")
    except UnicodeDecodeError as e:
        raise BundleCorruptError(
            "RQEM0001 manifest: timestamp is not ASCII"
        ) from e
    payload = blob[HEADER_LEN:]
    return ts, payload


def verify_against_remote_ts(
    blob: bytes, remote_ts: str
) -> tuple[str, bytes]:
    """Unwrap + verify the embedded ts equals `remote_ts`.

    The pointer-seal guarantee: an attacker who can write to the bucket
    but cannot decrypt the bundle still can't quietly roll the manifest
    pointer back to a renamed older bundle — the embedded ts won't match
    the URL/key the lib fetched it from.
    """
    ts, payload = unwrap_rqem0001(blob)
    if ts != remote_ts:
        raise BundleCorruptError(
            f"RQEM0001 manifest: embedded ts {ts!r} != remote ts {remote_ts!r} "
            "— possible pointer-rollback attack or torn bucket write"
        )
    return ts, payload


__all__ = ["unwrap_rqem0001", "verify_against_remote_ts"]
