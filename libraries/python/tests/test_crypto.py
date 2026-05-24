"""RQE1 envelope decrypt — Python mirror of src/crypto.ts.

Envelope layout (v0.2 §3 / §8.2):
    bytes 0..3   "RQE1"
    bytes 4..15  12-byte IV
    bytes 16..N  ciphertext + 16-byte AES-GCM auth tag
KDF: PBKDF2-SHA256, 600_000 iterations, key length 32 bytes.
"""

import pytest

from vsync_s3_client.crypto import decrypt_rqe1, encrypt_rqe1_for_test
from vsync_s3_client.exceptions import (
    BundleCorruptError,
    UnsupportedSpecVersionError,
    WrongPassphraseError,
)


PASS = "correct horse battery staple"
SALT = "test-salt"


def test_round_trip_hello_world():
    blob = encrypt_rqe1_for_test(b"hello world", PASS, SALT)
    assert decrypt_rqe1(blob, PASS, SALT) == b"hello world"


def test_round_trip_empty_plaintext():
    blob = encrypt_rqe1_for_test(b"", PASS, SALT)
    assert decrypt_rqe1(blob, PASS, SALT) == b""


def test_round_trip_binary_plaintext():
    pt = bytes(range(256))
    blob = encrypt_rqe1_for_test(pt, PASS, SALT)
    assert decrypt_rqe1(blob, PASS, SALT) == pt


def test_wrong_passphrase_raises_wrong_passphrase_error():
    blob = encrypt_rqe1_for_test(b"hello", PASS, SALT)
    with pytest.raises(WrongPassphraseError):
        decrypt_rqe1(blob, "the-wrong-passphrase", SALT)


def test_wrong_salt_raises_wrong_passphrase_error():
    # Different salt with same passphrase derives a different key → GCM tag
    # rejects the ciphertext. Surfaced as WrongPassphraseError (the user-
    # actionable rename — they're holding a passphrase that doesn't unwrap).
    blob = encrypt_rqe1_for_test(b"hello", PASS, SALT)
    with pytest.raises(WrongPassphraseError):
        decrypt_rqe1(blob, PASS, "different-salt")


def test_corrupt_magic_byte_zero_raises_bundle_corrupt():
    blob = bytearray(encrypt_rqe1_for_test(b"hi", PASS, SALT))
    blob[0] = ord("X")  # R → X
    with pytest.raises(BundleCorruptError):
        decrypt_rqe1(bytes(blob), PASS, SALT)


def test_corrupt_magic_byte_one_raises_bundle_corrupt():
    blob = bytearray(encrypt_rqe1_for_test(b"hi", PASS, SALT))
    blob[1] = ord("X")  # Q → X
    with pytest.raises(BundleCorruptError):
        decrypt_rqe1(bytes(blob), PASS, SALT)


def test_corrupt_magic_byte_two_raises_bundle_corrupt():
    blob = bytearray(encrypt_rqe1_for_test(b"hi", PASS, SALT))
    blob[2] = ord("X")  # E → X
    with pytest.raises(BundleCorruptError):
        decrypt_rqe1(bytes(blob), PASS, SALT)


def test_version_byte_three_flipped_raises_unsupported_spec_version():
    # First three bytes "RQE" are intact, but the version digit at byte 3 is
    # not "1". This is "I understand the envelope family but not this
    # version" — operator must upgrade the library.
    blob = bytearray(encrypt_rqe1_for_test(b"hi", PASS, SALT))
    blob[3] = ord("2")  # 1 → 2
    with pytest.raises(UnsupportedSpecVersionError):
        decrypt_rqe1(bytes(blob), PASS, SALT)


def test_obvious_truncation_below_header_raises_bundle_corrupt():
    # An envelope shorter than the header+tag floor (16+16=32 bytes) cannot
    # have ever held a real ciphertext; that's structural corruption, not a
    # tag mismatch — separate failure class on purpose.
    with pytest.raises(BundleCorruptError):
        decrypt_rqe1(b"RQE1\x00\x00", PASS, SALT)


def test_structural_threshold_31_bytes_raises_bundle_corrupt():
    # The conformance corpus's regenerated `truncated-ciphertext` vector
    # is 30 bytes — exercising the structural heuristic explicitly here.
    # Anything < 32 (header 16 + min tag 16) can't be a valid envelope.
    blob = b"RQE1" + b"\x00" * 27  # 31 bytes
    with pytest.raises(BundleCorruptError):
        decrypt_rqe1(blob, PASS, SALT)


def test_truncated_long_envelope_raises_wrong_passphrase():
    # A truncation that still leaves >= tag_len bytes of "ciphertext" is
    # structurally indistinguishable from a tampered-tag envelope at this
    # layer (no plaintext-length field on the wire). Both surface as the
    # tag-rejection class. Honest limit, documented in the spec amendment.
    blob = encrypt_rqe1_for_test(b"longer payload to clearly survive header", PASS, SALT)
    truncated = blob[:-8]
    with pytest.raises(WrongPassphraseError):
        decrypt_rqe1(truncated, PASS, SALT)


def test_bad_gcm_tag_raises_wrong_passphrase():
    # Spec calls this WrongPassphraseError (v0.12 §11). The byte flip at the
    # tail of a valid envelope is indistinguishable from "you brought the
    # wrong key" — same recourse (rotate / re-key), same class.
    blob = bytearray(encrypt_rqe1_for_test(b"hi", PASS, SALT))
    blob[-1] ^= 0xFF
    with pytest.raises(WrongPassphraseError):
        decrypt_rqe1(bytes(blob), PASS, SALT)
