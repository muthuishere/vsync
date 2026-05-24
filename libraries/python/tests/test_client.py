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

from vsync_s3_client import Vsync, get_env, open_with
from vsync_s3_client import open as vsync_open
from vsync_s3_client.client import (
    _kdf_salt,
    _parse_vault_payload,
    _reset_singleton,
    _set_s3_fetcher,
)
from vsync_s3_client.config_blob import VsyncConfig
from vsync_s3_client.exceptions import (
    BundleCorruptError,
    ConfigMissingError,
    ConfigUnsupportedVersionError,
    ManifestNotFoundError,
    S3UnreachableError,
)


# ─── Fallback chain (v0.12 §5) ─────────────────────────────────────────


def test_get_env_vault_wins_over_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://env")
    v = Vsync._from_vault(kv={"DATABASE_URL": "postgres://vault"})
    assert v.get_env("DATABASE_URL") == "postgres://vault"
    assert v.env_source("DATABASE_URL") == "vault"
    assert v.has_env("DATABASE_URL") is True


def test_get_env_env_wins_when_vault_misses(monkeypatch):
    monkeypatch.setenv("STRIPE_KEY", "sk_live_env")
    v = Vsync._from_vault(kv={}, defaults={"STRIPE_KEY": "sk_test_default"})
    assert v.get_env("STRIPE_KEY") == "sk_live_env"
    assert v.env_source("STRIPE_KEY") == "env"


def test_get_env_defaults_when_vault_and_env_miss():
    v = Vsync._from_vault(kv={}, defaults={"PORT": "8080"})
    os.environ.pop("PORT", None)
    assert v.get_env("PORT") == "8080"
    assert v.env_source("PORT") == "default"
    assert v.has_env("PORT") is True


def test_get_env_missing_returns_none():
    v = Vsync._from_vault(kv={"OTHER": "x"})
    os.environ.pop("DATABASE_URL", None)
    assert v.get_env("DATABASE_URL") is None
    assert v.env_source("DATABASE_URL") == "missing"
    assert v.has_env("DATABASE_URL") is False


# ─── Lifecycle ─────────────────────────────────────────────────────────


def test_close_is_idempotent():
    v = Vsync._from_vault(kv={"X": "y"})
    v.close()
    v.close()


def test_get_env_after_close_raises():
    v = Vsync._from_vault(kv={"X": "y"})
    v.close()
    with pytest.raises(ValueError):
        v.get_env("X")


def test_context_manager():
    with Vsync._from_vault(kv={"X": "y"}) as v:
        assert v.get_env("X") == "y"
    with pytest.raises(ValueError):
        v.get_env("X")


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


# ─── Salt pass-through (v0.12 §2.1, Convention A — locked at bc52f51) ──


def _cfg(**overrides):
    """Build a VsyncConfig with sensible defaults; override what the test cares about."""
    base = dict(
        v=1,
        endpoint="https://s3.example.com",
        region="us-east-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
        prefix="p/",
        env="test",
        salt="AAAAAAAAAAAAAAAAAAAAAA==",
        iterations=600000,
    )
    base.update(overrides)
    return VsyncConfig(**base)


def test_kdf_salt_returns_string_verbatim():
    salt = "AAAAAAAAAAAAAAAAAAAAAA=="
    cfg = _cfg(salt=salt)
    assert _kdf_salt(cfg) == salt
    assert isinstance(_kdf_salt(cfg), str)


def test_kdf_salt_short_string_raises_config_unsupported_version():
    cfg = _cfg(salt="A" * 15)
    with pytest.raises(ConfigUnsupportedVersionError):
        _kdf_salt(cfg)


def test_kdf_salt_exactly_16_chars_accepted():
    cfg = _cfg(salt="A" * 16)
    assert _kdf_salt(cfg) == "A" * 16


def test_kdf_salt_24_char_cli_default_accepted():
    cfg = _cfg(salt="AAAAAAAAAAAAAAAAAAAAAA==")
    assert _kdf_salt(cfg) == "AAAAAAAAAAAAAAAAAAAAAA=="


