---
name: vsync-skill
---

# Commands — every verb vsync ships

Each verb runs as `vsync <verb> <env> [flags]`. There is no `--version` flag and no built-in REPL; everything is single-shot CLI. Wire format is stable across 0.8.x ↔ 0.9.x — no migration required.

## First-time setup

| Verb | What it does | Notes |
|---|---|---|
| `vsync init <env>` | Generate AES-256 key (stored in OS keychain) + write per-(repo, env) config file. Prompts for S3 creds; pre-fills from `~/.config/vsync/defaults` after the first init. | v0.9+ aborts if a config already exists at the resolved path — recovery is `--repo=<custom-name>`. |
| `vsync push <env>` | Gzip + AES-256-GCM the whole `infra/vault/<env>/` folder + manifest-seal + upload to S3 + append audit row. | Reads from the folder configured at init (default `infra/vault/<env>/`). |
| `vsync export <env>` | Mint a passphrase-protected `.share` file (config + key wrapped in `SLS1` envelope). | Pipe the file and the passphrase to a teammate on **different channels**. |

## Teammate onboarding

| Verb | What it does | Notes |
|---|---|---|
| `vsync import <env> <share-file>` | Validate passphrase → unpack config + key → write config file + insert key into keychain. | Idempotent — re-running overwrites the existing keychain entry (useful after key rotation). |
| `vsync pull <env>` | Download latest sealed bundle from S3 → verify manifest pointer-seal (defeats rollback) → decrypt → unpack into vault folder. | Automatically rolls a backup of any existing vault folder into `~/.config/vsync/backups/`. |
| `vsync use <env>` | Symlink `./.env` (or your configured target) into the vault's `.env.<env>`. | App code reads from `./.env` as if nothing changed. |

## Daily verbs

| Verb | What it does |
|---|---|
| `vsync push <env>` | I edited a secret — seal + upload. |
| `vsync pull <env>` | What did the team change? — fetch + verify + unpack. |
| `vsync audit <env>` | Print the append-only CSV (`who, where, when, version, note`). |
| `vsync versions <env>` | List S3-side history (timestamp-named `.enc` files under `<repo>/<env>/versions/`). |

## Fanout — one target per invocation

```
vsync sync <env> gh    --gh-repo=acme/myapp [...]
vsync sync <env> gcp   --gcp-project=acme-prod [...]
vsync sync <env> aws   --aws-region=us-east-1 [--aws-secret-prefix=myapp/]
vsync sync <env> azure --azure-vault=acme-kv
vsync sync <env> vault --vault-addr=https://vault.example.com --vault-mount=secret --vault-path=myapp/<env>
```

vsync shells out to each backend's official CLI (`gh`, `gcloud`, `aws`, `az`, `vault`). Operators must already be authenticated to that backend (`gh auth login`, `aws sso login`, etc.) — vsync does not store cloud-provider credentials.

See `references/sync-flags.md` for the v0.7+ explicit-flag conventions every `sync` invocation needs.

## Flag overrides accepted by every verb

| Flag | Purpose |
|---|---|
| `--repo=<name>` | Override the auto-detected repo namespace (highest precedence). Use when the canonical name v0.9 resolves doesn't suit. |
| `$SECRETS_SYNC_REPO` (env var) | Same as `--repo=`, second-highest precedence. Stable across shells in the same session. |
| `--interactive` | Force prompts even when flags fully specify the input — useful for `init` when you want to review each value. |

## What vsync does NOT have

These are intentionally missing — surface them upfront when a user asks:

- `vsync --version` — no version flag. Inspect with `bun pm ls -g | grep vsync` (bun-global install) or `npm ls -g @muthuishere/vsync`.
- `vsync doctor`, `vsync list`, `vsync rotate-key` — were on an earlier roadmap; not implemented. If a user asks for them, surface that and discuss scope.
- `--force` on `init` to overwrite an existing config — v0.9 collision detection is hard. Recovery is `--repo=<custom-name>` or manual delete.
- Per-user revoke. Rotation = re-init + re-export to everyone but the leaving user.
- A GUI / web dashboard.
