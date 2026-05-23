"""Vsync handle behavior — fallback chain, asset access, redaction, lifecycle.

The end-to-end `open()` path involves S3 + decrypt and is exercised via
the conformance loader (which constructs the handle via `_from_vault`
once the underlying corpus has been driven through the lower layers).
Here we test the in-memory accessor surface directly.
"""

from __future__ import annotations

import json
import os

import pytest

import builtins

from vsync_s3_client import Vsync, get
from vsync_s3_client import open as vsync_open
from vsync_s3_client.client import (
    _parse_vault_payload,
    _reset_singleton,
    _set_s3_fetcher,
)
from vsync_s3_client.exceptions import (
    BundleCorruptError,
    ConfigMissingError,
)


# ─── Fallback chain (v0.12 §5) ─────────────────────────────────────────


def test_get_vault_wins_over_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://env")
    v = Vsync._from_vault(kv={"DATABASE_URL": "postgres://vault"})
    assert v.get("DATABASE_URL") == "postgres://vault"
    assert v.source("DATABASE_URL") == "vault"
    assert v.has("DATABASE_URL") is True


def test_get_env_wins_when_vault_misses(monkeypatch):
    monkeypatch.setenv("STRIPE_KEY", "sk_live_env")
    v = Vsync._from_vault(kv={}, defaults={"STRIPE_KEY": "sk_test_default"})
    assert v.get("STRIPE_KEY") == "sk_live_env"
    assert v.source("STRIPE_KEY") == "env"


def test_get_defaults_when_vault_and_env_miss():
    v = Vsync._from_vault(kv={}, defaults={"PORT": "8080"})
    # Make sure PORT isn't already in env on this machine.
    os.environ.pop("PORT", None)
    assert v.get("PORT") == "8080"
    assert v.source("PORT") == "default"
    assert v.has("PORT") is True


def test_get_missing_returns_none():
    v = Vsync._from_vault(kv={"OTHER": "x"})
    os.environ.pop("DATABASE_URL", None)
    assert v.get("DATABASE_URL") is None
    assert v.source("DATABASE_URL") == "missing"
    assert v.has("DATABASE_URL") is False


# ─── Assets (v0.12 §6) ─────────────────────────────────────────────────


def test_asset_bytes():
    v = Vsync._from_vault(assets={"svc.json": b'{"k":"v"}'})
    assert v.asset_bytes("svc.json") == b'{"k":"v"}'


def test_asset_path_materializes_to_0600(tmp_path):
    v = Vsync._from_vault(assets={"svc.json": b"data"})
    try:
        path = v.asset_path("svc.json")
        with open(path, "rb") as f:
            assert f.read() == b"data"
        mode = os.stat(path).st_mode & 0o777
        assert mode == 0o600
    finally:
        v.close()


def test_asset_path_repeat_returns_same_path():
    v = Vsync._from_vault(assets={"svc.json": b"data"})
    try:
        p1 = v.asset_path("svc.json")
        p2 = v.asset_path("svc.json")
        assert p1 == p2
    finally:
        v.close()


def test_close_removes_asset_tempdir():
    v = Vsync._from_vault(assets={"svc.json": b"data"})
    path = v.asset_path("svc.json")
    parent = os.path.dirname(path)
    assert os.path.isdir(parent)
    v.close()
    assert not os.path.exists(parent)


def test_close_is_idempotent():
    v = Vsync._from_vault(kv={"X": "y"})
    v.close()
    v.close()


def test_get_after_close_raises():
    v = Vsync._from_vault(kv={"X": "y"})
    v.close()
    with pytest.raises(ValueError):
        v.get("X")


def test_context_manager():
    with Vsync._from_vault(kv={"X": "y"}) as v:
        assert v.get("X") == "y"
    with pytest.raises(ValueError):
        v.get("X")


# ─── Generation ────────────────────────────────────────────────────────


def test_generation_is_returnable_and_safe_to_log():
    v = Vsync._from_vault(generation=42, env="prod")
    assert v.generation() == 42


# ─── Vault payload parser ──────────────────────────────────────────────


