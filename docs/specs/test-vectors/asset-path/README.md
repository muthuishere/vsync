# `asset-path`

`assetPath()` materialization: given a vault containing binary asset bytes for `key`, the lib must write them to a tmp file at mode `0600`, ensure the content round-trips, and clean up on `close()`.

See [`../../v0.11-conformance-test-vectors.md`](../../v0.11-conformance-test-vectors.md) §4.

## Schema

- `inputs.key` — vault key to materialize
- `inputs.vault` — object: vault contents (the value at `key` is the asset)
- `expected.bytes_hex` — hex of the bytes written to the materialized file
- `expected.mode_octal` — always `"0600"`
- `expected.error` — `null` for normal cases

`.bin` is **required** — it carries the raw asset bytes the lib materializes (or the corresponding hex appears in `expected.bytes_hex`).
