"""Cross-language conformance suite for the Python vsync-s3-client.

Walks `docs/specs/test-vectors/<category>/*.json`, pairs the sibling
`.bin` if present, and runs a category-specific assertion. Per v0.11
§7 / §5, error class identity is matched on `__class__.__name__` — not
on a generic `Exception` catch.

Known deviation: `rqe1-decrypt-error/truncated-ciphertext` expects
`BundleCorruptError` but the AES-GCM library yields the same tag-failure
signal for a clipped tag as for a tampered tag; this lib uniformly
surfaces `WrongPassphraseError`. Flagged to team-lead — see Wave 5
report. Marked as `xfail` here so the rest of the corpus runs green and
CI is honest about the gap.
"""

from __future__ import annotations

from typing import Optional, Type

import pytest

from vsync_s3_client import Vsync
from vsync_s3_client.client import _parse_vault_payload
from vsync_s3_client.config_blob import decode_config_blob
from vsync_s3_client.crypto import decrypt_rqe1
from vsync_s3_client.exceptions import (
    BundleCorruptError,
    ConfigMissingError,
    ConfigUnsupportedVersionError,
    ManifestNotFoundError,
    S3UnreachableError,
    UnsupportedSpecVersionError,
    VSyncError,
    WrongPassphraseError,
)
from vsync_s3_client.manifest import (
    unwrap_rqem0001,
    verify_against_remote_ts,
)

from tests.conformance.loader import Vector, iter_all, iter_category


# Canonical taxonomy name → Python class. Names match v0.12 §11 exactly.
ERROR_CLASS: dict[str, Type[VSyncError]] = {
    "ConfigMissingError": ConfigMissingError,
    "ConfigUnsupportedVersionError": ConfigUnsupportedVersionError,
    "S3UnreachableError": S3UnreachableError,
    "ManifestNotFoundError": ManifestNotFoundError,
    "WrongPassphraseError": WrongPassphraseError,
    "BundleCorruptError": BundleCorruptError,
    "UnsupportedSpecVersionError": UnsupportedSpecVersionError,
}


# Vectors that surface a different (but defensible) error class than what
# the corpus pins. Empty today — Hari regenerated `truncated-ciphertext`
# to be structurally short (< 32 bytes) and the structural threshold in
# `crypto.decrypt_rqe1` catches it as BundleCorruptError. Kept here as a
# hook for any future spec-vs-impl drift to be flagged explicitly rather
# than silently skipped.
#
# Honest limit (worth noting in the spec amendment): RQE1 truncation
# detection is best-effort — structurally-short envelopes are detected,
# but mid-payload truncation that lands at a tag boundary is
# indistinguishable from a wrong-passphrase tag failure. That's GCM
# without explicit plaintext-length, not a lib bug.
SPEC_AMBIGUITIES: dict[str, tuple[str, str]] = {}


def _assert_raises_named(name: str, fn) -> None:
    """Assert `fn()` raises an exception whose class name == `name`."""
    expected_cls = ERROR_CLASS.get(name)
    if expected_cls is None:
        pytest.fail(f"unknown canonical error name {name!r} in vector")
    try:
        fn()
    except expected_cls as e:
        assert type(e).__name__ == name
        return
    except VSyncError as e:
        pytest.fail(
            f"expected {name}, got {type(e).__name__}: {e}"
        )
    except Exception as e:  # noqa: BLE001
        pytest.fail(
            f"expected {name}, got generic {type(e).__name__}: {e}"
        )
    pytest.fail(f"expected {name}, no exception raised")


# ─── Category dispatchers ──────────────────────────────────────────────


def _run_rqe1_positive(v: Vector) -> None:
    blob = v.bin_bytes
    assert blob is not None, f"{v}: .bin required for positive RQE1"
    passphrase = v.meta["inputs"]["passphrase"]
    salt = v.meta["inputs"]["salt"]
    out = decrypt_rqe1(blob, passphrase, salt)
    expected_hex = v.meta["expected"]["plaintext_hex"]
    assert out.hex() == expected_hex, (
        f"{v}: plaintext mismatch — got {out.hex()!r}, expected {expected_hex!r}"
    )


def _run_rqe1_negative(v: Vector) -> None:
    blob = v.bin_bytes
    assert blob is not None, f"{v}: .bin required for negative RQE1"
    passphrase = v.meta["inputs"]["passphrase"]
    salt = v.meta["inputs"]["salt"]
    err = v.meta["expected"]["error"]
    _assert_raises_named(err, lambda: decrypt_rqe1(blob, passphrase, salt))


