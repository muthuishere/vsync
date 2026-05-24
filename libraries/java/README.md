# vsync-s3-client (Java)

Read-side runtime library for the [vsync](https://github.com/muthuishere/secret-lib) ecosystem. **The CLI writes; this library reads.** One process input pair (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`), one S3 round trip at `open()`, an in-memory accessor with a deterministic fallback chain. No daemon, no refresh, no filesystem cache.

This is the **Java port** of the cross-language client family. The Python lib at [`libraries/python/`](../python/) is the reference implementation; this port pins behavioural parity to it via the corpus at [`docs/specs/test-vectors/`](../../docs/specs/test-vectors/).

- **Spec:** [`docs/specs/v0.12-vsync-s3-client.md`](../../docs/specs/v0.12-vsync-s3-client.md)
- **Conformance corpus:** [`docs/specs/test-vectors/`](../../docs/specs/test-vectors/)
- **Wire envelope:** RQE1 ([v0.2 §3](../../docs/specs/v0.2-secret-lib.md)) + RQEM0001 ([v0.4](../../docs/specs/v0.4-audit-log.md))
- **Package version:** `0.11.0` (unified across the vsync CLI + all language libs; pre-1.0; latest wire format only; no compatibility shims)

## Install

Maven coordinate:

```xml
<dependency>
    <groupId>io.github.muthuishere</groupId>
    <artifactId>vsync-s3-client</artifactId>
    <version>0.11.0</version>
</dependency>
```

Gradle (Groovy):

```groovy
implementation 'io.github.muthuishere:vsync-s3-client:0.11.0'
```

Gradle (Kotlin DSL):

```kotlin
implementation("io.github.muthuishere:vsync-s3-client:0.11.0")
```

Requires Java 17+. Dependencies: AWS SDK Java v2 (`software.amazon.awssdk:s3:2.30.x`) and Jackson (`com.fasterxml.jackson.core:jackson-databind:2.18.x`). All crypto is JDK stdlib (`javax.crypto`).

## Quick start

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.VsyncClient;
import io.github.muthuishere.vsync.s3client.client.Source;

try (Vsync v = VsyncClient.open()) {
    String dbUrl = v.getEnv("DATABASE_URL");                     // null if missing
    boolean hasStripe = v.hasEnv("STRIPE_KEY");                  // boolean
    Source src = v.envSource("DATABASE_URL");                    // VAULT | ENV | DEFAULT | MISSING
    byte[] svcBytes = v.getAsContent("svc.json");                // bytes, in-memory only
    long gen = v.generation();                                   // monotonic counter, safe to log
    long remote = v.remoteGeneration();                          // one manifest read, doesn't mutate local
    boolean stale = v.hasNewVersion();                           // remote > local
}
```

Two open paths — `open()` reads `VSYNC_CONFIG` + `VSYNC_PASSPHRASE` from the process env; `openWith(config, passphrase)` accepts the strings directly (for callers whose config lives in a custom secrets store — KMS, Hashicorp Vault, a CI variable):

```java
try (Vsync v = VsyncClient.openWith(configBlob, passphrase)) {
    String dbUrl = v.getEnv("DATABASE_URL");
}
```

Both throw `ConfigMissingException` if a required input is null / empty. Defaults are seeded at open time:

```java
import io.github.muthuishere.vsync.s3client.client.OpenOptions;
import java.util.Map;

Vsync v = VsyncClient.open(new OpenOptions().withDefaults(Map.of("PORT", "8080")));
// or
Vsync v2 = VsyncClient.openWith(configBlob, passphrase,
        new OpenOptions().withDefaults(Map.of("PORT", "8080")));
```

`Vsync` implements `AutoCloseable` — prefer try-with-resources so `close()` zeroes the in-memory plaintext.

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

`v.getEnv(key)` resolves in exactly this order. No reordering, no per-key overrides:

1. `vault[env][key]` — the decrypted bundle. `envSource = VAULT`.
2. `System.getenv(key)` — at lookup time, not at open. `envSource = ENV`.
3. `defaults[key]` — the dict passed at `OpenOptions.withDefaults(...)`. `envSource = DEFAULT`.
4. missing — returns `null`. `envSource = MISSING`.

`hasEnv(key)` is true iff steps 1–3 resolve. `envSource(key)` returns the label of the winning step **without** returning the value — safe to log.

## Errors

All exceptions extend `VSyncException` (unchecked). The taxonomy is fixed; the canonical names cross language boundaries through the conformance corpus and the `canonicalName()` static helper on each subclass:

| Exception | Canonical name (corpus) | When |
|---|---|---|
| `ConfigMissingException` | `ConfigMissingError` | `VSYNC_CONFIG` / `VSYNC_PASSPHRASE` unset, or magic prefix wrong |
| `ConfigUnsupportedVersionException` | `ConfigUnsupportedVersionError` | inner JSON `v:` newer than this library |
| `S3UnreachableException` | `S3UnreachableError` | network, DNS, TLS, or HTTP 4xx/5xx on the fetch |
| `ManifestNotFoundException` | `ManifestNotFoundError` | bucket reachable, `<prefix>manifest` absent — run `vsync push` first |
| `WrongPassphraseException` | `WrongPassphraseError` | AES-GCM tag rejected the passphrase |
| `BundleCorruptException` | `BundleCorruptError` | magic byte mismatch, truncated read, manifest→bundle dangling |
| `UnsupportedSpecVersionException` | `UnsupportedSpecVersionError` | unknown `RQE1` / `RQEM0001` envelope version |

Java idiom uses `Exception` as the suffix; the conformance corpus uses `Error` (matching the Python / JS spelling). Each subclass exposes a `static String canonicalName()` returning the spec name, and the `Exceptions.canonicalNameOf(Throwable)` helper does the lookup.

`open()` does **not** silently degrade to env-vars-only when S3 is down — it raises `S3UnreachableException`. A process that booted with "env vars only because S3 was down" is harder to debug than one that refused to boot.

## Binary content

`getAsContent(name)` returns the bytes for an inlined binary blob (JSON keys, certs, etc., inlined via the CLI's `--inline-file-suffix`). In-memory only — the library does not materialize to disk.

If an SDK demands a filesystem path (`GOOGLE_APPLICATION_CREDENTIALS`, OpenSSL cert paths, JVM keystores), write the bytes to a tempfile yourself:

```java
byte[] bytes = v.getAsContent("gcp-sa.json");
Path dir = Files.createTempDirectory("vsync-");
Path path = dir.resolve("gcp-sa.json");
Files.write(path, bytes);
Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
System.setProperty("GOOGLE_APPLICATION_CREDENTIALS", path.toString());
```

The operator controls lifecycle (tempdir choice, mode bits, /dev/shm preference, cleanup on exit) rather than the library carrying that machinery forever.

## Redaction

`Vsync.toString()` returns `"<vsync:redacted>"`. `VsyncConfig.toString()` redacts `accessKeyId`, `secretAccessKey`, and `salt` (non-secret fields like `endpoint`, `bucket`, `env`, `iterations` are kept — operators want to see them when debugging). Vault values never leak through serialization.

`envSource(key)`, `hasEnv(key)`, and `generation()` are safe to log. `getEnv(key)` and `getAsContent(name)` results are **never** safe to log.

The library does not install global panic handlers, monkey-patch `System.out`, or filter SLF4J appenders. Application-level observability hygiene is the caller's job.

## Trust Boundaries and Honest Limits

The two-variable split (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`) is a **separation-of-leak-channels** design, not multi-factor authentication. State the boundary plainly so operators don't model the wrong threat.

