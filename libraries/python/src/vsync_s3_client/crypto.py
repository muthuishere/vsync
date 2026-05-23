"""RQE1 envelope — decrypt path only.

The CLI (`@muthuishere/vsync`) is the canonical writer; this library is
the reader. `encrypt_rqe1_for_test` exists only so the unit suite has a
round-trip fixture independent of the test-vector corpus — production
callers must never reuse it (it picks a random IV but is named for tests
to discourage drift into runtime paths).

Layout (mirrors `src/crypto.ts`):
    bytes 0..3    magic "RQE1"
    bytes 4..15   12-byte IV
    bytes 16..N   ciphertext || 16-byte AES-GCM auth tag

KDF: PBKDF2-HMAC-SHA256, 600_000 iterations → 32-byte AES-256 key.
"""

from __future__ import annotations

import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from .exceptions import (
    BundleCorruptError,
    UnsupportedSpecVersionError,
    WrongPassphraseError,
)

MAGIC_PREFIX = b"RQE"
MAGIC_VERSION = b"1"
MAGIC = MAGIC_PREFIX + MAGIC_VERSION  # b"RQE1"
IV_LEN = 12
HEADER_LEN = len(MAGIC) + IV_LEN  # 16
PBKDF2_ITERATIONS = 600_000
KEY_LEN = 32
# AES-GCM tag is 16 bytes; min ciphertext block carries at least the tag.
MIN_CT_LEN = 16


def _derive_key(passphrase: str, salt: str, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LEN,
        salt=salt.encode("utf-8"),
        iterations=iterations,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def decrypt_rqe1(
    blob: bytes,
    passphrase: str,
    salt: str,
    iterations: int = PBKDF2_ITERATIONS,
) -> bytes:
    """Decrypt an RQE1 envelope. Maps crypto failures to the v0.12 taxonomy:

    - too-short / corrupt magic prefix / truncated body → BundleCorruptError
    - magic prefix "RQE" but version byte != "1"       → UnsupportedSpecVersionError
    - GCM tag rejects (wrong passphrase or tampering)   → WrongPassphraseError
    """
    if not isinstance(blob, (bytes, bytearray, memoryview)):
        raise BundleCorruptError(
            f"RQE1 envelope: expected bytes-like, got {type(blob).__name__}"
        )
    blob = bytes(blob)
    if len(blob) < HEADER_LEN + MIN_CT_LEN:
        raise BundleCorruptError(
            f"RQE1 envelope too short: {len(blob)} bytes "
            f"(need at least {HEADER_LEN + MIN_CT_LEN})"
        )

    # Three magic-prefix bytes "RQE" frame the envelope family. The fourth
    # byte names the version inside that family. Distinguishing the two is
    # the whole point of the v0.12 error taxonomy split (BundleCorruptError
    # vs UnsupportedSpecVersionError).
    if blob[:3] != MAGIC_PREFIX:
        raise BundleCorruptError(
            "RQE1 envelope: magic prefix is not 'RQE' — not a vsync envelope"
        )
    if blob[3:4] != MAGIC_VERSION:
        raise UnsupportedSpecVersionError(
            f"RQE envelope advertises version {blob[3:4]!r}; this library "
            f"understands version b'1' only — upgrade vsync-s3-client"
        )

    iv = blob[len(MAGIC):HEADER_LEN]
    ciphertext = blob[HEADER_LEN:]
    key = _derive_key(passphrase, salt, iterations)
    try:
        return AESGCM(key).decrypt(iv, ciphertext, associated_data=None)
    except InvalidTag as e:
        raise WrongPassphraseError(
            "RQE1 envelope: AES-GCM tag rejected — the passphrase is wrong "
            "or the ciphertext has been tampered with"
        ) from e


def encrypt_rqe1_for_test(
    plaintext: bytes,
    passphrase: str,
    salt: str,
    iterations: int = PBKDF2_ITERATIONS,
) -> bytes:
    """Round-trip helper for the unit suite — DO NOT call from production code.

    Production encryption belongs to the CLI (decision B in the design huddle;
    `src/crypto.ts::encrypt` is the canonical writer). This helper exists so
    `test_crypto.py` can verify decrypt against bytes it minted itself,
    independent of `docs/specs/test-vectors/`.
    """
    iv = os.urandom(IV_LEN)
    key = _derive_key(passphrase, salt, iterations)
    ct = AESGCM(key).encrypt(iv, plaintext, associated_data=None)
    return MAGIC + iv + ct


__all__ = ["decrypt_rqe1", "encrypt_rqe1_for_test"]
