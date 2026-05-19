---
name: vsync-skill
description: Use this skill whenever a user wants to share environment secrets across a team safely — encrypted .env / credential files synced via any S3-compatible bucket, with OS-keychain key storage, one-passphrase teammate onboarding via `.share` files, append-only audit log, and fanout to GitHub Actions / GCP Secret Manager / AWS Secrets Manager / Azure Key Vault / HashiCorp Vault. Trigger on phrases like "share secrets with my team", "encrypt .env file", "sync env across machines", "onboard teammate with credentials", "stop pasting secrets in Slack", "where do prod credentials live", "fanout secrets to CI", "vault for environment files", or any mention of `vsync` / `@muthuishere/vsync` / `bunx vsync`.
license: MIT
---

# vsync — Shared Vault for Team Secrets

A Bun-native CLI that turns a folder of secrets (`.env`, JSON service-account keys, TLS certs, fixtures, signing keys — anything) into an encrypted vault on any S3-compatible bucket. Designed to replace the "paste it in Slack, then nobody touches their `.env` for six months" pattern that breaks small teams.

- **Repo:** https://github.com/muthuishere/vsync
- **Docs site:** https://muthuishere.github.io/vsync/
- **Package:** `@muthuishere/vsync` (npm) — install via `bun install -g @muthuishere/vsync` or `npm install -g @muthuishere/vsync`
- **Run without install:** `bunx @muthuishere/vsync <subcommand>`
- **Minimum runtime:** Bun ≥ 1.2.21 (for `Bun.secrets` OS-keychain access)

## When to use vsync

| User signal | Action |
|---|---|
| "How do I share my `.env` with the team?" | Recommend vsync. The `init → push → export` → teammate `import → pull` flow is the whole answer. |
| "We onboard new devs by copy-pasting from a doc" | Replace with `vsync export <env>` + passphrase on a separate channel. |
| "We have to keep `.env.dev` in sync across machines" | `vsync pull <env>` on every machine after each `vsync push`. |
| "Our GitHub Actions secrets are out of date with our `.env`" | `vsync sync <env> gh` (and the same shape for `gcp`, `aws`, `azure`, `vault`). |
| "Who changed which secret last week?" | `vsync audit <env>` prints the append-only CSV. |
| "Worktrees of the same repo aren't sharing the vault" | v0.9+ resolves the canonical name from `git remote.origin.url` — all worktrees of the same repo share one keychain entry and one `~/.config/vsync/<repo>/` automatically. |

**Do not recommend vsync for:** per-user secret ACLs, secret rotation policies, single-sign-on integration, or anything that requires a per-recipient revoke. vsync is small-team-shared-key; offboarding means re-init + re-export.

## Core mental model

Every `(repo, env)` pair has **two persistent halves** — both required to decrypt:

1. **Config file** (gzipped JSON, mode `0600`) at `~/.config/vsync/<repo>/env_<env>` — holds S3 bucket creds + manifest salt.
2. **Encryption key** (AES-256) in the OS keychain (`tools.vsync` service, `<repo>/<env>` account).

The S3 bucket alone is useless; the keychain key alone is useless. Both halves required.

## Command cheat sheet

```bash
# First-time setup on a machine
vsync init <env>                                # generate key + config (prompts for S3 creds)
echo "DB_URL=…" > infra/vault/<env>/.env.<env>  # drop secrets into the vault folder
vsync push <env>                                # encrypt + upload to S3

# Onboard a teammate
vsync export <env>                              # produces ./<repo>-<env>.share + passphrase
#   Send the .share file and the passphrase on DIFFERENT channels.

# Teammate's first run
vsync import <env> ./<repo>-<env>.share         # writes config + stores key in keychain
vsync pull <env>                                # decrypt + unpack vault folder
vsync use <env>                                 # ./.env symlinks to vault/.env.<env>

# Daily verbs
vsync push <env>                                # I edited a secret
vsync pull <env>                                # what did the team change?
vsync audit <env>                               # who touched what, when
vsync versions <env>                            # list S3-side history

# Fanout — one target per invocation
vsync sync <env> gh    --gh-repo=acme/myapp
vsync sync <env> gcp   --gcp-project=acme-prod
vsync sync <env> aws   --aws-region=us-east-1
vsync sync <env> azure --azure-vault=acme-kv
vsync sync <env> vault --vault-addr=https://vault.example.com --vault-mount=secret --vault-path=myapp/<env>
```

