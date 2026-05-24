# @muthuishere/vsync-s3-client

Read-side runtime library for the [vsync](https://github.com/muthuishere/secret-lib) ecosystem. **The CLI writes; this library reads.** One process input pair (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`), one S3 round trip at `open()`, an in-memory accessor with a deterministic fallback chain. No daemon, no refresh, no filesystem cache.

This is the **TypeScript port** of the cross-language client family. Behaviour is byte-for-byte identical with the Python reference impl on the shared conformance corpus at `docs/specs/test-vectors/`.

- **Spec:** [`docs/specs/v0.12-vsync-s3-client.md`](../../docs/specs/v0.12-vsync-s3-client.md)
- **Conformance corpus:** [`docs/specs/test-vectors/`](../../docs/specs/test-vectors/)
- **Wire envelope:** RQE1 ([v0.2 §3](../../docs/specs/v0.2-secret-lib.md)) + RQEM0001 ([v0.4](../../docs/specs/v0.4-audit-log.md))
- **Package version:** `0.11.0` (unified across the vsync CLI + all three language libs; pre-1.0; latest wire format only; no compatibility shims)

## Install

```bash
npm install @muthuishere/vsync-s3-client
```

Requires Node ≥ 20. Bun ≥ 1.2 works too (same `node:crypto` API surface). Runtime dep: `@aws-sdk/client-s3`. Everything else is the Node stdlib (`node:crypto`, `node:zlib`, `node:fs`).

## Quick start

```typescript
import { open } from "@muthuishere/vsync-s3-client";

const v = await open();
try {
  const dbUrl = v.getEnv("DATABASE_URL");          // → string | null
  const hasStripe = v.hasEnv("STRIPE_KEY");        // → boolean
  const src = v.envSource("DATABASE_URL");         // → "vault" | "env" | "default" | "missing"
  const saBytes = v.getAsContent("svc.json");      // Uint8Array, in-memory always
  const gen = v.generation();                      // monotonic counter, safe to log
} finally {
  await v.close();
}
```

Defaults are passed once at `open()`:

```typescript
const v = await open({ defaults: { PORT: "8080" } });
```

When bootstrap material lives outside the `VSYNC_CONFIG` / `VSYNC_PASSPHRASE` env vars (KMS, Hashicorp Vault, a CI variable), use `openWith` with the strings directly:

```typescript
import { openWith } from "@muthuishere/vsync-s3-client";

const v = await openWith({
  config: await kms.fetch("vsync/config"),
  passphrase: await kms.fetch("vsync/passphrase"),
  defaults: { PORT: "8080" },
});
```

`openWith` returns the same handle and behaves identically from then on. Empty `config` or empty `passphrase` raises `ConfigMissingError`.

Scripts that only need one value can use the module-level singleton (opens lazily, cached for process lifetime):

```typescript
import { getEnv } from "@muthuishere/vsync-s3-client";
console.log(await getEnv("DATABASE_URL"));
```

Long-running apps should hold a `Vsync` handle explicitly so they control its lifecycle.

## Two-input bootstrap

`open()` reads exactly two process inputs. No discovery, no `.vsyncrc`, no DNS.

| Input | Purpose | `_FILE` variant |
|---|---|---|
| `VSYNC_CONFIG` | gzip+base64url JSON blob (S3 endpoint, bucket, IAM key, salt, env) | `VSYNC_CONFIG_FILE` |
| `VSYNC_PASSPHRASE` | passphrase that unwraps the RQE1-encrypted bundle | `VSYNC_PASSPHRASE_FILE` |

`_FILE` wins if both forms are set (matches the PostgreSQL / Docker secrets convention). Trailing whitespace on file values is stripped; env values are taken verbatim (a leading space could be part of a passphrase).

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

1. `vault[env][key]` — the decrypted bundle. `envSource = "vault"`.
2. `process.env[key]` — at lookup time, not at open. `envSource = "env"`.
3. `defaults[key]` — the dict passed at `open({ defaults: ... })`. `envSource = "default"`.
4. missing — returns `null`. `envSource = "missing"`.

`hasEnv(key)` is true iff steps 1–3 resolve. `envSource(key)` returns the label of the winning step **without** returning the value — safe to log.

## Errors

All errors subclass `VSyncError`. The taxonomy is fixed (the canonical names cross language boundaries via the conformance corpus):

| Error | Code | When |
|---|---|---|
| `ConfigMissingError` | `VSYNC_CONFIG_MISSING` | `VSYNC_CONFIG` / `VSYNC_PASSPHRASE` unset, or magic prefix wrong |
| `ConfigUnsupportedVersionError` | `VSYNC_CONFIG_UNSUPPORTED_VERSION` | inner JSON `v:` newer than this library |
| `S3UnreachableError` | `VSYNC_S3_UNREACHABLE` | network, DNS, TLS, or HTTP 4xx/5xx on the fetch |
| `ManifestNotFoundError` | `VSYNC_MANIFEST_NOT_FOUND` | bucket reachable, `<prefix>manifest` absent — run `vsync push` first |
| `WrongPassphraseError` | `VSYNC_WRONG_PASSPHRASE` | AES-GCM tag rejected the passphrase |
| `BundleCorruptError` | `VSYNC_BUNDLE_CORRUPT` | magic byte mismatch, truncated read, manifest→bundle dangling |
| `UnsupportedSpecVersionError` | `VSYNC_UNSUPPORTED_SPEC_VERSION` | unknown `RQE1` / `RQEM0001` envelope version |

Switch on `error.code` (stable machine handle) or `error instanceof WrongPassphraseError` (typed). Both are first-class.

`open()` does **not** silently degrade to env-vars-only when S3 is down — it throws `S3UnreachableError`. A process that booted with "env vars only because S3 was down" is harder to debug than one that refused to boot.

## Asset content

`getAsContent(name)` returns the asset bytes as a `Uint8Array`. It never touches the filesystem and is synchronous — the bytes are decrypted into memory at `open()` time.

There is **no `assetPath()` accessor.** SDKs that demand a filesystem path (GCP `GOOGLE_APPLICATION_CREDENTIALS`, OpenSSL cert files, JVM keystores) are easy to satisfy at the call site — three lines, with the operator in control of tmpdir, mode bits, and cleanup:

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "vsync-"));
const path = join(dir, "gcp-sa.json");
writeFileSync(path, v.getAsContent("gcp-sa.json"), { mode: 0o600 });
process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
```

Rationale (v0.12 §6): the library had no good default for tmpdir choice, mode bits, `/dev/shm` preference, or SIGKILL cleanup. Pushing materialization to the caller keeps the lib's contract minimal and the operator in control of lifecycle.

## Redaction

`JSON.stringify(v)` and Node's `util.inspect(v)` return `<vsync:redacted gen=N env=<env>>`. Vault values never leak through serialization. `envSource(key)`, `hasEnv(key)`, and `generation()` are safe to log. `getEnv(key)` and `getAsContent(name)` results are **never** safe to log.

The library does not install global error handlers, monkey-patch `console.log`, or filter Sentry breadcrumbs. Application-level observability hygiene is the caller's job.

## Trust Boundaries and Honest Limits

(Verbatim from [`v0.12 §9`](../../docs/specs/v0.12-vsync-s3-client.md#9-threat-model--what-the-design-is-and-is-not-protecting-against).)

The two-variable split (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`) is a **separation-of-leak-channels** design, not multi-factor authentication. State the boundary plainly so operators don't model the wrong threat.

