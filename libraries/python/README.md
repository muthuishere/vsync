# vsync-s3-client

Read-side runtime library for the [vsync](https://github.com/muthuishere/secret-lib) ecosystem. **The CLI writes; this library reads.** One process input pair (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`), one S3 round trip at `open()`, an in-memory accessor with a deterministic fallback chain. No daemon, no refresh, no filesystem cache.

This is the **reference implementation** for the cross-language client family — TypeScript and Go ports follow the same behavioural contract pinned by `docs/specs/test-vectors/`.

- **Spec:** [`docs/specs/v0.12-vsync-s3-client.md`](../../docs/specs/v0.12-vsync-s3-client.md)
- **Conformance corpus:** [`docs/specs/test-vectors/`](../../docs/specs/test-vectors/)
- **Wire envelope:** RQE1 ([v0.2 §3](../../docs/specs/v0.2-secret-lib.md)) + RQEM0001 ([v0.4](../../docs/specs/v0.4-audit-log.md))
- **Package version:** `0.1.0` (pre-1.0; latest wire format only; no compatibility shims)

## Install

```bash
pip install vsync-s3-client
```

Requires Python ≥ 3.10. Dependencies: `boto3` (S3 fetch), `cryptography` (AES-GCM + PBKDF2). Nothing else.

## Quick start

```python
import vsync_s3_client

with vsync_s3_client.open() as v:
    db_url = v.get("DATABASE_URL")           # → str | None
    has_stripe = v.has("STRIPE_KEY")         # → bool
    src = v.source("DATABASE_URL")           # → "vault" | "env" | "default" | "missing"
    sa_path = v.asset_path("svc.json")       # lazy 0600 tempfile
    sa_bytes = v.asset_bytes("svc.json")     # bytes, no filesystem
    gen = v.generation()                     # monotonic counter, safe to log
```

Defaults are passed once at `open()` time:

```python
v = vsync_s3_client.open(defaults={"PORT": "8080"})
```

Scripts that only need one value can lean on the module-level singleton (opens lazily, caches for the process lifetime):

```python
import vsync_s3_client
print(vsync_s3_client.get("DATABASE_URL"))
```

Long-running apps should hold a `Vsync` handle explicitly so they control its lifecycle.

## Two-input bootstrap

`open()` reads exactly two process inputs. Nothing else. No discovery, no `.vsyncrc`, no DNS.

| Input | Purpose | `_FILE` variant |
|---|---|---|
| `VSYNC_CONFIG` | gzip+base64url JSON blob (S3 endpoint, bucket, IAM key, salt, env) | `VSYNC_CONFIG_FILE` |
| `VSYNC_PASSPHRASE` | passphrase that unwraps the RQE1-encrypted bundle | `VSYNC_PASSPHRASE_FILE` |

`_FILE` wins if both forms are set (matches the PostgreSQL / Docker secrets convention). Trailing whitespace on file values is stripped; env values are verbatim (a leading space could be part of a passphrase).

**VPS / Docker (file-backed):**

```bash
# /etc/myapp/env (root-owned, 0600)
VSYNC_CONFIG_FILE=/run/secrets/vsync-config
VSYNC_PASSPHRASE_FILE=/run/secrets/vsync-passphrase
```

**Cloud (env-direct from a platform secret store):**

```text
Vercel:        Environment Variables UI → VSYNC_CONFIG, VSYNC_PASSPHRASE
AWS ECS:       task definition `secrets: [{ valueFrom: arn:aws:secretsmanager:... }]`
GCP Cloud Run: --set-secrets=VSYNC_CONFIG=projects/.../secrets/cfg:latest
Azure:         Key Vault reference → @Microsoft.KeyVault(SecretUri=...)
```

The library treats both shapes identically — pick one pattern per environment.

## Fallback chain

`v.get(key)` resolves in exactly this order. No reordering, no per-key overrides:

1. `vault[env][key]` — the decrypted bundle. `source = "vault"`.
2. `os.environ[key]` — at lookup time, not at open. `source = "env"`.
3. `defaults[key]` — the dict passed at `open(defaults=…)`. `source = "default"`.
4. missing — returns `None`. `source = "missing"`.

`has(key)` is true iff steps 1–3 resolve. `source(key)` returns the label of the winning step **without** returning the value — safe to log.

## Errors

All errors subclass `vsync_s3_client.VSyncError`. The taxonomy is fixed (the canonical names cross language boundaries via the conformance corpus):

| Error | When |
|---|---|
| `ConfigMissingError` | `VSYNC_CONFIG` / `VSYNC_PASSPHRASE` unset, or magic prefix wrong |
| `ConfigUnsupportedVersionError` | inner JSON `v:` newer than this library |
| `S3UnreachableError` | network, DNS, TLS, or HTTP 4xx/5xx on the fetch |
| `ManifestNotFoundError` | bucket reachable, `<prefix>manifest` absent — run `vsync push` first |
| `WrongPassphraseError` | AES-GCM tag rejected the passphrase |
| `BundleCorruptError` | magic byte mismatch, truncated read, manifest→bundle dangling |
| `UnsupportedSpecVersionError` | unknown `RQE1` / `RQEM0001` envelope version |

`open()` does **not** silently degrade to env-vars-only when S3 is down — it raises `S3UnreachableError`. A process that booted with "env vars only because S3 was down" is harder to debug than one that refused to boot.

## Asset materialization

`asset_bytes(name)` is the default — never touches the filesystem. `asset_path(name)` lazily writes to a per-handle tempdir (mode 0700) and returns a 0600 path, for SDKs that demand a filesystem path (GCP `GOOGLE_APPLICATION_CREDENTIALS`, OpenSSL cert paths, etc.). On Linux, /dev/shm (tmpfs) is preferred. `close()` removes the dir. **SIGKILL does not run `close()`** — file may leak until reboot. Documented honestly.

## Redaction

`repr(v)` / `str(v)` returns `<vsync:redacted gen=N env=<env>>`. Vault values never leak through serialization. `source(key)`, `has(key)`, and `generation()` are safe to log. `get(key)` and `asset_bytes(name)` results are **never** safe to log.

The library does not install global panic handlers, monkey-patch `print`, or filter Sentry breadcrumbs. Application-level observability hygiene is the caller's job.

## Trust Boundaries and Honest Limits

The two-variable split (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`) is a **separation-of-leak-channels** design, not multi-factor authentication. State the boundary plainly so operators don't model the wrong threat.

**Protects against (asymmetric leakage):**

- Bucket misconfiguration. A world-readable bucket leaks the encrypted bundle. Without the passphrase, the bundle is ciphertext.
- Infrastructure-repo leak. A leaked Terraform / Helm chart that contains `VSYNC_CONFIG` leaks the S3 location and IAM key but not the passphrase (kept in the platform secret store).
- Partial log capture. A logger that prints `process.env` minus a denylist may catch one variable; a logger that prints `/etc/myapp/env` may capture the other. Splitting reduces the chance one log dump has both.
- Operator error inside one system. Someone pastes `VSYNC_CONFIG` into a Slack channel; the passphrase lives elsewhere.

**Does NOT protect against (the process is its own attack surface):**

- Full process compromise. Anything that can read `/proc/<pid>/environ` has both halves. Anything that can attach `gdb` to the process has the decrypted vault.
- CI log dumps that print all env vars (`env`, `printenv`, `set -x` near a curl). If the runner logs both, both are gone.
- Sentry / Datadog / Honeycomb auto-capturing `process.env` on a crash. Same channel.
- A malicious or compromised dependency inside the application. The library hands plaintext to the caller; the dependency runs in the same process.
- Backups that copy the host filesystem (`/run/secrets/...`) and the platform secret-store dump together. Both halves on one backup tape = no split.

**Explicit anti-claims:**

- This is **not MFA.** A second factor would be something the operator presents at boot (hardware token), not a second env var that lives next to the first.
- This is **not end-to-end encryption from the operator to the application.** The passphrase is in the platform secret store; the platform admin can read it.
- "Defense in depth" describes this accurately. "Zero trust" does not.

The worst failure mode is an operator who believes the wrong story. Read this section before deploying.

## Testing

```bash
cd libraries/python
pip install -e ".[dev]"
pytest                    # unit + conformance
pytest tests/conformance  # cross-language conformance only
```

The conformance suite walks `docs/specs/test-vectors/` and runs the corpus's `.bin` fixtures through this library's decode path. Per [`v0.11`](../../docs/specs/v0.11-conformance-test-vectors.md), error class identity is matched on `__class__.__name__` — not on a generic `Exception` catch.

## Known deviations from the spec

- **`rqe1-decrypt-error/truncated-ciphertext`** expects `BundleCorruptError` but this lib raises `WrongPassphraseError`. The AES-GCM library can't distinguish a clipped tag from a tampered tag without an explicit plaintext-length field on the wire. Test marked as skipped with the reason; see the Wave 5 handoff for the open spec question.

## File layout

```text
libraries/python/
├── pyproject.toml
├── README.md                          (you are here)
├── src/vsync_s3_client/
│   ├── __init__.py                    public API re-exports
│   ├── client.py                      Vsync handle + open() / get()
│   ├── crypto.py                      RQE1 decrypt
│   ├── manifest.py                    RQEM0001 read + pointer-seal verify
│   ├── config_blob.py                 VSYNC_CONFIG decode (magic / base64url / gzip / JSON)
│   ├── sources.py                     two-input bootstrap resolution
│   ├── assetpath.py                   lazy 0600 tempfile materialization
│   └── exceptions.py                  taxonomy
└── tests/
    ├── test_crypto.py
    ├── test_manifest.py
    ├── test_config_blob.py
    ├── test_sources.py
    ├── test_client.py
    ├── test_assetpath.py
    ├── test_redaction.py
    ├── test_exceptions.py
    └── conformance/
        ├── loader.py
        └── test_conformance.py
```

## License

MIT.
