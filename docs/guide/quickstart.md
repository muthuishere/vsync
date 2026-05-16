# Quickstart

Get from "I have a `.env` file on my laptop" to "the whole team shares an encrypted, audited vault" in five minutes.

## 1. Install

```bash
bun install -g @muthuishere/vsync     # or:  npm install -g @muthuishere/vsync
vsync --help
```

Requires Bun ≥ 1.2.21 on PATH (the shebang is `#!/usr/bin/env bun`, so `bun` must exist even if you installed via npm). See [Install](/guide/install) for platform notes.

## 2. Create your first environment

```bash
cd my-project
vsync init dev
```

You'll be prompted for S3 credentials (bucket, endpoint, region, access key, secret key). vsync writes:

- A per-(repo, env) config at `~/.config/vsync/<repo>/env_dev` (gzipped JSON, `chmod 0600`).
- A fresh AES-256 key in your OS keychain (service `tools.vsync`, account `<repo>/dev`).
- A vault folder at `infra/vault/dev/` (override with `--vault-folder=<path>` for monorepos).
- A `~/.config/vsync/defaults` template — pre-fills prompts on later `init` runs so you don't re-type S3 creds.

If you already had a root `.env.dev` file, vsync offers to relocate it into the vault folder.

## 3. Put secrets into the vault

```bash
cat > infra/vault/dev/.env.dev <<'EOF'
DATABASE_URL=postgres://user:pass@host/db
API_KEY=sk-...
EOF

# Anything else that's secret — JSON keys, certs, fixtures — drop in too.
cp ~/Downloads/gcp-sa.json infra/vault/dev/
```

See [What lives in the vault](/guide/vault) for the full picture.

## 4. Push to S3

```bash
vsync push dev
```

vsync zips the vault folder, seals it with AES-256-GCM + a manifest pointer (anti-rollback), and uploads to `s3://<bucket>/<repo>/dev/versions/<ts>.enc`. Then it updates `s3://<bucket>/<repo>/dev/latest` to point at the new version.

## 5. Share with your team

```bash
vsync export dev
```

Output: `./<repo>-dev.share` (a passphrase-encrypted bundle of the config + AES key) + a generated passphrase printed to your terminal.

**Send the `.share` file and the passphrase on two different channels** — file via Slack DM, passphrase via SMS or your password manager's secure share. An interceptor of one cannot decrypt the other.

## 6. Teammate joins

On the teammate's machine:

```bash
cd cloned-repo
vsync import dev ./<repo>-dev.share     # paste the passphrase when prompted
vsync pull dev                          # decrypt + unpack into infra/vault/dev/
vsync use dev                           # ./.env → infra/vault/dev/.env.dev
```

Done. Their `dotenv.config()` reads from `./.env`, which points at the vault. See [Onboarding teammates](/guide/share) for the full flow.

## 7. Daily rhythm

```bash
vsync pull dev                          # pull the latest before starting work
# … edit infra/vault/dev/ …
vsync push dev                          # ship your changes

vsync sync dev gh                       # push KVs to GitHub Actions secrets
vsync sync dev gcp                      # … or GCP Secret Manager
vsync sync dev all                      # both

vsync audit dev                         # who pushed/pulled/exported, when
```

See [Push / pull / versions](/guide/daily), [Fanout to GitHub / GCP](/guide/sync), and [Audit log](/guide/audit) for details.

---

[Next: Install →](/guide/install)