def _run_manifest(v: Vector) -> None:
    blob = v.bin_bytes
    assert blob is not None, f"{v}: .bin required for manifest"
    expected = v.meta["expected"]
    remote_ts = v.meta["inputs"].get("remote_ts")
    err = expected.get("error")
    if err:
        if remote_ts is not None:
            _assert_raises_named(err, lambda: verify_against_remote_ts(blob, remote_ts))
        else:
            _assert_raises_named(err, lambda: unwrap_rqem0001(blob))
        return
    ts, payload = verify_against_remote_ts(blob, remote_ts)
    assert ts == expected["embedded_ts"], (
        f"{v}: ts mismatch — got {ts!r}, expected {expected['embedded_ts']!r}"
    )
    assert payload.hex() == expected["payload_hex"], (
        f"{v}: payload mismatch"
    )


def _run_config_blob(v: Vector) -> None:
    blob = v.bin_bytes
    assert blob is not None, f"{v}: .bin required for config-blob"
    expected = v.meta["expected"]
    err = expected.get("error")
    if err:
        _assert_raises_named(err, lambda: decode_config_blob(blob))
        return
    cfg = decode_config_blob(blob)
    want = expected["config_json"]
    # Map snake_case → camelCase to compare against the wire form.
    got = {
        "v": cfg.v,
        "endpoint": cfg.endpoint,
        "region": cfg.region,
        "bucket": cfg.bucket,
        "accessKeyId": cfg.access_key_id,
        "secretAccessKey": cfg.secret_access_key,
        "prefix": cfg.prefix,
        "env": cfg.env,
        "salt": cfg.salt,
        "iterations": cfg.iterations,
    }
    assert got == want, f"{v}: config JSON mismatch — got {got!r}, want {want!r}"


def _run_fallback_chain(v: Vector, monkeypatch) -> None:
    inputs = v.meta["inputs"]
    vault = inputs.get("vault") or {}
    env_overrides = inputs.get("env") or {}
    defaults = inputs.get("defaults") or {}
    queries = inputs.get("queries") or []
    expected_results = v.meta["expected"]["results"]

    # Wipe + apply the simulated process env exactly.
    for k in list(env_overrides.keys()) + [r["key"] for r in expected_results]:
        monkeypatch.delenv(k, raising=False)
    for k, val in env_overrides.items():
        monkeypatch.setenv(k, val)

    handle = Vsync._from_vault(kv=vault, defaults=defaults)
    try:
        for q, want in zip(queries, expected_results):
            assert handle.get_env(q) == want["value"], f"{v}: get_env({q!r})"
            assert handle.env_source(q) == want["source"], f"{v}: env_source({q!r})"
            assert handle.has_env(q) == want["has"], f"{v}: has_env({q!r})"
    finally:
        handle.close()


def _run_asset_path(v: Vector) -> None:
    """Bytes-only assertion per v0.12: get_as_content(name) returns the
    expected bytes. The corpus's `asset-path` category name is internal —
    what matters is bytes parity. The mode_octal field is ignored (no
    tempfile materialization in the lib anymore — operators write their
    own if their SDK needs a path).
    """
    expected = v.meta["expected"]
    inputs = v.meta["inputs"]
    key = inputs["key"]
    assert v.bin_bytes is not None, f"{v}: asset bytes (.bin) required"
    handle = Vsync._from_vault(assets={key: v.bin_bytes})
    try:
        bytes_back = handle.get_as_content(key)
        assert bytes_back == bytes.fromhex(expected["bytes_hex"]), (
            f"{v}: get_as_content bytes mismatch"
        )
    finally:
        handle.close()


