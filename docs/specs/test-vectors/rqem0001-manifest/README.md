# `rqem0001-manifest`

Manifest pointer-seal — `RQEM0001`. Positive cases verify the embedded timestamp matches the remote timestamp and the inner payload decrypts; negative cases cover embedded-vs-remote `ts` mismatch and wrong magic.

See [`../../v0.11-conformance-test-vectors.md`](../../v0.11-conformance-test-vectors.md) §4. Wire details are in [`../../v0.2-secret-lib.md`](../../v0.2-secret-lib.md).

## Schema

- `inputs.passphrase` — string passphrase
- `inputs.remote_ts` — the timestamp the bucket reports (compared against the embedded `ts` inside the sealed manifest)
- `expected.embedded_ts` — the timestamp recovered from inside the envelope (positive case)
- `expected.payload_hex` — hex of the inner manifest payload (positive case)
- `expected.error` — canonical class name on negative cases (e.g. `ManifestTimestampMismatchError`), else `null`

`.bin` is **required** — it carries the RQEM0001 envelope.
