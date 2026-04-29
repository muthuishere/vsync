# Onboarding — wire `secret-lib` into a new project

This is the **project-owner** path: you have a repo with a `.env.<env>` file (and optionally a vault folder of binary secrets like Firebase service-account JSON, TLS certs, etc.) and you want your team to share those secrets via S3 instead of by hand.

By the end of this guide, your team will be able to:

```bash
export VIDEO_AI_ENV_PRODUCTION='<from-1password>'
task -t infra/setup/Taskfile.yml prod:pull
```

…and have the right `.env.production` + vault folder show up locally. See [`using.md`](./using.md) for the teammate-facing flow.

---

## Prerequisites

- An S3-compatible bucket you control (Hetzner Object Storage, AWS S3, Cloudflare R2, MinIO — anything with an S3 API).
- `bun`, `bunx`, `git` on your machine.
- A `Taskfile.yml`-driven project (we use [Task](https://taskfile.dev) — install once with `brew install go-task`).

## Step-by-step

### 1. Pick a prefix

Each consuming repo gets a unique env-var prefix so multiple projects coexist. Conventions:

| Project | Prefix | Env var |
|---|---|---|
| `video-ai` | `VIDEO_AI_ENV` | `VIDEO_AI_ENV_PRODUCTION` |
| `reqsume` | `REQSUME_ENV` | `REQSUME_ENV_PRODUCTION` |

Pick one. UPPER_SNAKE_CASE, must start with a letter. Replace `<PREFIX>` in the rest of this guide.

### 2. Add the example Taskfile to your repo

Copy `examples/Taskfile.yml` from this repo into your project at `infra/setup/Taskfile.yml`:

```bash
mkdir -p infra/setup
curl -fsSL https://raw.githubusercontent.com/muthuishere/secret-lib/main/examples/Taskfile.yml \
  -o infra/setup/Taskfile.yml
```

Edit one line — change `SECRETS_SYNC_PREFIX: PROJECT_ENV` to your prefix:

```yaml
env:
  SECRETS_SYNC_PREFIX: VIDEO_AI_ENV    # ← your prefix here
```

### 3. Update your repo's `.gitignore`

Add three blocks (adjust to match the env names you actually use):

```gitignore
# secret-lib config files — plaintext S3 creds + encryption key, never committed.
infra/setup/envconfig.*.json

# Real env files (templates can be committed; concrete .env files are NOT)
.env
.env.dev
.env.production
.env.local

# Infra vault — secrets on disk only, never committed
infra/vault/local/
infra/vault/dev/
infra/vault/production/
```

### 4. Create your env-config file

Pick the env you're setting up first (e.g. `PRODUCTION`). The config file lives next to your Taskfile.

```bash
cd infra/setup
curl -fsSL https://raw.githubusercontent.com/muthuishere/secret-lib/main/envconfig.sample.json \
  -o envconfig.production.json
```

Open `envconfig.production.json` and fill in real values:

```json
{
  "s3": {
    "endpoint": "hel1.your-objectstorage.com",
    "bucket": "myprojectsecrets",
    "region": "us-east-1",
    "useSsl": true,
    "accessKeyId": "...",
    "secretAccessKey": "..."
  },
  "encryption": {
    "key": "long-random-passphrase",
    "salt": "deployment-specific-salt"
  },
  "files": {
    "envFile": ".env.production",
    "vaultFolder": "infra/vault/production"
  }
}
```

**Generate strong key + salt** (don't pick a passphrase by hand):

```bash
openssl rand -hex 32     # → encryption.key (64 chars)
openssl rand -hex 16     # → encryption.salt (32 chars)
```

Validation floor: `key` ≥ 20 chars, `salt` ≥ 16 chars. The library refuses anything shorter.

### 5. Generate the export string

From `infra/setup/`:

```bash
task init-env NAME=PRODUCTION
```

You'll see:

```
✅ Encoded.

1. Add this line to your shell rc (~/.zshrc or ~/.bashrc):

   export VIDEO_AI_ENV_PRODUCTION='<long-base64-blob>'
```

### 6. Save the export line in two places

1. **Your `~/.zshrc` (macOS) or `~/.bashrc`:** so this machine has it.
2. **Somewhere your team can pick it up:** whatever channel you use to share secrets (encrypted chat, password manager, internal note, etc.). Send teammates the full `export VIDEO_AI_ENV_PRODUCTION='...'` line.

Then **source your shell:** `source ~/.zshrc` or open a new tab.

### 7. First push — seed S3 with the initial bundle

Make sure your `.env.production` and `infra/vault/production/` (or whatever the config points to) exist locally with real values.

```bash
task -t infra/setup/Taskfile.yml prod:push
```

You should see:

```
[1/5] zipping .env.production + infra/vault/production/
[2/5] sealing manifest ts=20260429-073751
[3/5] encrypting
[4/5] uploading 13616 bytes → s3://myprojectsecrets/production/versions/20260429-073751.enc
[5/5] updating pointer → s3://myprojectsecrets/production/latest
✅ pushed (version: 20260429-073751)
```

### 8. Verify with a fresh-clone test

In another folder, clone the repo and try the using flow:

```bash
git clone <your-repo-url> /tmp/test-clone
cd /tmp/test-clone
export VIDEO_AI_ENV_PRODUCTION='<the-export-line-from-step-5>'
task -t infra/setup/Taskfile.yml prod:pull
```

You should now see `.env.production` and `infra/vault/production/` in `/tmp/test-clone`. Cleanup: `rm -rf /tmp/test-clone`.

### 9. Delete the local config file

`infra/setup/envconfig.production.json` is gitignored, but it sits on disk in plaintext. Either delete it or keep it out of cloud sync / Time Machine / screen shares. You only need it again to *generate* a fresh export line (e.g. during a key rotation).

### 10. Share with the team

Send teammates one thing: the **export line** from Step 5. Use whatever secret-sharing channel your team uses. They paste it into their `~/.zshrc`, run `task prod:pull`, and they're done. See [`using.md`](./using.md).

## Repeat for other envs

For `LOCAL`, `DEV`, `STAGING`, etc. — repeat steps 4–7 with `NAME=LOCAL`, `NAME=DEV`, etc. Each env gets its own `envconfig.<lowercase-name>.json` and its own export line.

You can reuse the same S3 bucket for all envs (they're stored under separate prefix paths: `production/`, `dev/`, `local/`).

## Rotating the encryption key

When you want to rotate (compromised key, employee left, etc.):

1. Edit `infra/setup/envconfig.production.json`, generate a new `encryption.key` + `salt` with `openssl rand`.
2. `task init-env NAME=PRODUCTION` → new export line.
3. Update your `~/.zshrc`, re-share the new export line with the team, and `source`.
4. `task prod:push` to seed S3 with a bundle encrypted under the new key.
5. Coordinate with the team — they all need the new export line. Old bundles in S3 stay there but become unreadable.

## Common mistakes

- **Forgetting to `source ~/.zshrc`** after pasting the export — `task prod:pull` will fail with "VIDEO_AI_ENV_PRODUCTION is not set".
- **Editing `envconfig.production.json` after step 5** — your `~/.zshrc` export line is now stale; re-run `init-env`.
- **Committing `envconfig.production.json`** — it has plaintext S3 creds + the encryption key. Make sure your gitignore is correct *before* you create the file.
- **Pulling before pushing** — `task prod:pull` fails with "pointer is empty" until someone has done the first push.
