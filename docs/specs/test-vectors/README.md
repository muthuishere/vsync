# Test vectors

Cross-language conformance fixtures. Three runtime libraries — Python, TypeScript, Go — plus the Bun CLI must each produce and accept the **same bytes** on the wire. These vectors are the normative byte-level fixtures that pin that guarantee: if all four impls pass the corpus, an RQE1 blob encrypted by one decrypts cleanly in the other three.

Full format is specified in [`../v0.11-conformance-test-vectors.md`](../v0.11-conformance-test-vectors.md). This README is orientation only; the spec is the source of truth.

## Layout

One subdirectory per category. Vectors are not nested deeper than one level under `test-vectors/`.

- [`rqe1-decrypt/`](./rqe1-decrypt/) — positive RQE1 decryption
- [`rqe1-decrypt-error/`](./rqe1-decrypt-error/) — negative RQE1 (wrong passphrase, corrupt magic, truncated ciphertext, bad GCM tag)
- [`rqem0001-manifest/`](./rqem0001-manifest/) — manifest pointer-seal (positive + negative)
- [`config-blob/`](./config-blob/) — `VSYNC_CONFIG` decode (magic + base64url + gzip → JSON)
- [`fallback-chain/`](./fallback-chain/) — in-memory vault + simulated env; assert `get()` / `source()` / `has()`
- [`asset-path/`](./asset-path/) — `assetPath()` materialization (file exists, `0600`, content matches, cleanup)
- [`error-taxonomy/`](./error-taxonomy/) — class identity across libs (same blob raises the same class everywhere)

## File-pair convention

Each vector is a `.bin` + `.json` pair sharing a basename inside its category directory. The `.bin` holds raw bytes (no base64, no hex); the `.json` holds inputs + expected outputs. Some categories may omit `.bin` when the vector is purely API-driven (notably `fallback-chain` and parts of `error-taxonomy`) — see v0.11 §2 for the rules.

## Generation

The vectors here are **placeholders**. They demonstrate the file-pair shape and the JSON schema; they carry no real cryptographic content.

- The canonical generator will eventually be the Bun CLI subcommand `vsync test-vectors generate` (future surface, mentioned in v0.10 / v0.11 §6 — not yet implemented).
- Until that ships, real vectors are produced by hand-running known inputs through the CLI and committing the resulting `.bin` alongside a hand-written `.json`.
- Every real vector's JSON carries `generated_by: "vsync@<commit-sha>"` so a wrong vector can be traced to the commit that minted it. Placeholders use `generated_by: "placeholder@manual"`.

Loaders must skip any vector whose JSON contains `"placeholder": true`. This flag is present on every file in this initial scaffold and must be removed (or set to `false`) when a real vector replaces the placeholder.

## How libs consume them

Each lib ships a thin loader that walks `docs/specs/test-vectors/<category>/*.json`, pairs the sibling `.bin` if present, and dispatches to a category-specific assertion (positive: decode-and-compare; negative: assert-class). The harness is per-lib (pytest, `bun test`, `go test`); the corpus is shared. CI fails if **any** vector fails, and each lib covers **100% of categories**. See v0.11 §7 for the full protocol.