def test_kdf_salt_non_base64_string_still_accepted():
    cfg = _cfg(salt="not-base64-but-long-enough-to-pass")
    assert _kdf_salt(cfg) == "not-base64-but-long-enough-to-pass"


def test_kdf_salt_iterations_zero_raises_config_unsupported_version():
    cfg = _cfg(iterations=0)
    with pytest.raises(ConfigUnsupportedVersionError):
        _kdf_salt(cfg)


def test_kdf_salt_iterations_negative_raises_config_unsupported_version():
    cfg = _cfg(iterations=-1)
    with pytest.raises(ConfigUnsupportedVersionError):
        _kdf_salt(cfg)


# ─── open() with mocked fetcher ────────────────────────────────────────


_TEST_SALT_STR = "AAAAAAAAAAAAAAAAAAAAAA=="


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
            "salt": _TEST_SALT_STR,
            "iterations": 600000,
        }
    ).encode()
    gz = gzip.compress(inner)
    b64 = base64.urlsafe_b64encode(gz).rstrip(b"=").decode("ascii")
    return f"vsync-cfg-v1:{b64}"


def test_open_uses_injected_fetcher(monkeypatch):
    from vsync_s3_client.crypto import encrypt_rqe1_for_test

    salt = _TEST_SALT_STR
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
            assert v.get_env("DATABASE_URL") == "postgres://from-vault"
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


def test_module_level_get_env_uses_singleton(monkeypatch):
    from vsync_s3_client.crypto import encrypt_rqe1_for_test

    salt = _TEST_SALT_STR
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
        assert get_env("X") == "from-vault"
        assert get_env("X") == "from-vault"
    finally:
        _reset_singleton()
        _set_s3_fetcher(None)


def test_runtime_roundtrip_against_cli_salt_format(monkeypatch):
    """End-to-end production-path check (team-lead's spec verification).

    Simulates the bytes `vsync runtime-token` emits at commit bc52f51 —
    `salt` is a 24-char ASCII string written verbatim into the blob
    (Convention A; NO base64 wrap on the wire). The runtime lib MUST
    feed those 24 utf-8 bytes to PBKDF2, byte-identical to what
    `src/crypto.ts::deriveKey` does on encrypt.
    """
    from vsync_s3_client.crypto import encrypt_rqe1_for_test
    import base64
    import gzip

    cli_salt = "20ZiDJFKLLkDsDUiWSMn3g=="
    passphrase = "test-passphrase"

    plaintext = b'{"HELLO":"world"}'
    bundle = encrypt_rqe1_for_test(plaintext, passphrase, cli_salt)
    manifest = b"RQEM0001" + b"20260601-000000" + b"meta"

    inner = json.dumps(
        {
            "v": 1,
            "endpoint": "https://s3.example.com",
            "region": "us-east-1",
            "bucket": "b",
            "accessKeyId": "k",
            "secretAccessKey": "s",
            "prefix": "p/",
            "env": "prod",
            "salt": cli_salt,
            "iterations": 600000,
        }
    ).encode()
    gz = gzip.compress(inner)
    b64 = base64.urlsafe_b64encode(gz).rstrip(b"=").decode("ascii")
    config_blob = f"vsync-cfg-v1:{b64}"

    def fetcher(cfg):
        assert cfg.salt == cli_salt, (
            f"runtime path saw salt {cfg.salt!r}, expected {cli_salt!r} — "
            "the lib must NOT transform the wire salt field"
        )
        return manifest, bundle, 0

    _set_s3_fetcher(fetcher)
    try:
        monkeypatch.setenv("VSYNC_CONFIG", config_blob)
        monkeypatch.setenv("VSYNC_PASSPHRASE", passphrase)
        with vsync_open() as v:
            assert v.get_env("HELLO") == "world"
    finally:
        _set_s3_fetcher(None)


