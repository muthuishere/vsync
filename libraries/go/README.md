# vsync-s3-client-go

Read-side runtime library for the [vsync](https://github.com/muthuishere/secret-lib) ecosystem. **The CLI writes; this library reads.** One process input pair (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`), one S3 round trip at `Open`, an in-memory accessor with a deterministic fallback chain. No daemon, no refresh, no filesystem cache.

This is the **Go port** of the cross-language client family — Python (reference impl) and TypeScript siblings ship in parallel, and all three pass the same conformance corpus.

- **Spec:** [`docs/specs/v0.12-vsync-s3-client.md`](../../docs/specs/v0.12-vsync-s3-client.md)
- **Conformance corpus:** [`docs/specs/test-vectors/`](../../docs/specs/test-vectors/)
- **Wire envelope:** RQE1 ([v0.2 §3](../../docs/specs/v0.2-secret-lib.md)) + RQEM0001 ([v0.4](../../docs/specs/v0.4-audit-log.md))
- **Module version:** `0.11.0` (unified across the vsync CLI + all three language libs; pre-1.0; latest wire format only; no compatibility shims)

## Install

```bash
go get github.com/muthuishere/vsync/libraries/go@latest
```

Targets Go ≥ 1.22. Runtime deps: `github.com/aws/aws-sdk-go-v2/service/s3` (and its required sub-modules), `golang.org/x/crypto/pbkdf2`. The crypto primitives (`crypto/aes`, `crypto/cipher`, `encoding/base64`, `compress/gzip`, `encoding/json`) are stdlib.

### Release tagging

Per decision H (subpath modules), tags use the directory prefix:

```bash
git tag libraries/go/v0.11.0
git push origin libraries/go/v0.11.0
```

`go get github.com/muthuishere/vsync/libraries/go@v0.11.0` then resolves cleanly.

## Quick start

```go
package main

import (
    "context"
    "log"

    vsync "github.com/muthuishere/vsync/libraries/go"
)

func main() {
    ctx := context.Background()
    v, err := vsync.Open(ctx)
    if err != nil { log.Fatal(err) }
    defer v.Close()

    dbURL, ok := v.Get("DATABASE_URL")     // (string, bool)
    has := v.Has("STRIPE_KEY")             // bool
    src := v.Source("DATABASE_URL")        // vsync.SourceVault | …Env | …Default | …Missing
    bytes, err := v.AssetBytes("svc.json") // []byte, no filesystem
    path, err := v.AssetPath("svc.json")   // string — lazy 0600 tempfile
    gen := v.Generation()                  // int — monotonic counter, safe to log
    _ = dbURL; _ = has; _ = src; _ = bytes; _ = path; _ = gen
}
```

Defaults are functional options on `Open`:

```go
v, err := vsync.Open(ctx, vsync.WithDefaults(map[string]string{"PORT": "8080"}))
```

For tests or custom backends, swap the S3 fetcher:

```go
v, err := vsync.Open(ctx, vsync.WithFetcher(myFakeFetcher))
```

## Two-input bootstrap

`Open` reads exactly two process inputs. Nothing else. No discovery, no `.vsyncrc`, no DNS.

| Input | Purpose | `_FILE` variant |
|---|---|---|
| `VSYNC_CONFIG` | gzip+base64url JSON blob (S3 endpoint, bucket, IAM key, salt, env) | `VSYNC_CONFIG_FILE` |
| `VSYNC_PASSPHRASE` | passphrase that unwraps the RQE1-encrypted bundle | `VSYNC_PASSPHRASE_FILE` |

`_FILE` wins if both forms are set (matches PostgreSQL / Docker secrets). Trailing whitespace on file values is stripped; env values are verbatim (a leading space could be part of a passphrase).

**VPS / Docker (file-backed):**

```bash
VSYNC_CONFIG_FILE=/run/secrets/vsync-config
VSYNC_PASSPHRASE_FILE=/run/secrets/vsync-passphrase
```

**Cloud (env-direct from a platform secret store):**

```text
Fly.io:        fly secrets set VSYNC_CONFIG=... VSYNC_PASSPHRASE=...
AWS ECS:       task definition secrets: [{ valueFrom: arn:aws:secretsmanager:... }]
GCP Cloud Run: --set-secrets=VSYNC_CONFIG=projects/.../secrets/cfg:latest
Azure:         Key Vault reference → @Microsoft.KeyVault(SecretUri=...)
```

The library treats both shapes identically — pick one pattern per environment.

## Fallback chain

`v.Get(key)` resolves in exactly this order. No reordering, no per-key overrides:

1. `vault[key]` — the decrypted bundle. `Source` = `SourceVault`.
2. `os.Getenv(key)` — at lookup time, not at `Open` time. `Source` = `SourceEnv`.
3. `defaults[key]` — the map passed via `WithDefaults`. `Source` = `SourceDefault`.
4. missing — `Get` returns `("", false)`. `Source` = `SourceMissing`.

`Has(key)` is true iff steps 1–3 resolve. `Source(key)` returns the label of the winning step **without** returning the value — safe to log.

## Errors

Errors are seven canonical sentinels. Match them with `errors.Is`:

```go
v, err := vsync.Open(ctx)
if errors.Is(err, vsync.ErrWrongPassphrase) {
    // rotate the passphrase
}
```

| Sentinel | When |
|---|---|
| `ErrConfigMissing` | `VSYNC_CONFIG` / `VSYNC_PASSPHRASE` unset, or magic prefix wrong |
| `ErrConfigUnsupportedVersion` | inner JSON `v:` newer than this library, or salt < 8 bytes |
| `ErrS3Unreachable` | network, DNS, TLS, or HTTP 4xx/5xx on the fetch |
| `ErrManifestNotFound` | bucket reachable, `<prefix>manifest` absent — run `vsync push` first |
| `ErrWrongPassphrase` | AES-GCM tag rejected the passphrase |
| `ErrBundleCorrupt` | magic byte mismatch, truncated read, manifest→bundle dangling |
| `ErrUnsupportedSpecVersion` | unknown `RQE1` / `RQEM0001` envelope version |

`Open` does **not** silently degrade to env-vars-only when S3 is down — it returns `ErrS3Unreachable`. A process that booted with "env vars only because S3 was down" is harder to debug than one that refused to boot.

The conformance corpus pins error class identity across languages — `CanonicalName(err)` maps a Go sentinel to the spec's canonical name (e.g. `"WrongPassphraseError"`).

## Asset materialization

`AssetBytes(name)` is the default — never touches the filesystem. `AssetPath(name)` lazily writes to a per-handle tempdir (mode 0700) and returns a 0600 path, for SDKs that demand a filesystem path (GCP `GOOGLE_APPLICATION_CREDENTIALS`, OpenSSL cert paths, etc.). On Linux, `/dev/shm` (tmpfs) is preferred. `Close` removes the dir. **SIGKILL does not run `Close`** — file may leak until reboot. Documented honestly.

## Redaction

`fmt.Sprint(v)` returns `<vsync:redacted gen=N env=<env>>`. Vault values never leak through `Stringer`. `Source(key)`, `Has(key)`, and `Generation()` are safe to log. `Get(key)` and `AssetBytes(name)` results are **never** safe to log.

The library does not install panic handlers or filter logger output. Application-level observability hygiene is the caller's job.

## Trust boundaries and honest limits

The two-variable split (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`) is a **separation-of-leak-channels** design, not multi-factor authentication. State the boundary plainly so operators don't model the wrong threat.

**Protects against (asymmetric leakage):**

- Bucket misconfiguration. A world-readable bucket leaks the encrypted bundle. Without the passphrase, the bundle is ciphertext.
- Infrastructure-repo leak. A leaked Terraform / Helm chart that contains `VSYNC_CONFIG` leaks the S3 location and IAM key but not the passphrase (kept in the platform secret store).
- Partial log capture. A logger that prints `os.Environ()` minus a denylist may catch one variable; a logger that prints `/etc/myapp/env` may capture the other. Splitting reduces the chance one log dump has both.
- Operator error inside one system. Someone pastes `VSYNC_CONFIG` into a Slack channel; the passphrase lives elsewhere.

**Does NOT protect against (the process is its own attack surface):**

- Full process compromise. Anything that can read `/proc/<pid>/environ` has both halves. Anything that can attach a debugger has the decrypted vault.
- CI log dumps that print all env vars (`env`, `printenv`, `set -x` near a curl). If the runner logs both, both are gone.
- Sentry / Datadog / Honeycomb auto-capturing process env on a crash. Same channel.
- A malicious or compromised dependency inside the application. The library hands plaintext to the caller; the dependency runs in the same process.
- Backups that copy the host filesystem (`/run/secrets/...`) and the platform secret-store dump together. Both halves on one backup tape = no split.

**Explicit anti-claims:**

- This is **not MFA.** A second factor would be something the operator presents at boot (hardware token), not a second env var that lives next to the first.
- This is **not end-to-end encryption from the operator to the application.** The passphrase is in the platform secret store; the platform admin can read it.
- "Defense in depth" describes this accurately. "Zero trust" does not.

The worst failure mode is an operator who believes the wrong story. Read this section before deploying.

## Honest limits

RQE1 truncation detection is **best-effort**:

- A **structurally short** envelope (`< 32 bytes` — less than `magic(4) + IV(12) + GCM-tag(16)`) is detected and surfaces as `ErrBundleCorrupt`.
- A **mid-payload truncation that lands on a tag-length boundary** is indistinguishable from a wrong-passphrase tag failure, and surfaces as `ErrWrongPassphrase`. This is a property of AES-GCM without an explicit plaintext-length field on the wire — not a lib bug.

The conformance corpus's `rqe1-decrypt-error/truncated-ciphertext` vector (30 bytes) exercises the structural path and passes.

## Testing

```bash
cd libraries/go
go test ./...                            # unit + conformance, all green
go test -v -run TestConformance ./...    # cross-language conformance, verbose
go vet ./...                             # clean
```

The conformance suite walks `../../docs/specs/test-vectors/` and runs the corpus's `.bin` fixtures through this library's decode path. Per [v0.11](../../docs/specs/v0.11-conformance-test-vectors.md), error class identity is matched via `errors.Is` against the canonical sentinels — not on a generic `error` catch.

Override the corpus path during development:

```bash
VSYNC_TEST_VECTORS_DIR=/tmp/regenerated-vectors go test -run TestConformance ./...
```

## File layout

```text
libraries/go/
├── go.mod
├── README.md                  (you are here)
├── vsync.go                   public Open + functional options
├── client.go                  Client handle + Get/Has/Source/AssetBytes/AssetPath/Generation/Close
├── crypto.go                  RQE1 decrypt (+ structural floor heuristic)
├── manifest.go                RQEM0001 unwrap + pointer-seal verify
├── config_blob.go             VSYNC_CONFIG decode (magic / base64url / gzip / JSON)
├── sources.go                 two-input bootstrap resolution
├── assetpath.go               lazy 0600 tempfile materialization
├── s3_fetcher.go              default aws-sdk-go-v2 fetcher
├── errors.go                  sentinel errors + CanonicalName
├── *_test.go                  per-file unit suites
└── conformance_test.go        walks docs/specs/test-vectors/ and runs the corpus
```

## License

MIT.
