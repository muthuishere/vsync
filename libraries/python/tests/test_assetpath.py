"""Asset materialization per v0.12 §6: lazy `assetPath()` → tempfile.

Rules:
- Per-handle tempdir created with mode 0700 at first call.
- Prefer /dev/shm on Linux (tmpfs — doesn't touch the platter); fall back
  to mkdtemp on macOS / BSD / when /dev/shm doesn't exist.
- Files inside written with mode 0600.
- One file per asset name (cached on second call).
- close() removes the dir.
- SIGKILL → file leaks. Documented honestly elsewhere; not testable here.
"""

from __future__ import annotations

import os
import stat
import sys

import pytest

from vsync_s3_client.assetpath import AssetMaterializer


def _mode(p: str) -> int:
    return stat.S_IMODE(os.stat(p).st_mode)


def test_materialize_writes_bytes():
    m = AssetMaterializer()
    try:
        path = m.materialize("svc.json", b'{"k":"v"}')
        with open(path, "rb") as f:
            assert f.read() == b'{"k":"v"}'
    finally:
        m.close()


def test_materialize_file_is_0600():
    m = AssetMaterializer()
    try:
        path = m.materialize("svc.json", b"data")
        assert _mode(path) == 0o600
    finally:
        m.close()


def test_dir_is_0700():
    m = AssetMaterializer()
    try:
        path = m.materialize("svc.json", b"data")
        assert _mode(os.path.dirname(path)) == 0o700
    finally:
        m.close()


def test_second_call_returns_cached_path():
    m = AssetMaterializer()
    try:
        p1 = m.materialize("svc.json", b"data-v1")
        p2 = m.materialize("svc.json", b"data-v1")
        assert p1 == p2
    finally:
        m.close()


def test_close_removes_directory():
    m = AssetMaterializer()
    path = m.materialize("svc.json", b"data")
    parent = os.path.dirname(path)
    assert os.path.isdir(parent)
    m.close()
    assert not os.path.exists(parent)


def test_close_is_idempotent():
    m = AssetMaterializer()
    m.materialize("svc.json", b"data")
    m.close()
    m.close()  # second close must not raise


def test_two_assets_in_same_handle():
    m = AssetMaterializer()
    try:
        p1 = m.materialize("a.pem", b"AAA")
        p2 = m.materialize("b.pem", b"BBB")
        assert os.path.dirname(p1) == os.path.dirname(p2)
        assert p1 != p2
        with open(p1, "rb") as f:
            assert f.read() == b"AAA"
        with open(p2, "rb") as f:
            assert f.read() == b"BBB"
    finally:
        m.close()


def test_asset_name_with_slashes_doesnt_escape(tmp_path):
    # An attacker-controlled asset name like '../../etc/passwd' must not
    # write outside the tempdir.
    m = AssetMaterializer()
    try:
        path = m.materialize("../../etc/passwd", b"x")
        parent = m.tempdir
        assert path.startswith(parent + os.sep)
    finally:
        m.close()


@pytest.mark.skipif(sys.platform != "linux", reason="tmpfs preference is Linux-only")
def test_prefers_dev_shm_on_linux():
    if not os.path.isdir("/dev/shm"):
        pytest.skip("/dev/shm not available")
    m = AssetMaterializer()
    try:
        path = m.materialize("svc.json", b"data")
        assert path.startswith("/dev/shm/")
    finally:
        m.close()