def test_parse_vault_kv_only_shape():
    payload = json.dumps({"kv": {"A": "1"}, "assets": {}}).encode()
    kv, assets = _parse_vault_payload(payload)
    assert kv == {"A": "1"}
    assert assets == {}


def test_parse_vault_flat_legacy_shape():
    payload = json.dumps({"A": "1", "B": "2"}).encode()
    kv, assets = _parse_vault_payload(payload)
    assert kv == {"A": "1", "B": "2"}
    assert assets == {}


def test_parse_vault_assets_base64_decoded():
    import base64
    payload = json.dumps(
        {"kv": {}, "assets": {"f": base64.b64encode(b"hi").decode()}}
    ).encode()
    _, assets = _parse_vault_payload(payload)
    assert assets == {"f": b"hi"}


def test_parse_vault_rejects_non_json_root():
    with pytest.raises(BundleCorruptError):
        _parse_vault_payload(b"not json")


def test_parse_vault_rejects_array_root():
    with pytest.raises(BundleCorruptError):
        _parse_vault_payload(b"[1,2]")


def test_parse_vault_rejects_int_kv_value():
    payload = json.dumps({"A": 1}).encode()
    with pytest.raises(BundleCorruptError):
        _parse_vault_payload(payload)


# ─── open() with mocked fetcher ────────────────────────────────────────


def _make_config_blob():
    import base64
    import gzip
    inner = json.dumps(
        {
            "v": 1,
            "endpoint": "https://s3.example.com",
            "region": "us-east-1",
            "bucket": "b",
            "accessKeyId": "k",
            "secretAccessKey": "s",
            "prefix": "p/",
            "env": "test",
            "salt": "test-salt",
            "iterations": 600000,
        }
    ).encode()
    gz = gzip.compress(inner)
    b64 = base64.urlsafe_b64encode(gz).rstrip(b"=").decode("ascii")
    return f"vsync-cfg-v1:{b64}"


def test_open_uses_injected_fetcher(monkeypatch):
    from vsync_s3_client.crypto import encrypt_rqe1_for_test

    salt = "test-salt"  # matches the SAMPLE blob in `_make_config_blob`
    passphrase = "the-passphrase"
    vault_json = json.dumps({"DATABASE_URL": "postgres://from-vault"}).encode()
    bundle = encrypt_rqe1_for_test(vault_json, passphrase, salt)
    manifest = b"RQEM0001" + b"20260601-000000" + b"meta"

    def fetcher(cfg):
        return manifest, bundle, 7

    _set_s3_fetcher(fetcher)
    try:
        monkeypatch.setenv("VSYNC_CONFIG", _make_config_blob())
        monkeypatch.setenv("VSYNC_PASSPHRASE", passphrase)
        v = vsync_open()
        try:
            assert v.get("DATABASE_URL") == "postgres://from-vault"
            assert v.generation() == 7
        finally:
            v.close()
    finally:
        _set_s3_fetcher(None)


def test_open_missing_env_raises_config_missing(monkeypatch):
    for var in ("VSYNC_CONFIG", "VSYNC_CONFIG_FILE", "VSYNC_PASSPHRASE", "VSYNC_PASSPHRASE_FILE"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(ConfigMissingError):
        vsync_open()


def test_module_level_get_uses_singleton(monkeypatch):
    from vsync_s3_client.crypto import encrypt_rqe1_for_test

    salt = "test-salt"
    passphrase = "pp"
    vault_json = json.dumps({"X": "from-vault"}).encode()
    bundle = encrypt_rqe1_for_test(vault_json, passphrase, salt)
    manifest = b"RQEM0001" + b"20260601-000000" + b"meta"

    def fetcher(cfg):
        return manifest, bundle, 1

    _set_s3_fetcher(fetcher)
    _reset_singleton()
    try:
        monkeypatch.setenv("VSYNC_CONFIG", _make_config_blob())
        monkeypatch.setenv("VSYNC_PASSPHRASE", passphrase)
        assert get("X") == "from-vault"
        # Second call must not re-open (the fetcher would be called again
        # and that's wasteful — singleton holds state).
        assert get("X") == "from-vault"
    finally:
        _reset_singleton()
        _set_s3_fetcher(None)
