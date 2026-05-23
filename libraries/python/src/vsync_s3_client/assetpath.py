"""Lazy materialization of vault assets to a per-handle tempdir.

Some SDKs only accept a filesystem path (GOOGLE_APPLICATION_CREDENTIALS,
OpenSSL cert paths, …). For those, the handle exposes `asset_path()`
which writes the asset's bytes to a 0600 file inside a 0700 per-handle
tempdir and returns the path. `asset_bytes()` should be the default in
new code — it never touches the filesystem.

Honest limits: SIGKILL does not run `close()`. A file may leak until
next reboot (tmpfs) or until a sweep. v0.12 §6 documents this.
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
import tempfile
from typing import Dict, Optional


def _preferred_tmpdir_base() -> Optional[str]:
    """On Linux, /dev/shm (tmpfs) avoids touching the disk platter."""
    if sys.platform.startswith("linux") and os.path.isdir("/dev/shm"):
        return "/dev/shm"
    return None


class AssetMaterializer:
    """Owns a per-handle tempdir; writes assets on first access, cleans up
    on close. Reused across `asset_path()` calls within one Vsync handle.
    """

    def __init__(self) -> None:
        self._tempdir: Optional[str] = None
        self._cache: Dict[str, str] = {}
        self._closed = False

    @property
    def tempdir(self) -> str:
        """Return the materialization dir, creating it lazily."""
        if self._tempdir is None:
            self._tempdir = tempfile.mkdtemp(
                prefix=f"vsync-{os.getpid()}-",
                dir=_preferred_tmpdir_base(),
            )
            os.chmod(self._tempdir, 0o700)
        return self._tempdir

    def materialize(self, name: str, payload: bytes) -> str:
        """Write `payload` under a sanitised `name` and return its path.

        Repeat calls with the same `name` return the cached path without
        re-writing. The on-disk file is mode 0600.
        """
        if self._closed:
            raise ValueError("AssetMaterializer: already closed")
        if name in self._cache:
            return self._cache[name]
        # Defang the asset name: take the basename only so a malicious
        # `../../etc/passwd` can't escape the tempdir. v0.12 doesn't make
        # a security claim against caller-controlled names — vault contents
        # are operator-trusted — but containment is the polite default.
        safe = os.path.basename(name) or "_asset"
        path = os.path.join(self.tempdir, safe)
        # O_CREAT|O_WRONLY|O_TRUNC with explicit 0600. umask of the process
        # is irrelevant because we pass the mode to open(2) directly.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, payload)
        finally:
            os.close(fd)
        # Re-chmod in case the platform's open(2) didn't honor mode bits
        # exactly (some setups apply the umask to the mode argument).
        os.chmod(path, 0o600)
        self._cache[name] = path
        return path

    def close(self) -> None:
        """Best-effort cleanup. Idempotent. Failures are swallowed — the
        process is exiting and the OS will reclaim tmpfs on reboot.
        """
        if self._closed:
            return
        self._closed = True
        if self._tempdir is not None and os.path.isdir(self._tempdir):
            shutil.rmtree(self._tempdir, ignore_errors=True)
        self._tempdir = None
        self._cache.clear()


__all__ = ["AssetMaterializer"]
