"""Redaction discipline (v0.12 §12).

The handle's `__repr__` / `__str__` must never expose secret values.
Logging the handle, sticking it in an error traceback, or pasting it
into a Sentry breadcrumb should reveal only the generation counter and
the env — never keys, values, or S3 endpoint.
"""

from __future__ import annotations

from vsync_s3_client import Vsync
from vsync_s3_client.config_blob import VsyncConfig


def test_handle_repr_redacted():
    v = Vsync._from_vault(
        kv={"SECRET_KEY": "sk_live_redactme"},
        generation=42,
        env="prod",
    )
    r = repr(v)
    assert "sk_live_redactme" not in r
    assert "SECRET_KEY" not in r
    assert "<vsync:redacted" in r
    assert "gen=42" in r
    assert "env=prod" in r


def test_handle_str_redacted():
    v = Vsync._from_vault(
        kv={"SECRET_KEY": "sk_live_redactme"}, generation=3, env="dev"
    )
    s = str(v)
    assert "sk_live_redactme" not in s
    assert "SECRET_KEY" not in s


def test_config_repr_redacted():
    cfg = VsyncConfig(
        v=1,
        endpoint="https://s3.example.com",
        region="us-east-1",
        bucket="b",
        access_key_id="AKIASECRET",
        secret_access_key="VERY-SECRET",
        prefix="p/",
        env="prod",
        salt="REDACT-SALT",
        iterations=600000,
    )
    r = repr(cfg)
    assert "AKIASECRET" not in r
    assert "VERY-SECRET" not in r
    assert "REDACT-SALT" not in r
    assert "redacted" in r


def test_format_string_does_not_leak():
    v = Vsync._from_vault(kv={"X": "leak-this-please"}, generation=1, env="dev")
    rendered = f"the handle is {v}"
    assert "leak-this-please" not in rendered


def test_format_dict_does_not_leak():
    v = Vsync._from_vault(kv={"X": "leak-this-please"}, generation=1, env="dev")
    rendered = "{!r}".format(v)
    assert "leak-this-please" not in rendered