def test_kdf_salt_returns_24_char_cli_salt_unchanged():
    cli_salt = "20ZiDJFKLLkDsDUiWSMn3g=="
    cfg = _cfg(salt=cli_salt)
    result = _kdf_salt(cfg)
    assert isinstance(result, str), (
        f"_kdf_salt must return str (Convention A), got {type(result).__name__} "
        "— a `bytes` return is the convention-B regression signature"
    )
    assert result == cli_salt
    assert len(result) == 24, "the 24-char wire shape must round-trip verbatim"


# ─── open_with — direct-config open path (v0.12 §4.1, §4.5) ────────────
#
# open_with(config, passphrase, defaults=None) accepts the two bootstrap
# strings directly instead of reading them from the env. Same handle,
# same behavior from there on. Aimed at callers that fetch their
# bootstrap from KMS / Vault / a custom secrets layer rather than from
# the process environment.


def test_open_with_accepts_string_config_and_passphrase(monkeypatch):
    """Happy path: pass the config blob string + passphrase string directly,
    return a working Vsync handle."""
    from vsync_s3_client.crypto import encrypt_rqe1_for_test

    salt = _TEST_SALT_STR
    passphrase = "direct-passphrase"
    vault_json = json.dumps({"K": "from-direct"}).encode()
    bundle = encrypt_rqe1_for_test(vault_json, passphrase, salt)
    manifest = b"RQEM0001" + b"20260601-000000" + b"meta"

    def fetcher(cfg):
        return manifest, bundle, 11

    _set_s3_fetcher(fetcher)
    try:
        # No env vars set — open_with takes the strings directly.
        for var in ("VSYNC_CONFIG", "VSYNC_CONFIG_FILE", "VSYNC_PASSPHRASE", "VSYNC_PASSPHRASE_FILE"):
            monkeypatch.delenv(var, raising=False)
        v = open_with(config=_make_config_blob(), passphrase=passphrase)
        try:
            assert v.get_env("K") == "from-direct"
            assert v.generation() == 11
        finally:
            v.close()
    finally:
        _set_s3_fetcher(None)