**Protects against (asymmetric leakage):**

- Bucket misconfiguration. A world-readable bucket leaks the encrypted bundle. Without the passphrase, the bundle is ciphertext.
- Infrastructure-repo leak. A leaked Terraform / Helm chart that contains `VSYNC_CONFIG` leaks the S3 location and IAM key but not the passphrase (kept in the platform secret store).
- Partial log capture. A logger that prints `process.env` minus a denylist may catch one variable; a logger that prints `/etc/myapp/env` may capture the other. Splitting reduces the chance one log dump has both.
- Operator error inside one system. Someone pastes `VSYNC_CONFIG` into a Slack channel; the passphrase lives elsewhere.

**Does NOT protect against (the process is its own attack surface):**

- Full process compromise. Anything that can read `/proc/<pid>/environ` has both halves. Anything that can attach a debugger to the process has the decrypted vault.
- CI log dumps that print all env vars (`env`, `printenv`, `set -x` near a curl). If the runner logs both, both are gone.
- Sentry / Datadog / Honeycomb auto-capturing `process.env` on a crash. Same channel.
- A malicious or compromised dependency inside the application. The library hands plaintext to the caller; the dependency runs in the same process.
- Backups that copy the host filesystem (`/run/secrets/...`) and the platform secret-store dump together. Both halves on one backup tape = no split.

