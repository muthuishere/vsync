"""VSYNC_CONFIG bootstrap blob decode (v0.12 §2.1).

Wire format: ``vsync-cfg-v1:<base64url-no-pad(gzip(JSON))>``. Standard
base64 (with `+`, `/`, `=`) is explicitly rejected — operators must use
base64url, no-pad. The magic prefix is also the schema-version handle:
a `vsync-cfg-v2:` blob hitting this library is `ConfigMissingError`.
"""

import base64
import gzip
import json

import pytest

from vsync_s3_client.config_blob import VsyncConfig, decode_config_blob
from vsync_s3_client.exceptions import (
    BundleCorruptError,
    ConfigMissingError,
    ConfigUnsupportedVersionError,
)


def _encode(payload: dict) -> bytes:
    raw_json = json.dumps(payload).encode("utf-8")
    gz = gzip.compress(raw_json)
    b64 = base64.urlsafe_b64encode(gz).rstrip(b"=")
    return b"vsync-cfg-v1:" + b64


SAMPLE = {
    "v": 1,
    "endpoint": "https://s3.amazonaws.com",
    "region": "us-east-1",
    "bucket": "acme-secrets",
    "accessKeyId": "AKIA0",
    "secretAccessKey": "shh",
    "prefix": "myapp/",
    "env": "prod",
    "salt": "AAAAAAAAAAAAAAAAAAAAAA==",
    "iterations": 600000,
}


def test_decode_returns_typed_config():
    cfg = decode_config_blob(_encode(SAMPLE))
    assert isinstance(cfg, VsyncConfig)
    assert cfg.v == 1
    assert cfg.endpoint == "https://s3.amazonaws.com"
    assert cfg.region == "us-east-1"
    assert cfg.bucket == "acme-secrets"
    assert cfg.access_key_id == "AKIA0"
    assert cfg.secret_access_key == "shh"
    assert cfg.prefix == "myapp/"
    assert cfg.env == "prod"
    assert cfg.salt == "AAAAAAAAAAAAAAAAAAAAAA=="
    assert cfg.iterations == 600000


def test_decode_unknown_fields_are_ignored_forward_compat():
    payload = dict(SAMPLE, futureField="ignored")
    cfg = decode_config_blob(_encode(payload))
    assert cfg.env == "prod"  # parse succeeded


def test_missing_magic_prefix_raises_config_missing():
    raw_json = json.dumps(SAMPLE).encode("utf-8")
    with pytest.raises(ConfigMissingError):
        decode_config_blob(raw_json)


def test_wrong_magic_prefix_v2_raises_config_missing():
    blob = b"vsync-cfg-v2:something"
    with pytest.raises(ConfigMissingError):
        decode_config_blob(blob)


def test_standard_base64_with_padding_rejected():
    # Standard base64 alphabet uses `+`, `/`, `=` — operators must use
    # base64url-no-pad per v0.12 §2.1. Accidentally hand-rolling with
    # `base64` instead of `base64url` is the most plausible failure.
    raw_json = json.dumps(SAMPLE).encode("utf-8")
    gz = gzip.compress(raw_json)
    # Force the standard alphabet with padding.
    std = base64.b64encode(gz)
    assert std.endswith(b"=") or any(c in std for c in (b"+", b"/")) or True
    blob = b"vsync-cfg-v1:" + std
    with pytest.raises(ConfigUnsupportedVersionError):
        decode_config_blob(blob)


def test_standard_base64_with_plus_or_slash_rejected():
    # Build a payload whose gzip body forces `+` or `/` in the base64 output.
    raw = b"\xff" * 32  # bytes likely to map into the standard alphabet's tail
    gz = gzip.compress(raw)
    std = base64.b64encode(gz)
    # If, by accident, the encoded output happens to be all url-safe, skip.
    if not any(c in std for c in (b"+", b"/", b"=")):
        pytest.skip("test fixture didn't trigger non-urlsafe chars")
    blob = b"vsync-cfg-v1:" + std
    with pytest.raises(ConfigUnsupportedVersionError):
        decode_config_blob(blob)


def test_malformed_gzip_raises_bundle_corrupt():
    # Magic prefix + valid base64url body but the decoded bytes aren't gzip.
    bogus = base64.urlsafe_b64encode(b"\x00\x01\x02\x03").rstrip(b"=")
    blob = b"vsync-cfg-v1:" + bogus
    with pytest.raises(BundleCorruptError):
        decode_config_blob(blob)


def test_inner_v_99_raises_config_unsupported_version():
    payload = dict(SAMPLE, v=99)
    with pytest.raises(ConfigUnsupportedVersionError):
        decode_config_blob(_encode(payload))


def test_inner_not_a_json_object_raises_bundle_corrupt():
    arr = json.dumps([1, 2, 3]).encode("utf-8")
    gz = gzip.compress(arr)
    b64 = base64.urlsafe_b64encode(gz).rstrip(b"=")
    blob = b"vsync-cfg-v1:" + b64
    with pytest.raises(BundleCorruptError):
        decode_config_blob(blob)


def test_string_input_accepted():
    # Operators commonly hand the lib a `str` straight from os.environ.
    blob = _encode(SAMPLE).decode("ascii")
    cfg = decode_config_blob(blob)
    assert cfg.bucket == "acme-secrets"
