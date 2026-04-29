# Using — daily flow once your project is set up

This is the **teammate** path: someone has already onboarded the project (see [`onboarding.md`](./onboarding.md)) and saved the export line in 1Password. You just want the secrets on your machine.

## First-time setup on your machine

### 1. Get the export line from 1Password

Ask your team / open 1Password. You're looking for an entry like:

```
VIDEO_AI_ENV_PRODUCTION
```

Its value will be a long string starting with something like `H4sIA…` (gzip+base64). Copy the whole `export …` line.

### 2. Paste into `~/.zshrc` (or `~/.bashrc`)

Open `~/.zshrc` in your editor and paste at the end:

```bash
# video-ai production secrets — secret-lib
export VIDEO_AI_ENV_PRODUCTION='H4sIA...long-blob...'
```

Substitute the actual prefix and env name your project uses (e.g. `REQSUME_ENV_DEV`, `MYAPP_ENV_LOCAL`).

### 3. Source your shell

```bash
source ~/.zshrc
```

…or just open a new terminal tab.

### 4. Pull the secrets into your repo

From your repo root:

```bash
task -t infra/setup/Taskfile.yml prod:pull
```

You should see:

```
[1/6] backing up local files (if any)
      (no local files yet, skipping)
[2/6] reading pointer s3://...
[3/6] downloading version 20260429-073751
[4/6] decrypting
[5/6] verifying manifest ts
[6/6] unzipping into /your/repo
✅ pulled version 20260429-073751
```

`.env.production` and the vault folder are now on disk. Done.

## Day-to-day

### Pulling latest from a teammate's push

Whenever someone updates a credential and pushes, you pull:

```bash
task -t infra/setup/Taskfile.yml prod:pull
```

Your existing local `.env.production` + vault folder get encrypted-backed-up to `~/.config/localdevconfig/<env>-<ts>.zip.enc` (rolling 2 most recent) before being overwritten. So an accidental clobber is recoverable.

### Pushing a credential change

You edited `.env.production` (rotated an API key, added a new one). Push so the team picks it up:

```bash
task -t infra/setup/Taskfile.yml prod:push
```

This uploads a new versioned bundle. Old versions stay in S3 — if your push was a mistake, the team can pull whatever the previous `latest` pointed at by manually setting the pointer back, but in practice it's easier to just `prod:push` again with the corrected files.

## Recovering from an overwrite

If `prod:pull` clobbered local edits you wanted to keep:

```bash
ls ~/.config/localdevconfig/production-*.zip.enc
# pick a backup file from the list

SECRETS_SYNC_PREFIX=VIDEO_AI_ENV bunx github:muthuishere/secret-lib \
  restore-backup PRODUCTION \
  ~/.config/localdevconfig/production-20260429-103045.zip.enc \
  /tmp/recovered

# inspect /tmp/recovered/, copy what you need back into the repo
```

The lib keeps the **2 most recent** backups per env. If you've pulled three times in a row, the original is gone.

## Multiple environments

If your project has `LOCAL`, `DEV`, `PRODUCTION`, etc.:

```bash
# Each env has its own export line in 1Password and its own zshrc entry:
export VIDEO_AI_ENV_LOCAL='...'
export VIDEO_AI_ENV_DEV='...'
export VIDEO_AI_ENV_PRODUCTION='...'

# Pull whichever you're working with:
task -t infra/setup/Taskfile.yml local:pull
task -t infra/setup/Taskfile.yml dev:pull
task -t infra/setup/Taskfile.yml prod:pull
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `VIDEO_AI_ENV_PRODUCTION is not set` | Forgot to source after pasting | `source ~/.zshrc` or open a new tab |
| `pointer is empty — push-env first to seed the bucket` | No one has done the initial push for that env | Ask the project owner to run `task prod:push` |
| `pointer claims X but bundle was sealed as Y — refusing` | `latest` points at a tampered/renamed bundle (or your key is mismatched) | Get the current export line from 1Password — yours may be stale after a rotation |
| `decrypt failed / OperationError` | Your encryption key doesn't match what the bundle was encrypted with | Same as above — your export line is stale |
| `bunx github:muthuishere/secret-lib …` fails to install | Network / GitHub auth | Check `gh auth status`; for public repos no auth needed but `bun` must be on PATH |

## Library version

This repo's Taskfile typically tracks `main` (no version pin). To pin to a tag:

```yaml
vars:
  SECRET_LIB: bunx github:muthuishere/secret-lib#v0.1.1
```

See [releases](https://github.com/muthuishere/secret-lib/releases).
