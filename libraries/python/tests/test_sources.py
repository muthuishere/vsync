"""Two-input bootstrap resolution (v0.12 §2 + §13).

Rules:
- `_FILE` wins over the env-direct variant per PostgreSQL/Docker convention.
- Env-direct value is taken verbatim (no trim — a leading space could be
  part of a passphrase). File contents are stripped of trailing whitespace
  / newlines.
- Neither form set → ConfigMissingError.
- File mode 0666 / 0777 → refuse (world-writable is almost always a mistake).
"""

from __future__ import annotations

import os
import stat

import pytest

from vsync_s3_client.exceptions import ConfigMissingError
from vsync_s3_client.sources import resolve_bootstrap_inputs


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    for v in (
        "VSYNC_CONFIG",
        "VSYNC_CONFIG_FILE",
        "VSYNC_PASSPHRASE",
        "VSYNC_PASSPHRASE_FILE",
    ):
        monkeypatch.delenv(v, raising=False)


def test_env_direct(monkeypatch):
    monkeypatch.setenv("VSYNC_CONFIG", "blob-bytes")
    monkeypatch.setenv("VSYNC_PASSPHRASE", "secret")
    cfg, pp = resolve_bootstrap_inputs()
    assert cfg == b"blob-bytes"
    assert pp == "secret"


def test_passphrase_leading_space_preserved(monkeypatch):
    # The env-direct value is taken verbatim — a leading space in a
    # passphrase is part of the passphrase, not a typo.
    monkeypatch.setenv("VSYNC_CONFIG", "blob")
    monkeypatch.setenv("VSYNC_PASSPHRASE", "  has-leading-space")
    _, pp = resolve_bootstrap_inputs()
    assert pp == "  has-leading-space"


def test_file_form_strips_trailing_newline(monkeypatch, tmp_path):
    cfg_file = tmp_path / "cfg"
    pp_file = tmp_path / "pp"
    cfg_file.write_text("blob-from-file\n")
    pp_file.write_text("file-passphrase\n")
    os.chmod(cfg_file, 0o600)
    os.chmod(pp_file, 0o600)
    monkeypatch.setenv("VSYNC_CONFIG_FILE", str(cfg_file))
    monkeypatch.setenv("VSYNC_PASSPHRASE_FILE", str(pp_file))
    cfg, pp = resolve_bootstrap_inputs()
    assert cfg == b"blob-from-file"
    assert pp == "file-passphrase"


def test_file_form_wins_over_env_form(monkeypatch, tmp_path):
    cfg_file = tmp_path / "cfg"
    cfg_file.write_text("from-file")
    os.chmod(cfg_file, 0o600)
    monkeypatch.setenv("VSYNC_CONFIG", "from-env")
    monkeypatch.setenv("VSYNC_CONFIG_FILE", str(cfg_file))
    monkeypatch.setenv("VSYNC_PASSPHRASE", "pp")
    cfg, _ = resolve_bootstrap_inputs()
    assert cfg == b"from-file"


def test_missing_both_forms_raises_config_missing():
    with pytest.raises(ConfigMissingError) as exc:
        resolve_bootstrap_inputs()
    assert "VSYNC_CONFIG" in str(exc.value)


def test_missing_passphrase_raises_config_missing(monkeypatch):
    monkeypatch.setenv("VSYNC_CONFIG", "blob")
    with pytest.raises(ConfigMissingError) as exc:
        resolve_bootstrap_inputs()
    assert "VSYNC_PASSPHRASE" in str(exc.value)


def test_file_missing_path_raises_config_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("VSYNC_CONFIG_FILE", str(tmp_path / "nope"))
    monkeypatch.setenv("VSYNC_PASSPHRASE", "pp")
    with pytest.raises(ConfigMissingError) as exc:
        resolve_bootstrap_inputs()
    assert "nope" in str(exc.value) or "not exist" in str(exc.value).lower()


def test_file_world_writable_refused(monkeypatch, tmp_path):
    cfg_file = tmp_path / "cfg"
    cfg_file.write_text("data")
    os.chmod(cfg_file, 0o666)
    monkeypatch.setenv("VSYNC_CONFIG_FILE", str(cfg_file))
    monkeypatch.setenv("VSYNC_PASSPHRASE", "pp")
    with pytest.raises(ConfigMissingError) as exc:
        resolve_bootstrap_inputs()
    msg = str(exc.value)
    assert "world-writable" in msg or "0666" in msg or "writable" in msg


def test_file_group_readable_warns_but_reads(monkeypatch, tmp_path, capsys):
    cfg_file = tmp_path / "cfg"
    cfg_file.write_text("data")
    os.chmod(cfg_file, 0o644)
    monkeypatch.setenv("VSYNC_CONFIG_FILE", str(cfg_file))
    monkeypatch.setenv("VSYNC_PASSPHRASE", "pp")
    cfg, _ = resolve_bootstrap_inputs()
    assert cfg == b"data"
    captured = capsys.readouterr()
    assert "0644" in captured.err or "readable" in captured.err
