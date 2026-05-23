# `fallback-chain`

Given an in-memory vault state + a simulated process env, assert each lib's `get()` / `source()` / `has()` returns the expected value and source for each queried key. Pins the precedence rules across all three runtimes.

See [`../../v0.11-conformance-test-vectors.md`](../../v0.11-conformance-test-vectors.md) §4.

## Schema

- `inputs.vault` — object: in-memory vault contents
- `inputs.env` — object: simulated process env
- `inputs.queries` — array of key names to probe
- `expected.results` — array of `{ key, value, source, has }` matching `queries` in order
- `expected.error` — `null` for normal cases

`.bin` is **optional** — this category is purely API-driven. When absent, the JSON's `inputs.bin` is `null` (or omitted) and loaders skip the bin-pair check.
