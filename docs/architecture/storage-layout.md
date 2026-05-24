# Storage layout

A complete map of what vsync writes — to the bucket, to your filesystem, to the OS keychain. Useful when you need to understand a state, debug a "where did that go?", or recover after losing a half.

## On S3 — what the bucket holds per (repo, env)

```
s3://<bucket>/<prefix>/
├── manifest               ← pointer object; small (~50 bytes). The current latest.
├── audit.csv              ← single CSV, append-only by convention. Header + N rows.
├── v=20260523-114201      ← versioned bundle objects, one per push. AES-256-GCM ciphertext.
├── v=20260523-091205      ← (older bundles retained — vsync never auto-prunes)
├── v=20260522-184510
└── …
```

`<prefix>` is what's written to `cfg.prefix` at `vsync init` time. Default shape: `<repo>/<env>/`, but the resolved value depends on:

- Profile `prefix` field (if set, prepended) — e.g. `acme/`
- Env suffix (always appended) — e.g. `prod/`

Result: `acme/prod/`. See [Profiles §prefix](/guide/profiles#profile-prefix-→-env-prefix) for the combination rules.

### Object types

#### `manifest` (pointer object)

```
key:      <prefix>manifest
size:     ~50 bytes
content:  ASCII timestamp string, e.g. "20260523-114201"
metadata: {
   "x-amz-meta-gen": "4",
   "x-amz-meta-prev-gen": "3",
   "x-amz-meta-rotated-at": "2026-05-23T11:42:01.234Z"
}
```

`pull` reads this first to know which `v=<ts>` to fetch. `push` writes a new `v=<ts>` first, then updates this pointer (so observers see a coherent state at all times — either old or new, never half-applied).

The `meta.gen` field is what runtime libs report as `generation()` — a HEAD on `manifest` is enough to read it (no decrypt needed).

#### `v=<ts>` (bundle objects)

```
key:      <prefix>v=<14-char-timestamp>
size:     variable (the encrypted zip of your vault folder)
content:  RQE1 envelope (4-byte magic + 12-byte IV + ciphertext+tag)
            └── decrypts to RQEM0001 envelope (magic + version + 16-byte ts + zip)
                                 └── unzips to your vault files
```

See [Crypto envelopes](/architecture/crypto) for the byte layout.

Bundles are **never auto-deleted.** They accumulate forever. Operators may prune manually via the cloud console / `aws s3 rm` — but be careful, an older bundle is still reachable if you manually edit `manifest` to point at it (and the embedded timestamp matches — anti-rollback still applies).

If bundle accumulation is a problem at scale, configure a bucket lifecycle policy:

```bash
# AWS example — delete bundles older than 90 days
aws s3api put-bucket-lifecycle-configuration --bucket your-bucket \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-old-vsync-bundles",
      "Filter": { "Prefix": "<prefix>v=" },
      "Status": "Enabled",
      "Expiration": { "Days": 90 }
    }]
  }'
```

vsync doesn't manage lifecycle policies; that's bucket-admin territory.

#### `audit.csv` (the audit log)

```
key:      <prefix>audit.csv
size:     grows over time; ~200 bytes per row including the header
content:  UTF-8 CSV (RFC 4180 quoted), append-only by convention
```

See [Audit append protocol](/architecture/audit-protocol) for how concurrent writes are reconciled.

### Object naming detail

The timestamp in `v=<ts>` is the ISO-like compact form (`YYYYMMDD-HHMMSS`), generated at push time on the writer's clock. Microseconds aren't included — two pushes within the same second from different machines would collide. In practice this doesn't happen (push is preceded by a manual edit), but the ETag-conditional retry on the manifest swap (a sibling of the audit log's protocol) makes it self-correcting if it ever did.

## On the writer's filesystem — what vsync init creates

```
~/.config/vsync/                              (mode 0700)
├── profiles/                                 (mode 0700)
│   ├── acme-prod.json                        (mode 0600) — S3 creds + bucket info
│   ├── hetzner-personal.json                 (mode 0600)
│   └── r2-client-a.json                      (mode 0600)
└── config/                                   (mode 0700)
    └── <repo>/                               (mode 0700)
        ├── env_prod                          (mode 0600) — gzipped JSON per (repo, env)
        ├── env_staging                       (mode 0600)
        └── env_dev                           (mode 0600)
```

`$XDG_CONFIG_HOME` is respected if set; otherwise `~/.config`.

### `profiles/<name>.json`

Stores S3 endpoint, region, bucket, optional prefix, IAM access key + secret. **Plaintext on disk** (mode `0600` is the security envelope).

```json
{
  "version": 1,
  "endpoint": "https://s3.eu-central-1.amazonaws.com",
  "region": "eu-central-1",
  "bucket": "acme-secrets",
  "prefix": "myapp/",
  "accessKeyId": "AKIA...",
  "secretAccessKey": "..."
}
```

