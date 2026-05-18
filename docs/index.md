---
layout: home

hero:
  name: Vsync
  text: Secrets your team actually shares.
  tagline: One encrypted vault for your environment secrets — shared across your team, mirrored to GH / GCP / AWS / Azure / Vault, audited every time someone touches it.
  actions:
    - theme: brand
      text: Get started
      link: /guide/quickstart
    - theme: alt
      text: How it works
      link: /architecture/mental-model
    - theme: alt
      text: GitHub
      link: https://github.com/muthuishere/vsync

features:
  - icon: 🔐
    title: Encrypted at rest, sealed in transit
    details: AES-256-GCM bundles on any S3-compatible bucket (AWS, Hetzner, MinIO, R2, B2). Per-machine AES key in the OS keychain. The bucket alone is useless; the key alone is useless. Both halves required.
  - icon: 📁
    title: Your whole vault, not just `.env`
    details: Drop anything secret into `infra/vault/<env>/` — env files, JSON service-account keys, TLS certs, regression fixtures, signing keys. The folder ships whole.
  - icon: 🔁
    title: One-passphrase onboarding
    details: '`vsync export <env>` mints a `.share` file. Send it on one channel, the passphrase on another. Teammate imports + pulls — they''re live in 30 seconds.'
  - icon: ↗️
    title: Fanout to where prod runs
    details: '`vsync sync <env> <gh|gcp|aws|azure|vault>` pushes the same `.env.<env>` keys to any of five backends — GitHub Actions, GCP Secret Manager, AWS Secrets Manager, Azure Key Vault, or HashiCorp Vault KV v2. One edit in the vault; every target stays in step.'
  - icon: 📜
    title: Append-only audit log
    details: Every push / pull / import / export records `who, where, when, version, free-form note` to a CSV on the bucket. `vsync audit <env>` prints it. CI tags rows with `--note="run #1234"`.
  - icon: 🔗
    title: Just `dotenv.config()` — no path arg
    details: '`vsync use <env>` symlinks `./.env` at the vault''s env file. Apps just work. Switch envs with one command; restart the dev server.'
---

<div class="vsync-flow-wrap">

![How vsync flows — owner vault → push → S3/MinIO with audit.csv → pull → teammate vault, with `vsync use` linking ./.env and `vsync sync` fanning out to gh / gcp / aws / azure / vault.](/vsync-flow.png)

</div>

## Install

```bash
bun install -g @muthuishere/vsync     # or:  npm install -g @muthuishere/vsync
vsync --help
```

Requires Bun ≥ 1.2.21 on PATH (for `Bun.secrets`). Don't want to install? `bunx @muthuishere/vsync <subcommand>` works too.

## The two-minute version

```bash
vsync init dev                              # generate per-(repo, env) key + config
echo "DB_URL=postgres://…" > infra/vault/dev/.env.dev
vsync push dev                              # encrypt + upload to S3

vsync export dev                            # → ./<repo>-dev.share + passphrase
# Hand the file + passphrase to teammate on different channels.

# Teammate:
vsync import dev ./<repo>-dev.share         # config + key into keychain
vsync pull dev                              # decrypt + unpack vault folder
vsync use dev                               # ./.env → infra/vault/dev/.env.dev

# Daily:
vsync push dev                              # I edited a secret
vsync pull dev                              # what did the team change?
vsync sync dev gh                           # push .env.dev keys to GitHub Actions
vsync audit dev                             # who touched what, when
```

[Full quickstart →](/guide/quickstart) · [Architecture →](/architecture/mental-model)
