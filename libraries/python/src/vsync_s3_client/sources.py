"""Two-input bootstrap resolution for `VSYNC_CONFIG` + `VSYNC_PASSPHRASE`.

Per v0.12 §2:
  - `_FILE` variant wins if both forms set.
  - Env-direct value is verbatim; file value has trailing whitespace stripped.
  - Neither form set → ConfigMissingError.

Per v0.12 §13 (file-permissions policy):
  - 0600 / 0400 → silent read.
  - 0644 / 0640 (group/world readable) → read + warn on stderr.
  - 0666 / 0777 (world-writable) → refuse → ConfigMissingError.
  - ENOENT / EACCES → ConfigMissingError with hint.

On Windows, the permission check is skipped (POSIX mode bits are meaningless).
"""

from __future__ import annotations

import os
import stat
import sys
from typing import Optional, Tuple

from .exceptions import ConfigMissingError

CONFIG_ENV = "VSYNC_CONFIG"
CONFIG_ENV_FILE = "VSYNC_CONFIG_FILE"
PASSPHRASE_ENV = "VSYNC_PASSPHRASE"
PASSPHRASE_ENV_FILE = "VSYNC_PASSPHRASE_FILE"


def _check_file_mode(path: str) -> None:
    """Apply the v0.12 §13 file-permissions policy.

    Raises ConfigMissingError for world-writable files. Logs to stderr for
    group/world-readable files. Skips on Windows.
    """
    if sys.platform == "win32":
        print(
            "vsync: file-permission check skipped (Windows)",
            file=sys.stderr,
        )
        return
    try:
        st = os.stat(path)
    except FileNotFoundError as e:
        raise ConfigMissingError(
            f"vsync: {path} does not exist — fix the deploy config"
        ) from e
    except PermissionError as e:
        raise ConfigMissingError(
            f"vsync: cannot access {path}: permission denied — "
            "check ownership / mode bits"
        ) from e
    mode = stat.S_IMODE(st.st_mode)
    if mode & 0o002:  # world-writable
        raise ConfigMissingError(
            f"vsync: refusing to read world-writable file {path} "
            f"(mode {mode:#o}) — narrow to 0600"
        )
    if mode & 0o044:  # group- or world-readable
        print(
            f"vsync: {path} is world/group-readable (mode {mode:#o}); "
            "narrow to 0600",
            file=sys.stderr,
        )


def _read_file_stripped(path: str) -> bytes:
    _check_file_mode(path)
    try:
        with open(path, "rb") as f:
            data = f.read()
    except FileNotFoundError as e:
        raise ConfigMissingError(
            f"vsync: {path} does not exist — fix the deploy config"
        ) from e
    except PermissionError as e:
        raise ConfigMissingError(
            f"vsync: cannot read {path}: permission denied"
        ) from e
    return data.rstrip(b"\r\n\t ")


def _resolve(name_env: str, name_file: str, env: dict[str, str]) -> Optional[bytes]:
    """`_FILE` wins. Return bytes or None if neither form is set."""
    file_path = env.get(name_file)
    if file_path:
        return _read_file_stripped(file_path)
    raw = env.get(name_env)
    if raw is not None:
        return raw.encode("utf-8")
    return None


def resolve_bootstrap_inputs(
    env: Optional[dict[str, str]] = None,
) -> Tuple[bytes, str]:
    """Resolve (VSYNC_CONFIG bytes, VSYNC_PASSPHRASE str).

    Reads from `os.environ` by default; pass `env={...}` to supply a
    test fixture (kept dict-typed to mirror how callers think about envs).
    """
    env = dict(os.environ) if env is None else env
    config = _resolve(CONFIG_ENV, CONFIG_ENV_FILE, env)
    if config is None:
        raise ConfigMissingError(
            f"vsync: neither {CONFIG_ENV} nor {CONFIG_ENV_FILE} is set — "
            "fix the deploy config (v0.12 §2)"
        )
    passphrase = _resolve(PASSPHRASE_ENV, PASSPHRASE_ENV_FILE, env)
    if passphrase is None:
        raise ConfigMissingError(
            f"vsync: neither {PASSPHRASE_ENV} nor {PASSPHRASE_ENV_FILE} is set "
            "— fix the deploy config (v0.12 §2)"
        )
    # The passphrase is text, but the file reader is bytes-typed for symmetry.
    # Decoding errors here are operator-config errors → ConfigMissing.
    try:
        return config, passphrase.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ConfigMissingError(
            f"vsync: {PASSPHRASE_ENV_FILE} contents are not UTF-8 text — "
            "passphrases must be UTF-8"
        ) from e


__all__ = ["resolve_bootstrap_inputs"]
