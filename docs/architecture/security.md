# Security model

| Threat | Defence |
|---|---|
| Attacker reads disk config only | Gets bucket creds + routing. **Cannot decrypt** any S3 bundle. |
| Attacker reads keychain only | Gets the AES key. **No bucket location**. No reach. |
| Attacker reads both | Compromises this (repo, env). **Rotate immediately.** |
| Attacker intercepts a `.share` file | Cannot decrypt without the passphrase. Mitigation: send file + passphrase on different channels. |
| Attacker tampers with an S3 bundle byte | AES-GCM auth tag rejects it on pull. |
| Attacker swaps `latest` to point at an old bundle | Manifest pointer-seal (`RQEM0001`) catches it — `embedded_ts ≠ remote_ts` → refuse + report. |
| Local user on shared machine | `chmod 0600` on disk file + `0700` on dir = POSIX denies other users. macOS Keychain ACLs deny other login sessions. Windows: `%APPDATA%` user scope. |

## Crypto

- **AES-256-GCM** with 12-byte random IV per encryption.
- **PBKDF2-SHA256, 600,000 iterations** for key derivation (keychain-key + per-repo salt → AES-GCM key, and passphrase + share-file salt → AES-GCM key).
- **Magic prefixes** — `RQE1`, `RQEM0001`, `SLS1`. See [Crypto envelopes](/architecture/crypto).
- **No KMS dependency.** vsync ships zero cloud-vendor lock-in for key management. The OS keychain is the root of trust.

## What's outside the perimeter

- **Bucket IAM / access logs.** vsync writes to S3 but doesn't manage who can write. You set IAM at the cloud provider. Per-user S3 access keys per teammate is the recommended pattern — gives you bucket-side audit logs (separate from vsync's `audit.csv`).
- **GitHub / GCP secret stores.** What `vsync sync` writes to those lives under their IAM. vsync only fans out; it doesn't poll back.
- **Backup / disaster recovery.** Your S3 bucket's lifecycle policy decides how long old versions stick around. vsync doesn't auto-delete versions.
- **TLS to the bucket.** Set `useSsl: true` in the per-(repo, env) config (default). vsync doesn't pin certs — trusts the system trust store.

## Offboarding

There's no per-user revoke. When someone leaves:

1. **Revoke their bucket access** at the cloud provider (separate axis — IAM / API key delete).
2. **Re-init** the (repo, env) — `vsync init <env>` overwrites the keychain entry with a new key. Push fresh content.
3. **Re-export** `.share` files for surviving teammates so they re-import the new key.
4. **Rotate the actual secrets** in their upstream systems — the ex-teammate still has whatever they `pull`ed before. vsync can't reach back into their disk.

Per-user audit and a built-in `rotate-key` verb are explicitly out of scope for 0.x.

## What vsync can't protect against

- **A teammate's compromised laptop.** Vault contents are plaintext after `pull`. If a laptop is unlocked and stolen, the attacker reads everything in that env's vault folder. (Mitigation: full-disk encryption — FileVault, LUKS, BitLocker.)
- **A teammate going rogue.** Anyone with the (repo, env) key can decrypt every past + future version they have access to. The audit log surfaces unusual activity but doesn't prevent it.
- **Bucket-write tampering of the audit log itself.** The CSV is plain UTF-8; anyone with write can edit it. Audit is a transparency aid, not tamper-evident.
- **Misconfigured `.gitignore`.** vsync warns at `init` time and on `vsync use`, but ultimately you control git. Committing `infra/vault/` or `./.env` defeats every defence above.

## Inspecting / removing the keychain entry

vsync doesn't ship verbs for this — use your OS tools:

- **macOS:** Keychain Access.app → search "tools.vsync"
- **Linux:** `secret-tool lookup service tools.vsync account <repo>/<env>`, or GUI via `seahorse`
- **Windows:** Credential Manager → Generic Credentials → "tools.vsync"

To delete: same tools. After delete, the next `vsync push` will fail with "encryption key … not found in keychain" — re-`import` the `.share` to restore.

## Forward-looking

For richer security models (per-user X25519 recipient list, tamper-evident audit, key rotation as a first-class verb), see [v0.4 spec §12](/specs/v0.4-audit-log). Deferred to a hypothetical 0.5+ — they need design + implementation work proportional to user demand.

---

[All specs →](/specs/v0.4-audit-log)