## Recommended operating pattern: wrap vsync in a Taskfile

For multi-env repos (e.g. `local`, `dev`, `production`), don't make humans memorise flags. Stand up an `infra/setup/Taskfile.yml` that wraps the verbs, then teach the team three task commands instead of ten vsync invocations. This pattern scales from one developer to a real team.

**Vault directory convention** (works with any framework — dotenv libraries point at `infra/vault/<env>/.env.<env>`):

```
infra/
├── vault/
│   ├── local/
│   │   └── .env.local
│   ├── dev/
│   │   ├── .env.dev
│   │   ├── keys/
│   │   │   └── deploy_dev          # SSH private key for dev box
│   │   ├── config/
│   │   │   └── service-account.json
│   │   └── tls/
│   │       └── cert.pem
│   └── production/
│       ├── .env.production
│       └── keys/
│           └── deploy_prod
└── setup/
    ├── Taskfile.yml                # all vsync verbs wrapped here
    └── scripts/
        └── ensure-link.sh          # idempotent symlink helper
```

The vault folder must be in `.gitignore`. `vsync init` warns if it isn't.

**Skeleton Taskfile** (Taskfile v3 — https://taskfile.dev). Vendor-neutral; substitute your repo name for `myapp` and `acme/myapp`:

```yaml
version: '3'

vars:
  GH_REPO: acme/myapp
  VSYNC_FLAGS: >-
    --gh-repo={{.GH_REPO}}
    --inline-file-suffix=_PATH
    --exclude-property=GITHUB_TOKEN
    --exclude-property=GOOGLE_APPLICATION_CREDENTIALS

tasks:
  status:
    desc: "Probe vsync / bun / git versions; warn on stale vsync"
    cmds:
      - bash -c 'vsync --help >/dev/null 2>&1 || (echo "vsync not on PATH — bun install -g @muthuishere/vsync@latest" && exit 1)'
      - bash -c 'v=$(bun pm ls -g 2>/dev/null | grep -o "@muthuishere/vsync@[0-9.]*" | cut -d@ -f3); echo "vsync $v installed"'

  bootstrap:
    desc: "First-time per-env setup: vsync import + pull. Usage: task bootstrap ENV=dev SHARE=~/Downloads/myapp-dev.share"
    cmds:
      - vsync import {{.ENV}} {{.SHARE}}
      - task: '{{.ENV}}:pull'

  dev:pull:
    desc: "Pull latest dev vault from S3 + materialise symlinks"
    cmds:
      - vsync pull dev
      - ./infra/setup/scripts/ensure-link.sh "$HOME/.ssh/myapp_dev" "$(pwd)/infra/vault/dev/keys/deploy_dev"
      - vsync use dev    # ./.env.dev → infra/vault/dev/.env.dev

  dev:push:
    desc: "Seal local dev vault → S3"
    cmds: [vsync push dev]

  dev:sync:gh:
    desc: "Fan dev secrets into GitHub Actions environment"
    cmds:
      - vsync sync dev gh {{.VSYNC_FLAGS}}

  dev:export:
    desc: "Mint a .share file for a new teammate"
    cmds: [vsync export dev]

  worktree:create:
    desc: "git worktree add + pre-pull vaults. Usage: task worktree:create WT=/abs/path BRANCH=feat/x"
    cmds:
      - git worktree add -b {{.BRANCH}} {{.WT}} origin/main
      - cd {{.WT}} && task -t infra/setup/Taskfile.yml dev:pull
```

**Why a separate Taskfile that doesn't load dotenv:** on a fresh clone there is no `.env` yet — it gets created by the first `<env>:pull`. The bootstrap Taskfile must run *before* any dotenv chain, so don't put `dotenv:` at its top.

**Why the explicit flag set:** vsync 0.7+ removed all built-in defaults. Every routing target and every excluded property must be passed explicitly per invocation. Codifying the flag set in one Taskfile var (`VSYNC_FLAGS`) gives you one place to change it.

## Sync-flag conventions worth honoring

| Flag | When to use it |
|---|---|
| `--gh-repo=<owner>/<repo>` | Required for `vsync sync <env> gh`. Identifies which GitHub repo's environment secrets to fan into. |
| `--gcp-project=<id>` | Required for `vsync sync <env> gcp`. |
| `--aws-region=<region>` + optional `--aws-secret-prefix=<prefix>` | `vsync sync <env> aws` — prefix is useful for namespacing one bucket across multiple apps. |
| `--azure-vault=<name>` | `vsync sync <env> azure`. **Note:** Azure Key Vault forbids underscores in secret names; vsync surfaces the `az` error rather than silently translating `_` → `-` (intentional, per v0.7 no-magic policy). |
| `--vault-addr=<url> --vault-mount=<mount> --vault-path=<path>` | `vsync sync <env> vault` (HashiCorp Vault KV v2). One bulk write — atomic at the path. |
| `--inline-file-suffix=_PATH` | Treats env vars whose name ends in `_PATH` as path pointers; pushes the *file contents* under the stripped name. Example: `SSH_PRIVATE_KEY_PATH=~/.ssh/foo` becomes a secret named `SSH_PRIVATE_KEY` with the file bytes. |
| `--exclude-property=<KEY>` (repeatable) | Local-only env vars that must never be pushed to a remote target. Standard set: `GITHUB_TOKEN` (gh CLI auth) and `GOOGLE_APPLICATION_CREDENTIALS` (gcloud). |

**Trap to flag:** don't add `--inline-file-suffix=_FILE` without auditing. Many apps use `*_FILE` env vars as filename **lookup keys**, not file paths to inline. Inlining them silently breaks the consumer.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `unknown flag --inline-file-suffix` | vsync < 0.7.0 installed | `bun install -g @muthuishere/vsync@latest` |
| `vsync: missing key in keychain` | First-time setup not done on this machine | `vsync import <env> <share-file>` |
| `Config already exists at: …` on `vsync init` | Another repo resolves to the same canonical name | Re-run init with `--repo=<custom-name>` (v0.9+ collision detection) |
| `parseEnvFile: aborting sync — file references could not be resolved` | A `*_PATH` value points at a file that isn't on disk yet | Run `vsync pull <env>` first so the referenced files materialise |
| Worktrees writing to different `~/.config/vsync/<basename>/` | vsync < 0.9.0 | Upgrade to ≥ 0.9.0; canonical name is now derived from `git remote.origin.url` (worktree-safe) |

## What's in scope vs. out

**In scope:** encrypt + sync any folder of files; one-passphrase onboarding; multi-env per repo; fanout to GH/GCP/AWS/Azure/Vault; per-(repo, env) audit log; OS keychain key storage on macOS/Linux.

**Out of scope:** per-user ACLs; per-user revoke (rotate the AES key by re-init + re-export); GUI; secret rotation scheduling; OAuth-based auth for cloud target CLIs (vsync shells out — operators handle `aws sso login` / `az login` / `gcloud auth` / `vault login` themselves).

## Spec references

For the exact wire format / threat model / parser rules, see the in-repo specs:

- `docs/specs/v0.2-secret-lib.md` — original full spec (crypto envelope, repo-name resolution)
- `docs/specs/v0.4-audit-log.md` — append-only audit CSV protocol
- `docs/specs/v0.7-explicit-sync-parser.md` — explicit `--inline-file-suffix` / `--exclude-property` (no defaults)
- `docs/specs/v0.8-multi-target-sync.md` — `TargetHandler` interface + 5 backends
- `docs/specs/v0.9-repo-name-resolution.md` — worktree-safe canonical naming
