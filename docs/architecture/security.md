# Security model

A complete picture of what vsync defends against and where the perimeter ends. The thesis: **two halves split across disk and OS keychain, ciphertext on S3, separation-of-leak-channels for runtime — defense in depth, not zero-trust, not MFA.**

## Operator-side threat model

| Threat | Defence |
|---|---|
| Attacker reads disk config only | Gets bucket creds + routing. **Cannot decrypt** any S3 bundle. |
| Attacker reads keychain only | Gets the AES key. **No bucket location**. No reach. |
| Attacker reads both | Compromises this (repo, env). **Rotate immediately** (see [incident response case 3](/guide/incident-response#case-3-both-halves-leaked)). |
| Attacker intercepts a `.share` file | Cannot decrypt without the passphrase. Mitigation: send file + passphrase on different channels. |
| Attacker tampers with an S3 bundle byte | AES-GCM auth tag rejects it on pull. `BundleCorruptError`. |
| Attacker swaps `latest` to point at an old bundle | Manifest pointer-seal (`RQEM0001`) catches it — `embedded_ts ≠ remote_ts` → refuse + report. |
| Local user on shared machine | `chmod 0600` on disk file + `0700` on dir = POSIX denies other users. macOS Keychain ACLs deny other login sessions. Windows: `%APPDATA%` user scope. |
| User commits the vault to git | `infra/vault/` is in `.gitignore` (added by `vsync init`). The disk config at `~/.config/…` is outside any repo. |

## Runtime-side threat model — separation of leak channels

The two-input bootstrap (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`) is a **separation-of-leak-channels** design, not multi-factor authentication. State the boundary plainly so operators don't model the wrong threat.

### Protects against (asymmetric leakage)

- **Bucket misconfiguration.** A world-readable bucket leaks the encrypted bundle. Without the passphrase, the bundle is ciphertext.
- **Infrastructure-repo leak.** A leaked Terraform / Helm chart that contains `VSYNC_CONFIG` leaks the S3 location and IAM key but not the passphrase (kept in the platform secret store).
- **Partial log capture.** A logger that prints `process.env` minus a denylist may catch one variable; a logger that prints `/etc/myapp/env` may capture the other. Splitting reduces the chance one log dump has both.
- **Operator error inside one system.** Someone pastes `VSYNC_CONFIG` into a Slack channel; the passphrase lives elsewhere.

### Does NOT protect against (the process is its own attack surface)

- **Full process compromise.** Anything that can read `/proc/<pid>/environ` has both halves. Anything that can attach `gdb` to the process has the decrypted vault.
- **CI log dumps that print all env vars** (`env`, `printenv`, `set -x` near a curl). If the runner logs both, both are gone.
- **Sentry / Datadog / Honeycomb auto-capturing `process.env` on a crash.** Same channel.
- **A malicious or compromised dependency inside the application.** The library hands plaintext to the caller; the dependency runs in the same process.
- **Backups that copy the host filesystem (`/run/secrets/...`) and the platform secret-store dump together.** Both halves on one backup tape = no split.

### Explicit anti-claims

- This is **not MFA.** A second factor would be something the operator presents at boot (hardware token), not a second env var that lives next to the first.
- This is **not end-to-end encryption from the operator to the application.** The passphrase is in the platform secret store; the platform admin can read it.
- "Defense in depth" describes this accurately. "Zero trust" does not.

Document this section in your runbook. The worst failure mode is an operator who believes the wrong story.

## Crypto baseline

- **AES-256-GCM** with 12-byte random IV per encryption.
- **PBKDF2-SHA256, 600,000 iterations** for key derivation (matches OWASP 2023). Used in three places:
  - CLI-side bundle encryption: `(keychain key bytes, salt string utf-8)` → AES-256 key.
  - Runtime-lib bundle decryption: `(VSYNC_PASSPHRASE utf-8, salt string utf-8)` → AES-256 key.
  - Share-file wrapper: `(user passphrase utf-8, 16-byte salt)` → AES-256 key.
- **Magic prefixes** — `RQE1`, `RQEM0001`, `SLS1`, `vsync-cfg-v1:`. See [Crypto envelopes](/architecture/crypto).
- **No KMS dependency.** vsync ships zero cloud-vendor lock-in for key management. The OS keychain is the root of trust on the writer side; the platform secret store is the trust anchor on the reader side.

## What's outside the perimeter

- **Bucket IAM / access logs.** vsync writes to S3 but doesn't manage who can write. You set IAM at the cloud provider. Per-user S3 access keys per teammate is the recommended pattern — gives you bucket-side audit logs separate from vsync's `audit.csv`.
- **External secret stores** (GitHub Actions, GCP Secret Manager, AWS Secrets Manager, Azure Key Vault, HashiCorp Vault). What `vsync sync` writes to each lives under the destination's own IAM / ACL. vsync only fans out; it doesn't poll back.
- **Backup / disaster recovery.** Your S3 bucket's lifecycle policy decides how long old versions stick around. vsync doesn't auto-delete versions.
- **TLS to the bucket.** Set `useSsl: true` in the per-(repo, env) config (default). vsync doesn't pin certs — trusts the system trust store.
- **Application observability hygiene.** The lib redacts the handle in `repr`/`String`/`toJSON`, but it doesn't intercept `console.log(v.get_env("DATABASE_URL"))`. That's the application's job.

## What vsync can't protect against

| Threat | Why no defence | Mitigation (out-of-band) |
|---|---|---|
| A teammate's compromised laptop | Vault contents are plaintext after `pull`. If a laptop is unlocked and stolen, the attacker reads everything in that env's vault folder. | Full-disk encryption — FileVault, LUKS, BitLocker. |
| A teammate going rogue | Anyone with the (repo, env) key can decrypt every past + future version they have access to. | The audit log surfaces unusual activity; rotate keys + upstream secrets on offboarding. |
| Bucket-write tampering of the audit log itself | The CSV is plain UTF-8; anyone with write can edit it. Audit is a transparency aid, not tamper-evident. | Cross-reference with bucket-side server access logs; restrict `PutObject` on `audit.csv` to the owner if needed. |
| Misconfigured `.gitignore` | vsync warns at `init` time and on `vsync use`, but ultimately you control git. | Pre-commit hooks; review what's gitignored. |
| Replay of a stolen `VSYNC_CONFIG`+`VSYNC_PASSPHRASE` pair after rotation | Once an attacker has both halves and pulls the bundle, they have the plaintext. Rotation doesn't reach back into their disk. | Treat as [incident response case 3](/guide/incident-response#case-3-both-halves-leaked) — rotate every upstream secret. |
| Process memory dump | The decrypted vault is in heap memory after `open()`. Anything that can dump RAM has it. | OS-level memory protection; kernel hardening. Out of scope for a userspace library. |

## Offboarding

There's no per-user revoke. When someone leaves:

1. **Revoke their bucket access** at the cloud provider (separate axis — IAM / API key delete).
2. **Rotate the passphrase** — [runbook](/guide/rotate-passphrase-runbook). This invalidates the bundle for future pulls from any actor still holding the old passphrase.
3. **Re-`export`** `.share` files for surviving teammates so they re-`import` with the new passphrase.
4. **Rotate the actual upstream secrets** (DB password, API keys, etc.) — the ex-teammate still has whatever they `pull`ed before. vsync can't reach back into their disk. See [incident response case 3](/guide/incident-response#case-3-both-halves-leaked) for the upstream rotation checklist.

Per-user audit (via X25519 recipient list, like `age` / `sops`) is explicitly out of scope for 0.x. See [v0.4 spec §12](/specs/v0.4-audit-log) for the forward-looking design.

## Inspecting / removing the keychain entry

vsync doesn't ship verbs for direct keychain manipulation — use your OS tools:

- **macOS:** Keychain Access.app → search "tools.vsync"
- **Linux:** `secret-tool lookup service tools.vsync account <repo>/<env>`, or GUI via `seahorse`
- **Windows:** Credential Manager → Generic Credentials → "tools.vsync"

To delete: same tools. After delete, the next `vsync push` will fail with "encryption key … not found in keychain" — re-`import` the `.share` to restore.

## Out-of-scope hardening (intentional)

- **No HSM / TPM integration.** The OS keychain (via `Bun.secrets`) is the strongest secret store we can use with no extra deps.
- **No client-side certificate auth to S3.** Standard IAM access-key pairs only.
- **No per-recipient cryptography** (à la `age` / `sops`). Every teammate shares the same `(repo, env)` AES key. Per-recipient X25519 keypairs are parked for v0.5+.
- **No tamper-evident audit log** (no HMAC chain, no signed rows). Needs the recipient model first.
- **No automatic rotation enforcement.** vsync has no concept of "key expiry"; rotation is operator-triggered.
- **No live-reload / refresh in the runtime libs.** [Pull-once semantics](/libraries/#pull-once-semantics-no-refresh-no-daemon). Restart the process to pick up rotated state.
- **No IAM admin verb** (`vsync rotate-iam-key`). IAM rotation is owned externally — see [IAM rotation runbook](/guide/iam-rotation-runbook).

## Forward-looking

For richer security models (per-user X25519 recipient list, tamper-evident audit, key rotation as a first-class verb), see [v0.4 spec §12](/specs/v0.4-audit-log). Deferred to a hypothetical 0.5+ — they need design + implementation work proportional to user demand.

## Where to go next

- [Crypto envelopes →](/architecture/crypto)
- [Audit append protocol →](/architecture/audit-protocol)
- [Storage layout →](/architecture/storage-layout)
- [Repo identity →](/architecture/repo-identity)
- [Incident response →](/guide/incident-response)