def _run_error_taxonomy(v: Vector) -> None:
    err = v.meta["expected"]["error"]
    name = v.name
    bin_bytes = v.bin_bytes

    # Per-vector dispatch — error-taxonomy spans multiple wire layers
    # (config, RQE1, RQEM0001) and a couple of API-driven scenarios.
    if name == "config-missing":
        # The vector has no bytes and no `passphrase`/`salt` — surface as
        # ConfigMissingError when neither bootstrap input is set.
        from vsync_s3_client.sources import resolve_bootstrap_inputs
        _assert_raises_named(
            err,
            lambda: resolve_bootstrap_inputs(env={}),  # explicit empty env
        )
        return
    if name == "s3-unreachable" or name == "manifest-not-found":
        # No bytes; this is a runtime scenario. Drive it by injecting a
        # fetcher that raises the right error and exercising open().
        from vsync_s3_client.client import (
            _set_s3_fetcher,
            _reset_singleton,
        )
        from vsync_s3_client import open as vsync_open
        import gzip
        import base64
        import json as _json
        import os as _os

        # Minimal valid VSYNC_CONFIG so we get past the bootstrap layer.
        inner = _json.dumps(
            {
                "v": 1,
                "endpoint": "https://s3.example.com",
                "region": "us-east-1",
                "bucket": "b",
                "accessKeyId": "k",
                "secretAccessKey": "s",
                "prefix": "p/",
                "env": "test",
                "salt": "AAAAAAAAAAAAAAAAAAAAAA==",  # 16 raw bytes, base64
                "iterations": 600000,
            }
        ).encode()
        body = base64.urlsafe_b64encode(gzip.compress(inner)).rstrip(b"=").decode()
        prev = {}
        for k, val in (
            ("VSYNC_CONFIG", f"vsync-cfg-v1:{body}"),
            ("VSYNC_PASSPHRASE", "pp"),
        ):
            prev[k] = _os.environ.get(k)
            _os.environ[k] = val

        def fetcher(cfg):
            if name == "manifest-not-found":
                raise ManifestNotFoundError("simulated 404 on <prefix>manifest")
            raise S3UnreachableError("simulated network failure")

        _set_s3_fetcher(fetcher)
        _reset_singleton()
        try:
            _assert_raises_named(err, vsync_open)
        finally:
            _set_s3_fetcher(None)
            _reset_singleton()
            for k, val in prev.items():
                if val is None:
                    _os.environ.pop(k, None)
                else:
                    _os.environ[k] = val
        return

    if name == "config-unsupported-version":
        assert bin_bytes is not None
        _assert_raises_named(err, lambda: decode_config_blob(bin_bytes))
        return

    if name in ("wrong-passphrase", "bundle-corrupt", "unsupported-spec-version"):
        assert bin_bytes is not None
        passphrase = v.meta["inputs"]["passphrase"]
        salt = v.meta["inputs"]["salt"]
        _assert_raises_named(
            err, lambda: decrypt_rqe1(bin_bytes, passphrase, salt)
        )
        return

    pytest.fail(f"{v}: error-taxonomy dispatcher has no branch for name {name!r}")


# ─── Pytest entry points ───────────────────────────────────────────────


def _id(v: Vector) -> str:
    return f"{v.category}/{v.name}"


def _vectors_for(category: str) -> list[Vector]:
    return list(iter_category(category))


@pytest.mark.parametrize("v", _vectors_for("rqe1-decrypt"), ids=_id)
def test_rqe1_decrypt(v: Vector) -> None:
    _run_rqe1_positive(v)


@pytest.mark.parametrize("v", _vectors_for("rqe1-decrypt-error"), ids=_id)
def test_rqe1_decrypt_error(v: Vector) -> None:
    full_id = f"{v.category}/{v.name}"
    if full_id in SPEC_AMBIGUITIES:
        actual, reason = SPEC_AMBIGUITIES[full_id]
        # Skip with a loud, traceable reason rather than xfail — pytest's
        # dynamic xfail interacts poorly with `pytest.fail()` inside helper
        # functions and reports XPASS even when the helper failed. A skip
        # is honest: "we know this vector doesn't conform; here's why."
        # Captured in the wave-5 report so the team can review.
        pytest.skip(
            f"spec-ambiguity: lib raises {actual} instead of "
            f"{v.expected_error} — {reason}"
        )
    _run_rqe1_negative(v)


@pytest.mark.parametrize("v", _vectors_for("rqem0001-manifest"), ids=_id)
def test_rqem0001_manifest(v: Vector) -> None:
    _run_manifest(v)


@pytest.mark.parametrize("v", _vectors_for("config-blob"), ids=_id)
def test_config_blob(v: Vector) -> None:
    _run_config_blob(v)


@pytest.mark.parametrize("v", _vectors_for("fallback-chain"), ids=_id)
def test_fallback_chain(v: Vector, monkeypatch) -> None:
    _run_fallback_chain(v, monkeypatch)


@pytest.mark.parametrize("v", _vectors_for("asset-path"), ids=_id)
def test_asset_path(v: Vector) -> None:
    _run_asset_path(v)


@pytest.mark.parametrize("v", _vectors_for("error-taxonomy"), ids=_id)
def test_error_taxonomy(v: Vector) -> None:
    _run_error_taxonomy(v)


def test_corpus_is_non_empty() -> None:
    """Sanity check: the corpus is actually present and discovered.

    A silent empty corpus would cause every parametrized test above to
    report 0 collected — and CI would still pass. Make the gap explicit.
    """
    vecs = list(iter_all())
    assert len(vecs) >= 20, (
        f"conformance corpus too small ({len(vecs)} vectors found); "
        "expected ~31 across 7 categories — was it regenerated?"
    )


def test_all_categories_present() -> None:
    """Each category from v0.11 §4 must have at least one vector."""
    from collections import Counter
    counts = Counter(v.category for v in iter_all())
    for cat in (
        "rqe1-decrypt",
        "rqe1-decrypt-error",
        "rqem0001-manifest",
        "config-blob",
        "fallback-chain",
        "asset-path",
        "error-taxonomy",
    ):
        assert counts.get(cat, 0) > 0, f"missing category {cat!r}"
