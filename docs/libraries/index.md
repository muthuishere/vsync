# Runtime libraries

The CLI writes the vault. **These libraries read it** — directly from S3, inside your application process, in one round trip.

Four languages ship at the same version (`0.11.0`), behaviorally identical, sharing the same wire format and conformance corpus:

| Language | Package | Install |
|---|---|---|
| **Python** _(reference impl)_ | `vsync-s3-client` on PyPI | `pip install vsync-s3-client` |
| **TypeScript / Node** | `@muthuishere/vsync-s3-client` on npm | `npm install @muthuishere/vsync-s3-client` |
| **Go** | `github.com/muthuishere/vsync/libraries/go` | `go get github.com/muthuishere/vsync/libraries/go@v0.11.0` |
| **Java** | `io.github.muthuishere:vsync-s3-client` on Maven Central | Gradle/Maven coordinate below |

All four pass the same 31-vector cross-language conformance corpus at [`docs/specs/test-vectors/`](https://github.com/muthuishere/vsync/tree/main/docs/specs/test-vectors). If your Python lib decodes a bundle, your TypeScript / Go / Java libs will too — byte-for-byte.

## What they're for

Your application boots. It needs `DATABASE_URL`, `STRIPE_KEY`, the GCP service-account JSON, the TLS cert chain. Today that's split between `process.env`, hand-managed `.env` files, and ad-hoc mounted secret files.

With a runtime lib:

```python
import vsync_s3_client

with vsync_s3_client.open() as v:
    db = v.get("DATABASE_URL")              # → "postgres://..."
    src = v.source("DATABASE_URL")          # → "vault" | "env" | "default" | "missing"
    sa_path = v.asset_path("gcp-sa.json")   # writes to 0600 tempfile, returns path
```

One process-input pair (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`), one S3 round trip at `open()`, then everything's in memory with a deterministic fallback chain. No daemon, no refresh, no filesystem cache.

## Bootstrap — two inputs, same shape for every lib

Each library reads two environment inputs at startup. **Both support a `_FILE` variant** for VPS / Docker / k8s setups where the secret lives at a host path.

```bash
# Cloud-platform pattern (Vercel / ECS / Cloud Run / Azure App Service):
VSYNC_CONFIG=vsync-cfg-v1:H4sIAAAA...     # the platform's secret store injects this
VSYNC_PASSPHRASE=correct-horse-battery-staple

# VPS / Docker pattern:
VSYNC_CONFIG_FILE=/etc/vsync/config       # host file, mounted into container
VSYNC_PASSPHRASE_FILE=/etc/vsync/pw       # 0600, owned root:appuser
```

Mint `VSYNC_CONFIG` with the CLI on your laptop:

```bash
vsync runtime-token --env=prod
# → vsync-cfg-v1:H4sIAAAA...   (paste into your deployment platform's env)
```

See [Minting bootstrap tokens](/guide/runtime-token) for the full workflow.

## Quickstart per language

### Python

```python
# install
# pip install vsync-s3-client

import vsync_s3_client

# context manager (recommended)
with vsync_s3_client.open() as v:
    db_url    = v.get("DATABASE_URL")          # str | None
    has_key   = v.has("STRIPE_KEY")            # bool
    source    = v.source("DATABASE_URL")       # "vault" | "env" | "default" | "missing"
    sa_bytes  = v.asset_bytes("gcp-sa.json")   # bytes
    sa_path   = v.asset_path("gcp-sa.json")    # str (0600 tempfile)
    gen       = v.generation()                 # int — bumps on every rotate-passphrase

# explicit handle (long-lived apps)
v = vsync_s3_client.open(defaults={"PORT": "8080"})
try:
    do_work(v.get("DATABASE_URL"))
finally:
    v.close()

# module-level singleton (scripts)
db = vsync_s3_client.get("DATABASE_URL")
```

### TypeScript / Node

```typescript
// install
// npm install @muthuishere/vsync-s3-client

import { open } from "@muthuishere/vsync-s3-client";

const v = await open({ defaults: { PORT: "8080" } });

const dbUrl  = v.get("DATABASE_URL");                    // string | null
const has    = v.has("STRIPE_KEY");                      // boolean
const source = v.source("DATABASE_URL");                 // "vault" | "env" | "default" | "missing"
const bytes  = v.assetBytes("gcp-sa.json");              // Uint8Array
const path   = await v.assetPath("gcp-sa.json");         // string — 0600 tempfile
const gen    = v.generation();                           // number

await v.close();                                         // best-effort zeroing + tempfile cleanup
```

Async only on the boundaries (`open`, `assetPath`, `close`). `get` / `has` / `source` / `assetBytes` / `generation` are sync and pure-memory after `open` returns.

### Go

```go
// go get github.com/muthuishere/vsync/libraries/go@v0.11.0

package main

import (
    "context"
    "log"
    vsync "github.com/muthuishere/vsync/libraries/go"
)

func main() {
    v, err := vsync.Open(context.Background(),
        vsync.WithDefaults(map[string]string{"PORT": "8080"}),
    )
    if err != nil {
        log.Fatal(err)
    }
    defer v.Close()

    dbURL, ok := v.Get("DATABASE_URL")                  // string, bool
    has      := v.Has("STRIPE_KEY")                     // bool
    source   := v.Source("DATABASE_URL")                // vsync.Source enum
    bytes, _ := v.AssetBytes("gcp-sa.json")             // []byte
    path,  _ := v.AssetPath("gcp-sa.json")              // string — 0600 tempfile
    gen      := v.Generation()                          // int64
    _ = dbURL; _ = ok; _ = has; _ = source; _ = bytes; _ = path; _ = gen
}
```

Errors are sentinel values for `errors.Is` matching. Explicit `context.Context` on `Open` (cancellation + deadline); pure-memory accessors don't take context.

### Java

```xml
<!-- Maven coordinate -->
<dependency>
    <groupId>io.github.muthuishere</groupId>
    <artifactId>vsync-s3-client</artifactId>
    <version>0.11.0</version>
</dependency>
```

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.VsyncClient;

public class App {
    public static void main(String[] args) throws Exception {
        try (Vsync v = VsyncClient.open()) {
            String dbUrl   = v.get("DATABASE_URL");           // null if missing
            boolean has    = v.has("STRIPE_KEY");
            var source     = v.source("DATABASE_URL");        // Source enum
            byte[] bytes   = v.assetBytes("gcp-sa.json");
            String path    = v.assetPath("gcp-sa.json");      // 0600 tempfile
            long gen       = v.generation();
        }
    }
}
```

Implements `AutoCloseable` for try-with-resources. JDK 17+. Runs on JDK 21 too.

## Fallback chain — same order in every language

When you call `get("KEY")`, the library resolves it in this exact order:

1. **`vault[env][key]`** — the decrypted bundle, scoped to the env from `VSYNC_CONFIG`. → `source = "vault"`.
2. **`process env[key]`** — `os.environ` / `process.env` / `os.Getenv` at lookup time. → `source = "env"`.
3. **`defaults[key]`** — the dict you passed to `open(defaults=…)`. → `source = "default"`.
4. **missing** — language-idiomatic null. → `source = "missing"`.

The order is locked. `has(key)` returns true iff steps 1–3 would resolve. `source(key)` returns the step label **without revealing the value** — safe to log.

## Error taxonomy — 7 classes, same set, idiomatic per language

| Canonical name | Python | TypeScript | Go | Java |
|---|---|---|---|---|
| `ConfigMissingError` | `ConfigMissingError` | `ConfigMissingError` | `ErrConfigMissing` | `ConfigMissingException` |
| `ConfigUnsupportedVersionError` | `ConfigUnsupportedVersionError` | `ConfigUnsupportedVersionError` | `ErrConfigUnsupportedVersion` | `ConfigUnsupportedVersionException` |
| `S3UnreachableError` | `S3UnreachableError` | `S3UnreachableError` | `ErrS3Unreachable` | `S3UnreachableException` |
| `ManifestNotFoundError` | `ManifestNotFoundError` | `ManifestNotFoundError` | `ErrManifestNotFound` | `ManifestNotFoundException` |
| `WrongPassphraseError` | `WrongPassphraseError` | `WrongPassphraseError` | `ErrWrongPassphrase` | `WrongPassphraseException` |
| `BundleCorruptError` | `BundleCorruptError` | `BundleCorruptError` | `ErrBundleCorrupt` | `BundleCorruptException` |
| `UnsupportedSpecVersionError` | `UnsupportedSpecVersionError` | `UnsupportedSpecVersionError` | `ErrUnsupportedSpecVersion` | `UnsupportedSpecVersionException` |

The conformance corpus pins error identity by canonical name; the loader maps to each language's idiomatic shape via a small translation table.

## Asset materialization — bytes vs path

`asset_bytes(name)` is in-memory. Always. Use this when you can.

`asset_path(name)` materializes the bytes to a process-private tempfile (`mkdtemp` mode `0700`, file mode `0600`), prefers `/dev/shm` on Linux, returns the path. Use this only when an SDK demands a filesystem path — Google Cloud SDK reading `GOOGLE_APPLICATION_CREDENTIALS`, OpenSSL reading a cert file, JVM truststores, etc.

**`SIGKILL` does not run `close()` → tempfiles leak until next reboot (tmpfs) or sweep.** Documented honestly in every binding.

## Trust ceiling — read the spec, not the marketing

The two-input bootstrap (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`) is a **separation-of-leak-channels** design, not multi-factor authentication. State the boundary plainly.

**Protects against** asymmetric leakage: bucket-misconfig bundle theft, infra-repo `VSYNC_CONFIG` leak (passphrase elsewhere), partial log capture, operator-error in one system.

**Does NOT protect against** full process compromise, CI log dumps that print all env vars, Sentry / Datadog auto-capturing `process.env`, malicious dependencies in your own process, backup tapes that copy both halves.

It's **defense in depth**. It is **not** MFA. It is **not** end-to-end encryption from operator to application — the passphrase is in the platform secret store; the platform admin can read it.

Document this section in your runbook. The worst failure mode is an operator who believes the wrong story.

## Cross-language byte compat — the load-bearing guarantee

All four libraries pass the same 31-vector conformance corpus at [`docs/specs/test-vectors/`](https://github.com/muthuishere/vsync/tree/main/docs/specs/test-vectors). Each lib's CI walks the corpus, dispatches by category, asserts byte-identical output (or class-identical error). If you wrote a vault with the Bun CLI on a teammate's laptop, all four libs will read it — same plaintext, same fallback chain, same error class on a wrong passphrase.

Run your own conformance check:

```bash
# Python
cd libraries/python && pytest tests/conformance/

# TypeScript
cd libraries/typescript && npx vitest run test/conformance.test.ts

# Go
cd libraries/go && go test -run TestConformance ./...

# Java
cd libraries/java && mvn test -Dtest='*ConformanceTest'
```

Or run everything at once from repo root: `task test:all`.

## Pull-once semantics — no refresh, no daemon

`open()` does one S3 round trip (manifest + bundle) and that's it. There is no `refresh()` method, no background watcher, no `If-Modified-Since` polling, no filesystem cache. **To pick up new secrets, restart the process.** This composes cleanly with every orchestrator (Kubernetes rollout, systemd restart, Vercel redeploy, Cloud Run new revision) without the library needing to know about any of them.

If you want live-reload, the right place to implement it is **one layer up** — a sidecar that touches a file → app watches the file → exits → orchestrator restarts. Not inside this library.

### Checking whether a newer version exists — `has_new_version`

Restart-only doesn't mean blind. Each lib exposes a lightweight **explicit-poll** method so a `/healthz` endpoint or sidecar cron can check whether the in-process bundle is stale, without the lib doing anything automatic about it:

```python
# Python
v.generation()             # int — gen captured at open time, never mutated by polling
v.remote_generation()      # int — single HEAD on the manifest, raises on network failure
v.has_new_version()        # bool — convenience: remote > local
```

```typescript
// TypeScript
v.generation()                     // number
await v.remoteGeneration()         // number
await v.hasNewVersion()            // boolean
```

```go
// Go
v.Generation()                      // int
v.RemoteGeneration(ctx)             // (int64, error)
v.HasNewVersion(ctx)                // (bool, error)
```

```java
// Java
v.generation()                      // long
v.remoteGeneration()                // long
v.hasNewVersion()                   // boolean
```

**One HEAD per call. No background thread, no callbacks, no state mutation.** The local `generation()` stays whatever `open()` captured — polling never changes it. Errors propagate (`S3UnreachableError` / `ManifestNotFoundError`); most apps treat "unknown" as "don't restart for now."

Typical pattern — a `/healthz` endpoint that reports staleness so the orchestrator (or a human) can decide whether to roll:

```python
@app.get("/healthz")
def healthz():
    try:
        if v.has_new_version():
            return {
                "status": "stale",
                "local_gen": v.generation(),
                "remote_gen": v.remote_generation(),
            }, 200
        return {"status": "fresh", "gen": v.generation()}, 200
    except S3UnreachableError:
        # Network blip — don't trigger a restart on transient failure
        return {"status": "unknown", "gen": v.generation()}, 200
```

Or a sidecar cron that polls every few minutes and signals the orchestrator:

```python
# Cron-scheduled
if v.has_new_version():
    requests.post("http://orchestrator/restart-when-idle", json={"reason": "vault rotated"})
```

The library tells you the **answer to a question**. It never changes the bundle in memory. Restart is still the only way to actually pick up new secrets.

## Where to go next

- **Mint your first bootstrap blob:** [Runtime tokens](/guide/runtime-token)
- **Rotate the passphrase safely:** [Rotation](/guide/runtime-token#rotating-the-passphrase)
- **Set up profiles for multiple environments:** [Profiles](/guide/profiles)
- **Read the spec:** [`v0.12-vsync-s3-client`](/specs/v0.12-vsync-s3-client)
- **Read the conformance protocol:** [`v0.11-conformance-test-vectors`](/specs/v0.11-conformance-test-vectors)