**Protects against (asymmetric leakage):**

- Bucket misconfiguration. A world-readable bucket leaks the encrypted bundle. Without the passphrase, the bundle is ciphertext.
- Infrastructure-repo leak. A leaked Terraform / Helm chart that contains `VSYNC_CONFIG` leaks the S3 location and IAM key but not the passphrase (kept in the platform secret store).
- Partial log capture. A logger that prints `process.env` minus a denylist may catch one variable; a logger that prints `/etc/myapp/env` may capture the other. Splitting reduces the chance one log dump has both.
- Operator error inside one system. Someone pastes `VSYNC_CONFIG` into a Slack channel; the passphrase lives elsewhere.

**Does NOT protect against (the process is its own attack surface):**

- Full process compromise. Anything that can read `/proc/<pid>/environ` has both halves. Anything that can attach a debugger to the JVM has the decrypted vault.
- CI log dumps that print all env vars (`env`, `printenv`, `set -x` near a curl). If the runner logs both, both are gone.
- Sentry / Datadog / Honeycomb auto-capturing the environment on a crash. Same channel.
- A malicious or compromised dependency inside the application. The library hands plaintext to the caller; the dependency runs in the same JVM.
- Backups that copy the host filesystem (`/run/secrets/...`) and the platform secret-store dump together. Both halves on one backup tape = no split.

