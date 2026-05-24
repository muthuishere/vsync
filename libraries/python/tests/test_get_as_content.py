"""Binary asset access per v0.12 §6: `get_as_content(name) -> bytes`.

The path-materialization machinery from earlier drafts is gone. The
library only returns bytes; operators write a tempfile themselves if
their SDK demands a filesystem path (3-line recipe in spec §4.1).
"""

from __future__ import annotations

import pytest

from vsync_s3_client import Vsync


def test_get_as_content_returns_assets_bytes():
    v = Vsync._from_vault(assets={"svc.json": b'{"k":"v"}'})
    assert v.get_as_content("svc.json") == b'{"k":"v"}'


def test_get_as_content_returns_bytes_type():
    """Explicit type check — callers index/encode based on `bytes`."""
    v = Vsync._from_vault(assets={"b.bin": b"\x00\x01\x02"})
    out = v.get_as_content("b.bin")
    assert isinstance(out, bytes)
    assert out == b"\x00\x01\x02"


def test_get_as_content_falls_through_kv_when_asset_not_present():
    """If the bundle stored the value as a scalar KV (PEMs, JSON often
    happen to be UTF-8), `get_as_content` encodes and returns it. Mirrors
    the conformance corpus's `asset-path` pattern where the harness
    injects the binary via `assets=...` but the underlying vault JSON
    referenced the key in `kv`."""
    v = Vsync._from_vault(kv={"cert.pem": "-----BEGIN-----\nABC\n-----END-----"})
    assert v.get_as_content("cert.pem") == b"-----BEGIN-----\nABC\n-----END-----"


def test_get_as_content_assets_take_priority_over_kv():
    """When the same name lives in both `assets` and `kv`, `assets` wins —
    the binary store is the source of truth for bytes."""
    v = Vsync._from_vault(
        kv={"name": "text"},
        assets={"name": b"\xff\xff\xff"},
    )
    assert v.get_as_content("name") == b"\xff\xff\xff"


def test_get_as_content_missing_raises_keyerror():
    v = Vsync._from_vault(kv={}, assets={})
    with pytest.raises(KeyError):
        v.get_as_content("not-there.json")


def test_get_as_content_after_close_raises():
    v = Vsync._from_vault(assets={"x.bin": b"data"})
    v.close()
    with pytest.raises(ValueError):
        v.get_as_content("x.bin")


def test_get_as_content_handles_empty_bytes():
    """Empty asset is a valid asset (an empty PEM, an empty config) —
    must return b"", not raise."""
    v = Vsync._from_vault(assets={"empty.bin": b""})
    assert v.get_as_content("empty.bin") == b""
