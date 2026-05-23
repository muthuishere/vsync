"""Conformance corpus walker for Python's vsync-s3-client.

Per `docs/specs/v0.11-conformance-test-vectors.md` §7. The loader walks
`docs/specs/test-vectors/<category>/*.json`, pairs the sibling `.bin`
(when present), and dispatches to a category-specific assertion. The
corpus and the harness are intentionally separate — the corpus is the
shared contract, the harness is per-lib (pytest here).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, List, Optional


# Resolve the corpus path relative to this file. Tests can override via
# the VSYNC_TEST_VECTORS_DIR env var (useful when running against a
# regenerated corpus in /tmp during development).
def vectors_root() -> Path:
    override = os.environ.get("VSYNC_TEST_VECTORS_DIR")
    if override:
        return Path(override).resolve()
    # libraries/python/tests/conformance/loader.py → repo root is 4 up.
    return (Path(__file__).resolve().parents[4] / "docs" / "specs" / "test-vectors")


CATEGORIES: List[str] = [
    "rqe1-decrypt",
    "rqe1-decrypt-error",
    "rqem0001-manifest",
    "config-blob",
    "fallback-chain",
    "asset-path",
    "error-taxonomy",
]


@dataclass
class Vector:
    """One conformance fixture: metadata JSON + (optional) sibling bytes."""

    category: str
    name: str          # basename without extension
    json_path: Path
    bin_path: Optional[Path]
    meta: dict

    @property
    def bin_bytes(self) -> Optional[bytes]:
        if self.bin_path and self.bin_path.exists():
            return self.bin_path.read_bytes()
        return None

    @property
    def description(self) -> str:
        return str(self.meta.get("description", "(no description)"))

    @property
    def generated_by(self) -> str:
        return str(self.meta.get("generated_by", "?"))

    @property
    def expected_error(self) -> Optional[str]:
        return self.meta.get("expected", {}).get("error")

    def __repr__(self) -> str:
        return f"<Vector {self.category}/{self.name}>"


def iter_category(category: str) -> Iterator[Vector]:
    """Walk one category. Skips README.md and any non-.json files."""
    root = vectors_root() / category
    if not root.is_dir():
        return
    for json_path in sorted(root.glob("*.json")):
        with open(json_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        bin_path = json_path.with_suffix(".bin")
        if not bin_path.exists():
            bin_path = None
        yield Vector(
            category=category,
            name=json_path.stem,
            json_path=json_path,
            bin_path=bin_path,
            meta=meta,
        )


def iter_all() -> Iterator[Vector]:
    for cat in CATEGORIES:
        yield from iter_category(cat)


__all__ = ["Vector", "CATEGORIES", "iter_category", "iter_all", "vectors_root"]