**Explicit anti-claims:**

- This is **not MFA.** A second factor would be something the operator presents at boot (hardware token), not a second env var that lives next to the first.
- This is **not end-to-end encryption from the operator to the application.** The passphrase is in the platform secret store; the platform admin can read it.
- "Defense in depth" describes this accurately. "Zero trust" does not.

The worst failure mode is an operator who believes the wrong story. Read this section before deploying.

## Salt byte-semantics (load-bearing)

For interop with the CLI's own `crypto.ts::deriveKey` and the cross-language test-vector corpus, the `salt` field in the inner JSON is treated as a **string** and its **UTF-8 bytes** are fed directly to PBKDF2. The lib does **not** base64-decode the field before PBKDF2. This is documented at `docs/specs/v0.12-vsync-s3-client.md §2.1` (post-revision); ignore older readings of the spec that called for raw-bytes decoding.

## Testing

```bash
cd libraries/typescript
npm install
npm test                                  # unit + conformance (vitest)
npx vitest run test/conformance.test.ts   # cross-language conformance only
npm run typecheck                         # tsc --noEmit
npm run build                             # emit to dist/
```

The conformance suite walks `docs/specs/test-vectors/` and runs the corpus's `.bin` fixtures through this library's decode path. Per [`v0.11`](../../docs/specs/v0.11-conformance-test-vectors.md), error class identity is matched on the `name` property — not on a generic `Error` catch. Override the corpus location with `VSYNC_TEST_VECTORS_DIR=/path/to/test-vectors` when running against a regenerated corpus in `/tmp`.

## Honest limits

RQE1 truncation detection is **best-effort**:

- A **structurally short** envelope (< 32 bytes — less than `magic(4) + IV(12) + GCM-tag(16)`) is detected and throws `BundleCorruptError`.
- A **mid-payload truncation that lands on a tag-length boundary** is indistinguishable from a wrong-passphrase tag failure and surfaces as `WrongPassphraseError`. This is a property of AES-GCM without an explicit plaintext-length field on the wire — not a lib bug.

The conformance corpus's `rqe1-decrypt-error/truncated-ciphertext` vector exercises the structural path and passes.

## File layout

```text
libraries/typescript/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md                       (you are here)
├── src/
│   ├── index.ts                    public API re-exports
│   ├── client.ts                   Vsync handle + open() / openWith() / getEnv()
│   ├── crypto.ts                   RQE1 decrypt
│   ├── manifest.ts                 RQEM0001 read + pointer-seal verify
│   ├── config-blob.ts              VSYNC_CONFIG decode (magic / base64url / gzip / JSON)
│   ├── sources.ts                  two-input bootstrap resolution
│   └── errors.ts                   taxonomy
└── test/
    ├── crypto.test.ts
    ├── manifest.test.ts
    ├── config-blob.test.ts
    ├── sources.test.ts
    ├── client.test.ts
    ├── get-as-content.test.ts
    ├── errors.test.ts
    └── conformance.test.ts
```

## License

MIT.
