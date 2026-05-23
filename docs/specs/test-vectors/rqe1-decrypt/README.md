# `rqe1-decrypt`

Positive RQE1 decryption: given a passphrase and an RQE1 envelope, the lib must derive the key, authenticate, and return the exact plaintext bytes.

See [`../../v0.11-conformance-test-vectors.md`](../../v0.11-conformance-test-vectors.md) §4 for the category table.

## Schema

- `inputs.passphrase` — string passphrase fed to PBKDF2-SHA256 inside the envelope
- `expected.plaintext_hex` — lowercase, unspaced, even-length hex of decrypted bytes
- `expected.plaintext_utf8` — optional; present only when plaintext is valid UTF-8
- `expected.error` — always `null` in this category

`.bin` is **required** — it carries the RQE1 envelope the lib decrypts.
