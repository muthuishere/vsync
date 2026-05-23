# `config-blob`

`VSYNC_CONFIG` envelope decode — magic prefix, then base64url-no-pad, then gzip, then JSON. Positive cases yield a parsed config object; negative cases cover wrong magic, malformed gzip, and unknown `v:` version tags.

See [`../../v0.11-conformance-test-vectors.md`](../../v0.11-conformance-test-vectors.md) §4.

## Schema

- `inputs` — empty; the bytes carry everything the decoder needs
- `expected.config_json` — the decoded config object (positive case)
- `expected.error` — canonical class name on negative cases (e.g. `CorruptEnvelopeError`, `UnknownConfigVersionError`), else `null`

`.bin` is **required** — it carries the full `VSYNC_CONFIG` blob.
