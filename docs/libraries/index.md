# Runtime libraries

The CLI writes the vault. **These libraries read it** — directly from S3, inside your application process, in one round trip.

Four languages ship at the same version (`0.11.0`), behaviorally identical, sharing the same wire format and conformance corpus.

| Language | Package | Detail page |
|---|---|---|
| Python _(reference impl)_ | `vsync-s3-client` on PyPI | [Python →](/libraries/python) |
| TypeScript / Node | `@muthuishere/vsync-s3-client` on npm | [TypeScript →](/libraries/typescript) |
| Go | `github.com/muthuishere/vsync/libraries/go` | [Go →](/libraries/go) |
| Java | `io.github.muthuishere:vsync-s3-client` on Maven Central | [Java →](/libraries/java) |

All four pass the same 31-vector cross-language conformance corpus at [`docs/specs/test-vectors/`](https://github.com/muthuishere/vsync/tree/main/docs/specs/test-vectors). If your Python lib decodes a bundle, your TypeScript / Go / Java libs will too — byte-for-byte.

## What they're for

Your application boots. It needs `DATABASE_URL`, `STRIPE_KEY`, the GCP service-account JSON, the TLS cert chain. Today that's split between `process.env`, hand-managed `.env` files, and ad-hoc mounted secret files.

With a runtime lib:

```python
import vsync_s3_client

with vsync_s3_client.open() as v:
    db = v.get_env("DATABASE_URL")             # → "postgres://..."
    src = v.env_source("DATABASE_URL")         # → "vault" | "env" | "default" | "missing"
    sa_bytes = v.get_as_content("gcp-sa.json") # → bytes; write a tempfile yourself if needed
```

One process-input pair (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`), one S3 round trip at `open()`, then everything's in memory with a deterministic fallback chain. No daemon, no refresh, no filesystem cache.

## API at a glance — same shape, four languages

Every binding exposes the same set of operations under language-idiomatic names:

| Operation | Python | TypeScript | Go | Java |
|---|---|---|---|---|
| Open from env vars | `open()` | `open()` | `Open(ctx)` | `VsyncClient.open()` |
| Open from strings | `open_with(...)` | `openWith(...)` | `OpenWith(ctx, ...)` | `VsyncClient.openWith(...)` |
| Get a string value | `get_env(k)` | `getEnv(k)` | `GetEnv(k)` | `getEnv(k)` |
| Has the key? | `has_env(k)` | `hasEnv(k)` | `HasEnv(k)` | `hasEnv(k)` |
| Where did it resolve? | `env_source(k)` | `envSource(k)` | `EnvSource(k)` | `envSource(k)` |
| Get bytes | `get_as_content(name)` | `getAsContent(name)` | `GetAsContent(name)` | `getAsContent(name)` |
| Local generation | `generation()` | `generation()` | `Generation()` | `generation()` |
| Remote generation | `remote_generation()` | `remoteGeneration()` | `RemoteGeneration(ctx)` | `remoteGeneration()` |
| Stale? | `has_new_version()` | `hasNewVersion()` | `HasNewVersion(ctx)` | `hasNewVersion()` |
| Cleanup | `close()` | `close()` | `Close()` | `close()` (or try-with-resources) |

Per-language idioms (context vs. options, sync vs. async, error vs. exception) live on each detail page.

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

`_FILE` wins if both forms are set. Trailing whitespace on file values is stripped; env values are taken verbatim (leading space in a passphrase IS part of the passphrase).

Mint `VSYNC_CONFIG` with the CLI on your laptop:

```bash
vsync runtime-token --env=prod
# → vsync-cfg-v1:H4sIAAAA...   (paste into your deployment platform's env)
```

See [Minting bootstrap tokens](/guide/runtime-token) for the full workflow.

### When to use `openWith` instead of `open`

`open()` reads `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` from the process environment — the right default when your platform's secret store injects directly.

`open_with(config, passphrase, ...)` accepts the two strings directly — the right choice when:

- Your secrets layer is something other than env vars (KMS, AWS Secrets Manager fetched at boot, HashiCorp Vault, a CI variable that you'd rather not export).
- You want to decode `VSYNC_CONFIG` into multiple env handles (one process, multiple environments).
- You're testing — pass synthetic strings, no `os.environ` mutation.

Both return the same handle; behavioral parity from then on. See each language page for the signature.

## Fallback chain — same order in every language

When you call `get_env("KEY")`, the library resolves it in this exact order:

1. **`vault[env][key]`** — the decrypted bundle, scoped to the env from `VSYNC_CONFIG`. → `env_source = "vault"`.
2. **`process env[key]`** — `os.environ` / `process.env` / `os.Getenv` at lookup time. → `env_source = "env"`.
3. **`defaults[key]`** — the dict you passed to `open(defaults=…)`. → `env_source = "default"`.
4. **missing** — language-idiomatic null. → `env_source = "missing"`.

The order is locked. `has_env(key)` returns true iff steps 1–3 would resolve. `env_source(key)` returns the step label **without revealing the value** — safe to log.

Rationale:

- **Vault wins** so operators can override a bad value by re-pushing, not by SSHing to the box.
- **Env beats defaults** so a deploy can hot-patch (`DATABASE_URL=...` on the unit file) without a code change.
- **Defaults are the floor** — "if literally nothing else said anything, here's a value."
- **"Missing" is a real state.** Callers decide if missing is fatal; the library doesn't impose that policy.

## Error taxonomy — 7 classes, same set, idiomatic per language

| Canonical name | Meaning | Caller's recourse |
|---|---|---|
| `ConfigMissingError` | `VSYNC_CONFIG` / `VSYNC_PASSPHRASE` unset, or magic prefix wrong | fix the deploy config |
| `ConfigUnsupportedVersionError` | inner JSON `v` newer than the lib understands | upgrade the library |
| `S3UnreachableError` | network, DNS, TLS, or HTTP 4xx/5xx on fetch | check S3 connectivity & IAM |
| `ManifestNotFoundError` | bucket reachable, `<prefix>manifest` absent | run `vsync push <env>` once |
| `WrongPassphraseError` | GCM auth tag rejected the passphrase | rotate / re-key |
| `BundleCorruptError` | magic byte mismatch / truncated read / manifest pointer dangling | re-push from the CLI |
| `UnsupportedSpecVersionError` | unknown `RQE1` / `RQEM0001` envelope version | upgrade the library |

Language renderings:

| Canonical | Python | TypeScript | Go | Java |
|---|---|---|---|---|
| `ConfigMissingError` | `ConfigMissingError` | `ConfigMissingError` | `ErrConfigMissing` | `ConfigMissingException` |
| `ConfigUnsupportedVersionError` | `ConfigUnsupportedVersionError` | `ConfigUnsupportedVersionError` | `ErrConfigUnsupportedVersion` | `ConfigUnsupportedVersionException` |
| `S3UnreachableError` | `S3UnreachableError` | `S3UnreachableError` | `ErrS3Unreachable` | `S3UnreachableException` |
| `ManifestNotFoundError` | `ManifestNotFoundError` | `ManifestNotFoundError` | `ErrManifestNotFound` | `ManifestNotFoundException` |
| `WrongPassphraseError` | `WrongPassphraseError` | `WrongPassphraseError` | `ErrWrongPassphrase` | `WrongPassphraseException` |
| `BundleCorruptError` | `BundleCorruptError` | `BundleCorruptError` | `ErrBundleCorrupt` | `BundleCorruptException` |
| `UnsupportedSpecVersionError` | `UnsupportedSpecVersionError` | `UnsupportedSpecVersionError` | `ErrUnsupportedSpecVersion` | `UnsupportedSpecVersionException` |

The conformance corpus pins error identity by canonical name; the loader maps to each language's idiomatic shape via a small translation table.

## Asset materialization — bytes, full stop

`get_as_content(name)` returns the raw bytes in memory. Always. Use this when you can.

**There is no `asset_path()` / `assetPath()` in any binding.** Earlier drafts had one — a lazy-tempfile materializer for SDKs that demand a filesystem path (GCP `GOOGLE_APPLICATION_CREDENTIALS`, OpenSSL cert files, JVM truststores). It's been removed. Each detail page shows the 3-line tempfile recipe for its language; the operator controls lifecycle and perms locally, which is better than the lib having to ship defaults for tmpdir choice, mode bits, `/dev/shm` preference, and SIGKILL cleanup forever.

## Trust ceiling — read the spec, not the marketing

The two-input bootstrap (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`) is a **separation-of-leak-channels** design, not multi-factor authentication. State the boundary plainly.

**Protects against** asymmetric leakage:

- Bucket misconfiguration — a world-readable bucket leaks ciphertext only.
- Infrastructure-repo leak — Terraform / Helm chart containing `VSYNC_CONFIG` leaks the S3 location and IAM key but not the passphrase.
- Partial log capture — `process.env` redactor catches one variable; a `/etc/myapp/env` cat catches the other; splitting reduces the chance one log dump has both.
- Operator error in one system — paste `VSYNC_CONFIG` into Slack; the passphrase lives elsewhere.

**Does NOT protect against**:

- Full process compromise — anything reading `/proc/<pid>/environ` has both halves; anything attaching `gdb` has the decrypted vault.
- CI log dumps that print all env vars (`env`, `printenv`, `set -x` near a curl).
- Sentry / Datadog / Honeycomb auto-capturing `process.env` on a crash.
- A malicious or compromised dependency inside the application — the library hands plaintext to the caller; the dependency runs in the same process.
- Backups that copy the host filesystem AND the platform secret store dump together.

**Explicit anti-claims**:

- This is **not MFA.** A second factor would be something the operator presents at boot (hardware token), not a second env var next to the first.
- This is **not end-to-end encryption** from operator to application. The passphrase is in the platform secret store; the platform admin can read it.
- "Defense in depth" describes this accurately. "Zero trust" does not.

Document this in your runbook. The worst failure mode is an operator who believes the wrong story.

## Pull-once semantics — no refresh, no daemon

`open()` does one S3 round trip (manifest + bundle) and that's it. There is no `refresh()` method, no background watcher, no `If-Modified-Since` polling, no filesystem cache. **To pick up new secrets, restart the process.** This composes cleanly with every orchestrator (Kubernetes rollout, systemd restart, Vercel redeploy, Cloud Run new revision) without the library needing to know about any of them.

If you want live-reload, the right place to implement it is **one layer up** — a sidecar that touches a file → app watches the file → exits → orchestrator restarts. Not inside this library.

### The `has_new_version` carve-out

Restart-only doesn't mean blind. Each lib exposes a lightweight **explicit-poll** method:

- `generation()` — the gen integer captured at `open()`. Never mutated by polling.
- `remote_generation()` — one HEAD on the manifest. Raises on network failure.
- `has_new_version()` — convenience: `remote > local`.

**One HEAD per call. No background thread, no callbacks, no state mutation.** Typical use: a `/healthz` endpoint reports staleness so the orchestrator (or a human) decides when to roll.

Each detail page shows the pattern.

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

## Where to go next

- **Pick a language and read its detail page:** [Python](/libraries/python) · [TypeScript](/libraries/typescript) · [Go](/libraries/go) · [Java](/libraries/java)
- **Mint your first bootstrap blob:** [Runtime tokens](/guide/runtime-token)
- **Rotate the passphrase safely:** [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook)
- **Real-world deploy recipes:** [Examples gallery](/examples/)
- **Read the spec:** [`v0.12-vsync-s3-client`](/specs/v0.12-vsync-s3-client)
- **Read the conformance protocol:** [`v0.11-conformance-test-vectors`](/specs/v0.11-conformance-test-vectors)
