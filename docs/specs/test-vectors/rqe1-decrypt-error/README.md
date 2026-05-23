# `rqe1-decrypt-error`

Negative RQE1 cases — wrong passphrase, corrupt magic bytes, truncated ciphertext, bad GCM authentication tag. Each must raise the canonical error class for that failure mode, not a generic exception.

See [`../../v0.11-conformance-test-vectors.md`](../../v0.11-conformance-test-vectors.md) §4 and §5 for class-identity discipline.

## Schema

- `inputs.passphrase` — string passphrase fed to the decrypt attempt
- `expected.error` — canonical class name from v0.12's error taxonomy (e.g. `WrongPassphraseError`, `CorruptEnvelopeError`, `TruncatedEnvelopeError`)
- `expected.plaintext_hex` — `null`

`.bin` is **required** — it carries the (possibly mutated) RQE1 envelope being rejected.