See [Profiles spec](/specs/v0.13-profiles-init-status#_1-2-schema) for the schema.

Profiles are **per-machine**, not synced. Each teammate creates their own.

### `config/<repo>/env_<env>`

Per-(repo, env) config. **Gzipped JSON** for compactness; not a security boundary (the AES key isn't here).

```json
{
  "version": 1,
  "s3": {
    "endpoint": "https://s3.eu-central-1.amazonaws.com",
    "region": "eu-central-1",
    "bucket": "acme-secrets",
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
    "useSsl": true
  },
  "encryption": {
    "salt": "Yk4tF6QzN8x5Ld3PpRsXvWzC"
  },
  "files": {
    "vaultFolder": "infra/vault/prod"
  },
  "sync": {
    "gh": { "repo": "acme/web" },
    "gcp": { "project": "acme-prod-123" }
  },
  "audit": { "enabled": true },
  "initProfile": "acme-prod",
  "prefix": "myapp/prod/",
  "lastPush": {
    "ts": "20260523-114201",
    "gen": 4
  }
}
```

Inspect (decompress) it:

```bash
gunzip -c ~/.config/vsync/<repo>/env_prod | jq .
```

Don't edit by hand. `vsync init <env> --interactive` re-prompts everything with current values as defaults — that's the supported edit path.

### Why profiles and per-env configs are separate

Profiles change rarely (when IAM keys rotate). Per-env configs change every push (the `lastPush` field). Splitting them means profile edits don't churn the per-env state, and per-env churn doesn't expose IAM creds repeatedly in backups.

## In the OS keychain

```
service: tools.vsync
account: <repo>/<env>          (e.g. "myapp/prod")
value:   <base64 32-byte AES-256 key>
```

Inspect/manage via OS tooling:

- **macOS:** Keychain Access.app → search "tools.vsync"
- **Linux:** `secret-tool lookup service tools.vsync account <repo>/<env>` (libsecret), or GUI via `seahorse`
- **Windows:** Credential Manager → Generic Credentials → "tools.vsync"

The keychain entry is the **load-bearing** half of the security split. Without it, the disk config alone can fetch encrypted bundles from S3 but cannot decrypt them.

## In the repo (per project)

```
my-project/
├── infra/
│   └── vault/                                       (gitignored)
│       ├── prod/
│       │   ├── .env.prod                            (your secret KVs)
│       │   ├── gcp-sa.json                          (any binary files)
│       │   └── tls/server.crt
│       ├── staging/
│       └── dev/
├── .env                                             (symlink → infra/vault/<env>/.env.<env>)
└── .gitignore                                       (excludes infra/vault/, .env)
```

Created by `vsync init` (the `infra/vault/<env>/` dirs) and `vsync use` (the `./.env` symlink).

The vault folder location is configurable: `vsync init --vault-folder=secrets/<env>`. The resolved path is persisted in `cfg.files.vaultFolder` so `push`/`pull`/`use` know where to look.

**Everything in `infra/vault/<env>/` is the plaintext truth** — what gets zipped, encrypted, and shipped to S3. The CLI never silently transforms contents; what you put in is what comes out.

## Backup directories

```
~/.config/vsync/backups/
└── <env>-<ts>.zip.enc
```

When `pull` would overwrite existing vault contents, the existing state is rolled up + encrypted + stored here first. Recovery via `vsync restore-backup <env> <backup> <target-dir>`.

(Note: as of writing, the backup path uses `<env>-<ts>` rather than `<repo>-<env>-<ts>` — minor bug; multi-repo users may overwrite their backups across projects. Track in [repo-identity §where it's used](/architecture/repo-identity#where-it-s-used).)

## On the runtime app — what the lib reads (nothing else)

```
Process environment:
  VSYNC_CONFIG       = "vsync-cfg-v1:..."     OR  VSYNC_CONFIG_FILE     = "/etc/vsync/config"
  VSYNC_PASSPHRASE   = "..."                  OR  VSYNC_PASSPHRASE_FILE = "/etc/vsync/passphrase"

In memory after open():
  bundle:        in-memory map { env-key → string-value } + { asset-name → bytes }
  generation:    int (from manifest meta.gen, captured at open())
  defaults:      passed-in fallback dict
```

The runtime lib writes **nothing** to S3 (no audit row from the lib side; that's CLI-only). It writes nothing to disk by default. The only on-disk artifact is what **you** materialize from `get_as_content(name)` (see the materialization recipe in each [per-language page](/libraries/)).

## State recovery cheat sheet

| Lost | Where it lives | Recovery |
|---|---|---|
| Profile (`~/.config/vsync/profiles/<name>.json`) | per-machine plaintext | Re-create with `vsync profile add <name>`. Or copy from a teammate's machine (it's plaintext). |
| Per-env config (`~/.config/vsync/<repo>/env_<env>`) | per-machine | Re-`vsync import` the `.share` for the env, OR re-`vsync init` (loses the existing key — needs team coord). |
| Keychain key | OS keychain | Re-`vsync import` the `.share`. |
| `.share` file | local disk (or password manager if you stored it) | Owner re-runs `vsync export <env>`. |
| `manifest` on S3 | bucket | Re-`vsync push` from any teammate with the disk config + keychain key. |
| A `v=<ts>` bundle | bucket | Older versions are still there if the bucket has versioning enabled; otherwise gone. Newer is fine — push again. |
| `audit.csv` | bucket | Lost rows are gone; new appends restart from the next event. Bucket versioning can recover old states. |
| **All halves gone simultaneously, nobody on the team has them either** | nowhere | The S3 bundles are unreadable. Restart the env from scratch — re-`init`, re-`push` plaintext. |

The takeaway: **the `.share` file is the universal recovery artifact.** Always keep one — in a password manager, in an offline backup, somewhere safe. If you lose both halves on every machine, the `.share` is your only way back.

## Where to go next

- [Crypto envelopes →](/architecture/crypto)
- [Audit append protocol →](/architecture/audit-protocol)
- [Repo identity →](/architecture/repo-identity)
- [Security model →](/architecture/security)
