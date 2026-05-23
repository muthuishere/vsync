"""RQEM0001 manifest read path — Python mirror of src/manifest.ts::unwrap.

Layout (v0.2 §3 / v0.4):
    bytes 0..7    magic "RQEM0001"
    bytes 8..22   15-byte ASCII timestamp ("YYYYMMDD-HHmmss")
    bytes 23..N   payload (caller-defined; opaque to this layer)

The pointer-seal verifies the embedded ts against the operator-supplied
remote ts. A mismatch is BundleCorruptError because it means a
write-only attacker has tried to roll `<prefix>manifest` to a renamed
older bundle (v0.2 §8.2).
"""

import pytest

from vsync_s3_client.exceptions import BundleCorruptError
from vsync_s3_client.manifest import unwrap_rqem0001, verify_against_remote_ts


def _wrap(ts: str, payload: bytes) -> bytes:
    """Local helper — mirror of src/manifest.ts::wrap for fixture setup."""
    assert len(ts) == 15
    return b"RQEM0001" + ts.encode("ascii") + payload


def test_unwrap_positive_basic():
    blob = _wrap("20260429-103045", b"hello payload")
    ts, payload = unwrap_rqem0001(blob)
    assert ts == "20260429-103045"
    assert payload == b"hello payload"


def test_unwrap_empty_payload():
    blob = _wrap("20260101-000000", b"")
    ts, payload = unwrap_rqem0001(blob)
    assert ts == "20260101-000000"
    assert payload == b""


def test_unwrap_wrong_magic_raises_bundle_corrupt():
    blob = bytearray(_wrap("20260429-103045", b"data"))
    blob[0] = ord("X")  # R → X
    with pytest.raises(BundleCorruptError):
        unwrap_rqem0001(bytes(blob))


def test_unwrap_too_short_raises_bundle_corrupt():
    with pytest.raises(BundleCorruptError):
        unwrap_rqem0001(b"RQEM0001short")


def test_verify_against_remote_ts_matches():
    blob = _wrap("20260501-091500", b"x")
    ts, payload = verify_against_remote_ts(blob, "20260501-091500")
    assert ts == "20260501-091500"
    assert payload == b"x"


def test_verify_against_remote_ts_mismatch_raises_bundle_corrupt():
    blob = _wrap("20260429-103045", b"x")
    with pytest.raises(BundleCorruptError):
        verify_against_remote_ts(blob, "20260501-091500")


def test_verify_against_remote_ts_wrong_magic_raises_bundle_corrupt():
    blob = bytearray(_wrap("20260429-103045", b"x"))
    blob[2] = ord("X")
    with pytest.raises(BundleCorruptError):
        verify_against_remote_ts(bytes(blob), "20260429-103045")
