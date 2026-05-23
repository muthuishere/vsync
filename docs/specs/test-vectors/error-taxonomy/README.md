# `error-taxonomy`

Class-identity vectors: a given failure (e.g. wrong-passphrase RQE1 blob) must surface the **same canonical class name** in every lib, regardless of idiomatic differences (Python `WrongPassphraseError` vs Go `ErrWrongPassphrase` vs TS `WrongPassphraseError`). The lib's loader maps canonical names to local sentinels.

See [`../../v0.11-conformance-test-vectors.md`](../../v0.11-conformance-test-vectors.md) §4 and §5.

## Schema

- `inputs` — varies by case (often a passphrase plus whatever the negative case needs)
- `expected.error` — canonical class name from v0.12's error taxonomy (never `null` in this category)

`.bin` is **optional** — required for byte-driven cases (e.g. blob → `WrongPassphraseError`); absent for purely-API negative cases. When absent, `inputs.bin` is `null` and loaders skip the bin-pair check.