def test_open_with_raises_on_empty_config(monkeypatch):
    """Empty config string → ConfigMissingError (same validation as open())."""
    for var in ("VSYNC_CONFIG", "VSYNC_CONFIG_FILE", "VSYNC_PASSPHRASE", "VSYNC_PASSPHRASE_FILE"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(ConfigMissingError):
        open_with(config="", passphrase="pp")


def test_open_with_raises_on_none_config(monkeypatch):
    """None config → ConfigMissingError."""
    for var in ("VSYNC_CONFIG", "VSYNC_CONFIG_FILE", "VSYNC_PASSPHRASE", "VSYNC_PASSPHRASE_FILE"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(ConfigMissingError):
        open_with(config=None, passphrase="pp")  # type: ignore[arg-type]


def test_open_with_raises_on_empty_passphrase(monkeypatch):
    """Empty passphrase string → ConfigMissingError."""
    for var in ("VSYNC_CONFIG", "VSYNC_CONFIG_FILE", "VSYNC_PASSPHRASE", "VSYNC_PASSPHRASE_FILE"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(ConfigMissingError):
        open_with(config=_make_config_blob(), passphrase="")


def test_open_with_raises_on_none_passphrase(monkeypatch):
    """None passphrase → ConfigMissingError."""
    for var in ("VSYNC_CONFIG", "VSYNC_CONFIG_FILE", "VSYNC_PASSPHRASE", "VSYNC_PASSPHRASE_FILE"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(ConfigMissingError):
        open_with(config=_make_config_blob(), passphrase=None)  # type: ignore[arg-type]


def test_open_with_threads_defaults_to_handle(monkeypatch):
    """defaults={...} kwarg flows through to the handle's fallback chain."""
    from vsync_s3_client.crypto import encrypt_rqe1_for_test

    passphrase = "pp"
    vault_json = json.dumps({}).encode()  # empty vault — defaults win
    bundle = encrypt_rqe1_for_test(vault_json, passphrase, _TEST_SALT_STR)
    manifest = b"RQEM0001" + b"20260601-000000" + b"meta"

    def fetcher(cfg):
        return manifest, bundle, 0

    _set_s3_fetcher(fetcher)
    try:
        for var in ("VSYNC_CONFIG", "VSYNC_CONFIG_FILE", "VSYNC_PASSPHRASE", "VSYNC_PASSPHRASE_FILE", "PORT"):
            monkeypatch.delenv(var, raising=False)
        v = open_with(
            config=_make_config_blob(),
            passphrase=passphrase,
            defaults={"PORT": "8080"},
        )
        try:
            assert v.get_env("PORT") == "8080"
            assert v.env_source("PORT") == "default"
        finally:
            v.close()
    finally:
        _set_s3_fetcher(None)


def test_open_with_returns_same_handle_shape_as_open(monkeypatch):
    """Both paths return a Vsync — same instance type, same methods."""
    from vsync_s3_client.crypto import encrypt_rqe1_for_test

    passphrase = "pp"
    vault_json = json.dumps({"X": "y"}).encode()
    bundle = encrypt_rqe1_for_test(vault_json, passphrase, _TEST_SALT_STR)
    manifest = b"RQEM0001" + b"20260601-000000" + b"meta"

    def fetcher(cfg):
        return manifest, bundle, 0

    _set_s3_fetcher(fetcher)
    try:
        monkeypatch.setenv("VSYNC_CONFIG", _make_config_blob())
        monkeypatch.setenv("VSYNC_PASSPHRASE", passphrase)
        v_open = vsync_open()
        v_open_with = open_with(config=_make_config_blob(), passphrase=passphrase)
        try:
            assert type(v_open) is type(v_open_with)
            assert isinstance(v_open_with, Vsync)
            for method in (
                "get_env", "has_env", "env_source", "get_as_content",
                "generation", "remote_generation", "has_new_version", "close",
            ):
                assert hasattr(v_open_with, method)
                assert callable(getattr(v_open_with, method))
        finally:
            v_open.close()
            v_open_with.close()
    finally:
        _set_s3_fetcher(None)


def test_open_with_yields_byte_identical_decryption_as_open_for_same_inputs(monkeypatch):
    """Load-bearing parity: the same (config, passphrase) decrypts to the same
    bytes whether read from env via open() or passed via open_with()."""
    from vsync_s3_client.crypto import encrypt_rqe1_for_test

    passphrase = "parity-pp"
    plaintext = json.dumps({"A": "alpha", "B": "beta"}).encode()
    bundle = encrypt_rqe1_for_test(plaintext, passphrase, _TEST_SALT_STR)
    manifest = b"RQEM0001" + b"20260601-000000" + b"meta"

    def fetcher(cfg):
        return manifest, bundle, 42

    _set_s3_fetcher(fetcher)
    try:
        config_blob = _make_config_blob()
        monkeypatch.setenv("VSYNC_CONFIG", config_blob)
        monkeypatch.setenv("VSYNC_PASSPHRASE", passphrase)
        v_env = vsync_open()
        # Clear env so open_with isn't accidentally picking up anything.
        for var in ("VSYNC_CONFIG", "VSYNC_PASSPHRASE"):
            monkeypatch.delenv(var, raising=False)
        v_direct = open_with(config=config_blob, passphrase=passphrase)
        try:
            for k in ("A", "B"):
                assert v_env.get_env(k) == v_direct.get_env(k)
            assert v_env.generation() == v_direct.generation() == 42
        finally:
            v_env.close()
            v_direct.close()
    finally:
        _set_s3_fetcher(None)


# ─── remote_generation / has_new_version (v0.12 §4.1, §7.1) ────────────


def _open_with_fetcher(monkeypatch, fetcher, passphrase="pp", payload_kv=None):
    """Helper: drive open() through an injected fetcher and return the handle."""
    from vsync_s3_client.crypto import encrypt_rqe1_for_test

    salt = _TEST_SALT_STR
    vault_json = json.dumps(payload_kv or {"X": "y"}).encode()
    bundle = encrypt_rqe1_for_test(vault_json, passphrase, salt)
    manifest = b"RQEM0001" + b"20260601-000000" + b"meta"
    _set_s3_fetcher(fetcher(manifest, bundle))
    monkeypatch.setenv("VSYNC_CONFIG", _make_config_blob())
    monkeypatch.setenv("VSYNC_PASSPHRASE", passphrase)
    return vsync_open()


def test_remote_generation_returns_remote_gen(monkeypatch):
    calls = {"n": 0}

    def make_fetcher(manifest, bundle):
        def fetcher(cfg):
            calls["n"] += 1
            gen = 5 if calls["n"] == 1 else 7
            return manifest, bundle, gen
        return fetcher

    _reset_singleton()
    try:
        v = _open_with_fetcher(monkeypatch, make_fetcher)
        try:
            assert v.generation() == 5
            assert v.remote_generation() == 7
            assert v.generation() == 5
        finally:
            v.close()
    finally:
        _set_s3_fetcher(None)


def test_remote_generation_raises_on_network_failure(monkeypatch):
    state = {"open_done": False}

    def make_fetcher(manifest, bundle):
        def fetcher(cfg):
            if not state["open_done"]:
                state["open_done"] = True
                return manifest, bundle, 3
            raise S3UnreachableError("simulated network failure")
        return fetcher

    _reset_singleton()
    try:
        v = _open_with_fetcher(monkeypatch, make_fetcher)
        try:
            with pytest.raises(S3UnreachableError):
                v.remote_generation()
        finally:
            v.close()
    finally:
        _set_s3_fetcher(None)


def test_remote_generation_raises_on_manifest_404(monkeypatch):
    state = {"open_done": False}

    def make_fetcher(manifest, bundle):
        def fetcher(cfg):
            if not state["open_done"]:
                state["open_done"] = True
                return manifest, bundle, 3
            raise ManifestNotFoundError("simulated manifest 404")
        return fetcher

    _reset_singleton()
    try:
        v = _open_with_fetcher(monkeypatch, make_fetcher)
        try:
            with pytest.raises(ManifestNotFoundError):
                v.remote_generation()
        finally:
            v.close()
    finally:
        _set_s3_fetcher(None)


def test_has_new_version_when_local_is_behind(monkeypatch):
    calls = {"n": 0}

    def make_fetcher(manifest, bundle):
        def fetcher(cfg):
            calls["n"] += 1
            return manifest, bundle, 3 if calls["n"] == 1 else 4
        return fetcher

    _reset_singleton()
    try:
        v = _open_with_fetcher(monkeypatch, make_fetcher)
        try:
            assert v.has_new_version() is True
        finally:
            v.close()
    finally:
        _set_s3_fetcher(None)


def test_has_new_version_when_local_is_current(monkeypatch):
    def make_fetcher(manifest, bundle):
        def fetcher(cfg):
            return manifest, bundle, 5
        return fetcher

    _reset_singleton()
    try:
        v = _open_with_fetcher(monkeypatch, make_fetcher)
        try:
            assert v.has_new_version() is False
        finally:
            v.close()
    finally:
        _set_s3_fetcher(None)


def test_has_new_version_when_local_is_ahead(monkeypatch):
    calls = {"n": 0}

    def make_fetcher(manifest, bundle):
        def fetcher(cfg):
            calls["n"] += 1
            return manifest, bundle, 10 if calls["n"] == 1 else 8
        return fetcher

    _reset_singleton()
    try:
        v = _open_with_fetcher(monkeypatch, make_fetcher)
        try:
            assert v.has_new_version() is False
        finally:
            v.close()
    finally:
        _set_s3_fetcher(None)
