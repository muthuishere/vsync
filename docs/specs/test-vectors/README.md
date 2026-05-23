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

The vectors in this tree are **real** — they round-trip through `src/crypto.ts` and `src/manifest.ts` and carry the byte-level fixtures the language ports validate against. The Bun script `scripts/generate-test-vectors.ts` is the canonical producer.

- Every JSON carries `generated_by: "vsync@<commit-sha>"` so a wrong vector can be traced to the commit that minted it.
- The generator is deterministic — same inputs (script + sha) → same bytes. After a regen, `git diff` on this tree should be empty unless the spec or the generator changed.
- IVs and salts are derived per-vector from `sha256("vsync-vec-v0.12|<category>|<name>|<label>")` so the corpus is byte-stable across machines and language ports.

## How to regenerate

```bash
# Use the current git HEAD sha as the generated_by tag (the default).
bun scripts/generate-test-vectors.ts

# Or pin the sha — useful in CI / when regenerating against a known commit.
VSYNC_VECTOR_SHA=<sha> bun scripts/generate-test-vectors.ts

# Or emit into a throwaway directory for inspection.
bun scripts/generate-test-vectors.ts --out=/tmp/vsync-vectors
```

After a successful run, `git status docs/specs/test-vectors/` should be clean. A non-empty diff means either the spec moved or the generator changed — review the diff before committing.

## How libs consume them

Each lib ships a thin loader that walks `docs/specs/test-vectors/<category>/*.json`, pairs the sibling `.bin` if present, and dispatches to a category-specific assertion (positive: decode-and-compare; negative: assert-class). The harness is per-lib (pytest, `bun test`, `go test`); the corpus is shared. CI fails if **any** vector fails, and each lib covers **100% of categories**. See v0.11 §7 for the full protocol.
