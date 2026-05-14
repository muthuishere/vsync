# Onboarding — setting up a new project

You're the first person on the project. You'll create the (repo, env) config, generate an encryption key, push your first bundle to S3, and hand the team a share file.

## Prerequisites

- [Bun](https://bun.sh) 1.2.21+ (for `Bun.secrets`)
- An S3-compatible bucket: AWS S3, Backblaze B2, Cloudflare R2, MinIO, etc. — any service that speaks the S3 API. Note the endpoint, region, bucket name, and a key/secret pair scoped to that bucket.
- Optional: `task` (go-task) if you want the `infra/setup/Taskfile.yml` shortcuts.

## 1. Scaffold the repo layout

In an empty (or existing) repo:

```bash
bunx @muthuishere/secret-lib initapp
```

This generates:

```
.env / .env.dev / .env.production    # gitignored stubs
.env.sample                          # committed shape
infra/vault/{local,dev,production}/.gitkeep
infra/setup/Taskfile.yml             # per-env shortcuts
.gitignore                           # additions appended if missing
```

Edit the stubs with real values. The whole point of the tool is to share these via S3 — you put real secrets in them locally, push, and your team pulls.

Pass `--envs=dev,production` to skip the prompt, `--force` to overwrite existing files, `--no-taskfile` to skip the Taskfile generation.

## 2. Initialize a (repo, env) — generates the AES key

```bash
bunx @muthuishere/secret-lib init dev
```

Prompts for (or accepts via flags):

- S3 endpoint, region, bucket, access key ID, secret access key
- Env file path (default `.env.dev`)
- Vault folder path (default `infra/vault/dev`)

Flag-driven equivalent for scripting:

```bash
bunx @muthuishere/secret-lib init dev \
  --endpoint=https://hel1.your-objectstorage.com \
  --region=hel1 \
  --bucket=my-secrets-bucket \
  --access-key=AKIAxxxxxxx \
  --secret-key=xxxxxxxxxxxxxxxx \
  --env-file=.env.dev \
  --vault-folder=infra/vault/dev
```

At the end you'll see:

```
✅ Setup complete
  config file: /Users/you/.config/deemwar/config/<repo>/env_dev  (0600)
  key:         OS keychain (service=com.deemwar.secret-lib, account=<repo>/dev)
```

The key is now in your OS keychain. Never printed unless you ask (`show-key`).

## 3. Push your first bundle

```bash
bunx @muthuishere/secret-lib push dev
```

What happens:

1. Zips the configured env file + vault folder
2. Seals the zip in a manifest with a timestamp
3. AES-256-GCM encrypts with the key (derived from your keychain key + the salt in the config file)
4. Uploads to `s3://<bucket>/dev/versions/<ts>.enc`
5. Updates the `s3://<bucket>/dev/latest` pointer to that timestamp

Teammates run `pull` to fetch the latest. The manifest pointer prevents anyone with bucket-write but no key from silently rolling back the bundle.

## 4. Share with the team

```bash
bunx @muthuishere/secret-lib export dev
```

This produces:

- `./<repo>-dev.share` — a passphrase-encrypted file containing config + key + metadata
- A printed passphrase (e.g. `xK4p-pNm9-Qr2t`)

**Send these on different channels.** File via Slack DM, passphrase via SMS. Or 1Password attachment + 1Password field. Whatever you trust.

Teammates run:

```bash
bunx @muthuishere/secret-lib import dev <repo>-dev.share
```

(They'll be prompted for the passphrase.) After that, `bunx @muthuishere/secret-lib pull dev` works on their machine.

## 5. Daily flow

```bash
# You edited .env.dev locally:
task -t infra/setup/Taskfile.yml dev:push

# A teammate updated something — get the latest:
task -t infra/setup/Taskfile.yml dev:pull
```

That's it.

## Operational notes

- **Local backups** of `.env` + vault are made automatically before every `pull` and stored encrypted at `~/.config/localdevconfig/<env>-<ts>.zip.enc`. Two-deep rolling buffer. Restore with `secret-lib restore-backup <env> <backup> <target-dir>`.
- **Rotation:** to rotate the encryption key, the easiest path today is `delete-key` + `init` (generates fresh) + `push`. A `rotate-key` command that re-encrypts existing S3 versions is on the roadmap.
- **Multi-machine:** the keychain entry is per-machine. To use the same (repo, env) on a new laptop, either `export` from the old machine and `import` on the new, or have a teammate send you a fresh share file.
