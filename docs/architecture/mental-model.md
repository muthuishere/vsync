# Mental model

Every (repo, env) is held by **two persistent halves**. Both required to push or pull; either one alone is useless.

```
┌──────────────────────────────────────────────────────────────────┐
│ Disk (chmod 0600)                                                │
│  ~/.config/vsync/<repo>/env_<env>        self-contained config   │
│    ├── s3.{endpoint, region, bucket, …}    where to find bytes   │
│    ├── encryption.salt                     PBKDF2 input          │
│    ├── files.vaultFolder                   optional override     │
│    ├── sync.{gh.repo, gcp.project}         set by `vsync sync`   │
│    └── audit.enabled                       default true          │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ OS keychain (Bun.secrets)                                        │
│  service: tools.vsync                                            │
│  account: <repo>/<env>                                           │
│  value:   <base64 32-byte AES-256 key>                           │
└──────────────────────────────────────────────────────────────────┘
```

## Why two halves

| Attacker has | Result |
|---|---|
| Disk config only | Knows the bucket. Cannot decrypt any S3 bundle — bundles are sealed with the AES key, not derivable from the file. |
| Keychain key only | Can decrypt any bundle they encounter. Doesn't know which bucket. |
| **Both** | Can read every version in the (repo, env). **Rotate immediately.** |
| Neither | The norm. |

The split is the security boundary. A breach of one half on its own doesn't expose secrets — the attacker has to compromise two different storage systems (disk + OS keychain) to win.

## What `.share` does

A `.share` file bundles **both halves** under one passphrase. Sent on a channel separate from the passphrase, it's the smallest possible onboarding step.

If an attacker intercepts the `.share` file but not the passphrase, they have a passphrase-encrypted blob and no way in. If they intercept the passphrase, they have a 4-word phrase with no idea what to do with it. They need both, on two channels.

## What's NOT in the two halves

- **The bundle itself.** Lives on S3 alone. Anyone with bucket read can fetch it; without the key, it's `RQE1` magic + nonce + ciphertext, which is white noise.
- **The vault files in plaintext.** Live on each teammate's local disk after `pull` — under `infra/vault/<env>/`. That's not encrypted at rest beyond filesystem permissions. If a teammate's laptop is unlocked, their vault contents are readable.
- **External secret stores** (GitHub Actions, GCP Secret Manager, AWS Secrets Manager, Azure Key Vault, HashiCorp Vault). What `vsync sync` writes to each is governed by the destination's own IAM / ACL. Outside vsync's perimeter.

## Why `~/.config/vsync/` is per-user

The disk config lives in `${XDG_CONFIG_HOME:-~/.config}/vsync/<repo>/env_<env>`. Mode `0600`. The keychain entry is also user-scoped. **Multi-user machines** — every user gets their own halves; you'd have to import to each user account separately.

This is intentional. A shared "machine-wide" install would mean any user on the box can decrypt — which defeats the OS-keychain split.

## Recovering when a half is lost

| Lost | Recovery |
|---|---|
| Disk config (someone `rm -rf ~/.config/vsync/`) | Re-`import` the `.share` (rewrites both halves) — or re-`init` from scratch and re-`push`. |
| Keychain key (Keychain Access wipe) | Same — re-`import` from the `.share`. |
| Both | Same — `.share` is the universal recovery artefact. |
| `.share` AND keychain AND nobody else has the (repo, env) | Hard loss. The S3 bundles are unrecoverable. **Always keep a `.share` somewhere offline.** |

## Why no per-user ACL

vsync targets **small teams** where everyone trusts everyone in the org. There is no per-user audit, no granular access control. Anyone with the (repo, env) keychain key can decrypt every version that ever existed. Offboarding = revoke bucket access + re-`init` for survivors.

For per-recipient cryptography (à la `age` / `sops`), see [v0.4 spec §12](/specs/v0.4-audit-log) — explicitly out of scope for 0.x.

---

[Next: Crypto envelopes →](/architecture/crypto)