**Explicit anti-claims:**

- This is **not MFA.** A second factor would be something the operator presents at boot (hardware token), not a second env var that lives next to the first.
- This is **not end-to-end encryption from the operator to the application.** The passphrase is in the platform secret store; the platform admin can read it.
- "Defense in depth" describes this accurately. "Zero trust" does not.

The worst failure mode is an operator who believes the wrong story. Read this section before deploying.

## Honest limits

RQE1 truncation detection is **best-effort**:

- A **structurally short** envelope (< 32 bytes — less than `magic(4) + IV(12) + GCM-tag(16)`) is detected and raises `BundleCorruptException`.
- A **mid-payload truncation that lands on a tag-length boundary** is indistinguishable from a wrong-passphrase tag failure, and surfaces as `WrongPassphraseException`. This is a property of AES-GCM without an explicit plaintext-length field on the wire — not a lib bug.

The conformance corpus's `rqe1-decrypt-error/truncated-ciphertext` vector exercises the structural path and passes.

## Testing

```bash
cd libraries/java
mvn test                                   # unit + conformance (121 tests)
mvn -Dtest='ConformanceTest' test          # cross-language conformance only (33 tests)
```

The conformance suite walks `docs/specs/test-vectors/` and runs the corpus's `.bin` fixtures through this library's decode path. Per [v0.11](../../docs/specs/v0.11-conformance-test-vectors.md), error class identity is matched on the canonical name returned by `Exceptions.canonicalNameOf(Throwable)` — NOT on `Class.getSimpleName()` (which would be `WrongPassphraseException`, missing the corpus's `WrongPassphraseError`).

Override the corpus location with `VSYNC_TEST_VECTORS_DIR=/path/to/test-vectors` (useful when running against a regenerated corpus in `/tmp`).

## Publishing to Maven Central

This Maven project is wired for Central publishing via the `release` profile (`maven-gpg-plugin` + `central-publishing-maven-plugin`). Operator-only — requires a Sonatype Central token + a GPG signing key.

```bash
# One-time setup: configure ~/.m2/settings.xml with <servers><server><id>central</id>...</server></servers>
# and import / list your GPG key.

mvn -Prelease deploy
```

`task publish:dry-run` builds + installs the JAR to the local Maven cache (`~/.m2/repository`) without uploading.

## File layout

```text
libraries/java/
├── pom.xml
├── README.md                                          (you are here)
├── Taskfile.yml
├── src/main/java/io/github/muthuishere/vsync/s3client/
│   ├── crypto/
│   │   ├── Rqe1.java                                  RQE1 decrypt
│   │   └── Rqem0001.java                              RQEM0001 read + pointer-seal verify
│   ├── config/
│   │   ├── ConfigBlob.java                            VSYNC_CONFIG decode
│   │   └── VsyncConfig.java                           inner JSON shape
│   ├── sources/
│   │   └── BootstrapSources.java                      two-input bootstrap resolution
│   ├── client/
│   │   ├── Vsync.java                                 in-memory handle
│   │   ├── VsyncClient.java                           public open()/openWith()/openWithBootstrap()
│   │   ├── DefaultS3Fetcher.java                      AWS SDK v2 fetcher
│   │   ├── S3Fetcher.java                             test injection seam
│   │   ├── OpenOptions.java                           defaults + fetcher
│   │   └── Source.java                                VAULT | ENV | DEFAULT | MISSING
│   └── exceptions/
│       ├── VSyncException.java                        unchecked root
│       ├── ConfigMissingException.java
│       ├── ConfigUnsupportedVersionException.java
│       ├── S3UnreachableException.java
│       ├── ManifestNotFoundException.java
│       ├── WrongPassphraseException.java
│       ├── BundleCorruptException.java
│       ├── UnsupportedSpecVersionException.java
│       └── Exceptions.java                            canonicalNameOf() lookup
└── src/test/java/io/github/muthuishere/vsync/s3client/
    ├── crypto/Rqe1Test.java
    ├── crypto/Rqem0001Test.java
    ├── config/ConfigBlobTest.java
    ├── sources/BootstrapSourcesTest.java
    ├── client/VsyncTest.java
    ├── client/VsyncClientTest.java
    ├── client/GetAsContentTest.java
    ├── client/RedactionTest.java
    ├── exceptions/ExceptionsTest.java
    └── conformance/
        ├── Loader.java
        ├── Vector.java
        └── ConformanceTest.java
```

## License

MIT.
