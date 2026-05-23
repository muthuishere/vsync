"""Public Vsync handle + module-level open()/get() facade.

This binds together:
  - `sources.resolve_bootstrap_inputs` (the two-env-var contract)
  - `config_blob.decode_config_blob` (VSYNC_CONFIG decode)
  - `manifest.unwrap_rqem0001` (RQEM0001 read)
  - `crypto.decrypt_rqe1` (RQE1 decrypt)
  - `assetpath.AssetMaterializer` (lazy 0600 tempfile for asset_path)
  - the fallback chain (vault → env → defaults → missing)

Vault wire format inside the decrypted bundle (v0.12 §6 is implicit on
this; documented here for the Python reader): JSON object at the root
with two optional top-level keys:

    {
      "kv": {"DATABASE_URL": "postgres://...", ...},   // scalars
      "assets": {"svc.json": "<base64-of-bytes>", ...}  // binary blobs
    }

Backwards-compat: a root-level flat object is treated as `kv` only (no
assets). The conformance corpus's `fallback-chain` vectors are flat, so
this branch is exercised.

S3 read path (per v0.10/§3.3): the manifest object is at
``<prefix>manifest`` and its embedded ts names the bundle key
``<prefix>v=<ts>``. The library does ONE round trip (manifest fetch +
bundle fetch + decrypt) and never refreshes — restart the process to
pick up a new vault. (v0.12 §7.)
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any, Dict, Mapping, Optional, Tuple, Union

from .assetpath import AssetMaterializer
from .config_blob import VsyncConfig, decode_config_blob
from .crypto import decrypt_rqe1
from .exceptions import (
    BundleCorruptError,
    ConfigMissingError,
    ManifestNotFoundError,
    S3UnreachableError,
    VSyncError,
)
from .manifest import unwrap_rqem0001
from .sources import resolve_bootstrap_inputs

Source = str  # one of: "vault", "env", "default", "missing"


def _parse_vault_payload(payload: bytes) -> Tuple[Dict[str, str], Dict[str, bytes]]:
    """Decode the decrypted bundle plaintext into (kv, assets)."""
    try:
        obj = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise BundleCorruptError(
            f"vault payload is not valid UTF-8 JSON: {e}"
        ) from e
    if not isinstance(obj, dict):
        raise BundleCorruptError(
            f"vault payload root must be a JSON object, got {type(obj).__name__}"
        )
    kv: Dict[str, str] = {}
    assets: Dict[str, bytes] = {}
    if "kv" in obj or "assets" in obj:
        raw_kv = obj.get("kv", {}) or {}
        raw_assets = obj.get("assets", {}) or {}
        if not isinstance(raw_kv, dict) or not isinstance(raw_assets, dict):
            raise BundleCorruptError(
                "vault payload: `kv` and `assets` must be JSON objects"
            )
        for k, v in raw_kv.items():
            if not isinstance(v, str):
                raise BundleCorruptError(
                    f"vault payload: kv[{k!r}] must be a string, got {type(v).__name__}"
                )
            kv[k] = v
        for k, v in raw_assets.items():
            if not isinstance(v, str):
                raise BundleCorruptError(
                    f"vault payload: assets[{k!r}] must be a base64 string"
                )
            try:
                assets[k] = base64.b64decode(v)
            except Exception as e:  # noqa: BLE001
                raise BundleCorruptError(
                    f"vault payload: assets[{k!r}] is not valid base64: {e}"
                ) from e
    else:
        # Flat-object backwards-compat shape (also what the fallback-chain
        # conformance vectors use): every value is a string KV.
        for k, v in obj.items():
            if not isinstance(v, str):
                raise BundleCorruptError(
                    f"vault payload: {k!r} must be a string, got {type(v).__name__}"
                )
            kv[k] = v
    return kv, assets


class Vsync:
    """In-memory accessor for a decrypted vault.

    Construct via the module-level `open()`. Tests can construct directly
    with `_from_vault(...)` to bypass S3.
    """

    def __init__(
        self,
        *,
        kv: Mapping[str, str],
        assets: Mapping[str, bytes],
        generation: int,
        env: str,
        defaults: Optional[Mapping[str, str]] = None,
    ) -> None:
        self._kv: Dict[str, str] = dict(kv)
        self._assets: Dict[str, bytes] = dict(assets)
        self._defaults: Dict[str, str] = dict(defaults or {})
        self._generation: int = int(generation)
        self._env: str = env
        self._closed: bool = False
        self._asset_materializer: Optional[AssetMaterializer] = None

    # ─── Fallback chain (v0.12 §5) ──────────────────────────────────────

    def get(self, key: str) -> Optional[str]:
        """Resolve `key` through vault → env → defaults → missing."""
        if self._closed:
            raise ValueError("Vsync: handle is closed")
        if key in self._kv:
            return self._kv[key]
        # `os.environ` is consulted at lookup time, not at open time, so a
        # process that mutates its env after Open() sees the change.
        v = os.environ.get(key)
        if v is not None:
            return v
        if key in self._defaults:
            return self._defaults[key]
        return None

    def has(self, key: str) -> bool:
        """True iff vault, env, or defaults would resolve `key`."""
        if self._closed:
            raise ValueError("Vsync: handle is closed")
        return (
            key in self._kv
            or key in os.environ
            or key in self._defaults
        )

    def source(self, key: str) -> Source:
        """Name the step in the fallback chain that wins (or 'missing').

        Safe to log — never returns the value itself, only the label.
        """
        if self._closed:
            raise ValueError("Vsync: handle is closed")
        if key in self._kv:
            return "vault"
        if key in os.environ:
            return "env"
        if key in self._defaults:
            return "default"
        return "missing"

    # ─── Asset accessors (v0.12 §6) ────────────────────────────────────

    def asset_bytes(self, name: str) -> bytes:
        """Return the binary asset's bytes. Never touches the filesystem.

        Preferred over `asset_path` in new code.
        """
        if self._closed:
            raise ValueError("Vsync: handle is closed")
        # Asset lookup falls through KV when the value happens to be stored
        # there as a scalar — handy for the conformance corpus where vault
        # values are bytes-as-strings (see `asset-path` README, where the
        # vault[key] entry is "<binary — see .bin>" and the .bin is the
        # source of truth). The harness loads the .bin and overrides the
        # KV at construction time, so this branch sees the raw bytes.
        if name in self._assets:
            return self._assets[name]
        if name in self._kv:
            # KV may carry asset bytes when they happen to be UTF-8 (PEMs,
            # JSON) — the caller asked for bytes, so encode.
            return self._kv[name].encode("utf-8")
        raise KeyError(
            f"vsync: asset {name!r} not in vault (assets keys: "
            f"{list(self._assets)!r}, kv keys with this name: "
            f"{name in self._kv})"
        )

    def asset_path(self, name: str) -> str:
        """Lazily materialize the asset bytes to a 0600 tempfile; return path.

        Repeated calls with the same `name` return the cached path. The
        per-handle tempdir is created on first call (mode 0700) and removed
        on `close()`. SIGKILL → leak; see v0.12 §6.
        """
        if self._closed:
            raise ValueError("Vsync: handle is closed")
        if self._asset_materializer is None:
            self._asset_materializer = AssetMaterializer()
        return self._asset_materializer.materialize(name, self.asset_bytes(name))

    # ─── Bundle metadata ───────────────────────────────────────────────

    def generation(self) -> int:
        """Monotonic gen counter from the manifest meta cell. Safe to log."""
        return self._generation

    # ─── Lifecycle ─────────────────────────────────────────────────────

    def close(self) -> None:
        """Idempotent best-effort cleanup. Drops the vault, unlinks tempfiles."""
        if self._closed:
            return
        self._closed = True
        self._kv.clear()
        self._assets.clear()
        if self._asset_materializer is not None:
            self._asset_materializer.close()
            self._asset_materializer = None

    def __enter__(self) -> "Vsync":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    # ─── Redaction-safe representation (v0.12 §12) ──────────────────────

    def __repr__(self) -> str:
        return f"<vsync:redacted gen={self._generation} env={self._env}>"

    __str__ = __repr__

    # ─── Internal test hook ─────────────────────────────────────────────

    @classmethod
    def _from_vault(
        cls,
        *,
        kv: Optional[Mapping[str, str]] = None,
        assets: Optional[Mapping[str, bytes]] = None,
        generation: int = 0,
        env: str = "test",
        defaults: Optional[Mapping[str, str]] = None,
    ) -> "Vsync":
        """Construct a Vsync without an S3 round-trip — for unit tests + the
        conformance loader. Production callers must use `open()`.
        """
        return cls(
            kv=kv or {},
            assets=assets or {},
            generation=generation,
            env=env,
            defaults=defaults,
        )


# ─── Module-level facade ───────────────────────────────────────────────

# Pluggable S3 fetcher; tests swap this for an in-memory fake.
_S3_FETCHER = None


def _set_s3_fetcher(fetcher):
    """Test hook — set to None to restore the real boto3-backed fetcher."""
    global _S3_FETCHER
    _S3_FETCHER = fetcher


def _default_s3_fetcher(cfg: VsyncConfig) -> Tuple[bytes, bytes, int]:
    """Real fetcher — one round trip: HEAD/GET manifest, then GET bundle.

    Returns (manifest_bytes, bundle_bytes, generation).

    Manifest layout on S3 (v0.10 §3.3):
      object key  = ``<cfg.prefix>manifest`` (where prefix already contains env)
      object body = RQEM0001 envelope; embedded ts names the bundle key
                    ``<cfg.prefix>v=<ts>``
      meta cell (separate object at ``<prefix>latest.meta``) is OPTIONAL
                    and carries `gen=N`. Absent / unreadable → gen=0.

    Network/IAM failures → S3UnreachableError. 404 on the manifest →
    ManifestNotFoundError (the bucket exists, the env hasn't been pushed
    yet — `vsync push <env>` first).
    """
    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:  # pragma: no cover - boto3 is a hard dep
        raise S3UnreachableError(f"boto3 import failed: {e}") from e

    client = boto3.client(
        "s3",
        endpoint_url=cfg.endpoint,
        region_name=cfg.region,
        aws_access_key_id=cfg.access_key_id,
        aws_secret_access_key=cfg.secret_access_key,
    )
    manifest_key = f"{cfg.prefix}manifest"
    try:
        resp = client.get_object(Bucket=cfg.bucket, Key=manifest_key)
        manifest_bytes = resp["Body"].read()
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in ("NoSuchKey", "404") or status == 404:
            raise ManifestNotFoundError(
                f"vsync: s3://{cfg.bucket}/{manifest_key} is 404 — "
                f"run `vsync push {cfg.env}` once before booting apps"
            ) from e
        raise S3UnreachableError(
            f"vsync: cannot read s3://{cfg.bucket}/{manifest_key}: {e}"
        ) from e
    except BotoCoreError as e:
        raise S3UnreachableError(
            f"vsync: network / endpoint error reaching {cfg.endpoint}: {e}"
        ) from e

    ts, _meta_payload = unwrap_rqem0001(manifest_bytes)
    bundle_key = f"{cfg.prefix}v={ts}"
    try:
        resp = client.get_object(Bucket=cfg.bucket, Key=bundle_key)
        bundle_bytes = resp["Body"].read()
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in ("NoSuchKey", "404") or status == 404:
            raise BundleCorruptError(
                f"vsync: manifest points at s3://{cfg.bucket}/{bundle_key} "
                "but the object is 404 — the bucket is in a torn state; re-push"
            ) from e
        raise S3UnreachableError(
            f"vsync: cannot read s3://{cfg.bucket}/{bundle_key}: {e}"
        ) from e
    except BotoCoreError as e:
        raise S3UnreachableError(
            f"vsync: network error fetching bundle: {e}"
        ) from e

    # Optional meta cell carries the gen counter.
    gen = 0
    try:
        meta_resp = client.get_object(Bucket=cfg.bucket, Key=f"{cfg.prefix}latest.meta")
        meta = json.loads(meta_resp["Body"].read().decode("utf-8"))
        if isinstance(meta, dict) and isinstance(meta.get("gen"), int):
            gen = meta["gen"]
    except ClientError:
        pass  # pre-rotation bundle has no meta cell — gen stays 0
    except (BotoCoreError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        pass

    return manifest_bytes, bundle_bytes, gen


def open(  # noqa: A001 - matches spec API verbatim (v0.12 §4.1)
    *,
    defaults: Optional[Mapping[str, str]] = None,
) -> "Vsync":
    """Read env, fetch from S3, decrypt, return a Vsync handle.

    One round trip. No retries on success. No refresh. Restart the
    process to pick up a new vault.
    """
    config_blob, passphrase = resolve_bootstrap_inputs()
    cfg = decode_config_blob(config_blob)

    fetcher = _S3_FETCHER or _default_s3_fetcher
    try:
        manifest_bytes, bundle_bytes, gen = fetcher(cfg)
    except VSyncError:
        raise
    except Exception as e:  # noqa: BLE001 - normalise to the taxonomy
        raise S3UnreachableError(f"vsync: S3 fetch failed: {e}") from e

    # Sanity-check manifest one more time (mostly belt-and-braces — the
    # default fetcher already unwrapped it).
    _ts, _meta = unwrap_rqem0001(manifest_bytes)
    plaintext = decrypt_rqe1(
        bundle_bytes, passphrase, _kdf_salt(cfg), iterations=cfg.iterations
    )
    kv, assets = _parse_vault_payload(plaintext)
    return Vsync(
        kv=kv,
        assets=assets,
        generation=gen,
        env=cfg.env,
        defaults=defaults,
    )


def _kdf_salt(cfg: VsyncConfig) -> str:
    """Salt the PBKDF2 derivation uses. The CLI's `runtime-token` mints
    it into the blob (v0.12 §2.1 post-revision); we just pass it through."""
    return cfg.salt


# ─── Module-level singleton (v0.12 §4.1, convenience for scripts) ──────

_SINGLETON: Optional[Vsync] = None


def get(key: str) -> Optional[str]:
    """Convenience: open() on first call, then resolve `key`.

    Long-running apps should hold a `Vsync` handle explicitly so they
    control its lifecycle (and so `close()` actually runs). Scripts and
    one-shot tools can lean on this helper.
    """
    global _SINGLETON
    if _SINGLETON is None:
        _SINGLETON = open()
    return _SINGLETON.get(key)


def _reset_singleton() -> None:
    """Test hook — reset module-level state between tests."""
    global _SINGLETON
    if _SINGLETON is not None:
        try:
            _SINGLETON.close()
        finally:
            _SINGLETON = None


__all__ = ["Vsync", "open", "get"]
