---
name: vsync-skill
---

# Taskfile template — `infra/setup/Taskfile.yml`

The full Taskfile that wraps every vsync verb for a multi-env team setup. Copy the YAML block below verbatim into `infra/setup/Taskfile.yml` in the user's repo, then walk them through the customisation checklist.

## Customisation checklist

Before saving the file, change these four things:

1. **`GH_REPO`** (line ~24) — set to `<owner>/<repo>` for the GitHub fanout target.
2. **Env list** — drop `local`, `dev`, or `production` blocks if the repo uses fewer environments; or duplicate the `dev:*` block under a new env name (e.g. `staging`) to add one.
3. **SSH key naming convention** — the `ensure:ssh:link` task auto-discovers every file in `infra/vault/<env>/keys/` (excluding `*.pub`) and creates `~/.ssh/<basename>` symlinks. If the user wants a different naming scheme, adjust the loop body.
4. **`--exclude-property=` entries** — add any other local-only env vars the user has (e.g. personal API tokens used during local dev).

## Why no `dotenv:` declaration in this Taskfile

The root `Taskfile.yml` typically declares `dotenv: [".env"]`. On a fresh clone, that `.env` doesn't exist yet — it's created by the first `local:pull`. Any setup task therefore has to run **before** the dotenv chain, or the very first run crashes loading a non-existent file.

`infra/setup/Taskfile.yml` stays free of `dotenv:` declarations. Don't add one.

## File contents

```yaml
version: '3'

# infra/setup/Taskfile.yml — vsync wrapper for team-shared secret vaults.
#
# This Taskfile intentionally has NO `dotenv:` declaration. On a fresh
# clone the root `.env` doesn't exist yet — it's created by the first
# `local:pull`. Tasks that must run before any env file exists live here.
#
# Run from anywhere:
#   task -t infra/setup/Taskfile.yml bootstrap ENV=dev SHARE=~/Downloads/myapp-dev.share
#   task -t infra/setup/Taskfile.yml dev:pull
#   task -t infra/setup/Taskfile.yml worktree:create WT=/abs/path BRANCH=feat/x

vars:
  # ──────────────────────────────────────────────────────────────────
  # CONFIG — change these for your repo
  # ──────────────────────────────────────────────────────────────────
  GH_REPO: acme/myapp

  # vsync 0.7+ requires every routing target + excluded property to be
  # passed explicitly. Codify them once.
  VSYNC_SYNC_FLAGS: >-
    --gh-repo={{.GH_REPO}}
    --inline-file-suffix=_PATH
    --exclude-property=GITHUB_TOKEN
    --exclude-property=GOOGLE_APPLICATION_CREDENTIALS

tasks:
  # ──────────────────────────────────────────────────────────────────
  # FIRST-TIME SETUP
  # ──────────────────────────────────────────────────────────────────

  bootstrap:
    desc: 'First-time per-env setup: vsync import + pull. Usage: task bootstrap ENV=dev SHARE=/path/to/myapp-dev.share'
    preconditions:
      - sh: '[ -n "{{.ENV}}" ]'
        msg: 'ENV is required (local | dev | production)'
      - sh: '[ -n "{{.SHARE}}" ]'
        msg: 'SHARE is required (absolute path to the .share file from your teammate)'
    cmds:
      - $(git rev-parse --show-toplevel)/infra/setup/scripts/bootstrap-env.sh "{{.ENV}}" "{{.SHARE}}"

  status:
    desc: 'Probe that vsync / bun / git are installed and vsync supports the 0.7+ flag set'
    cmds:
      - $(git rev-parse --show-toplevel)/infra/setup/scripts/status.sh

  # ──────────────────────────────────────────────────────────────────
  # INTERNAL SYMLINK HELPERS
  # ──────────────────────────────────────────────────────────────────

  ensure:link:
    desc: 'Idempotently create the repo-root .env.<ENV> symlink → infra/vault/<ENV>/.env.<ENV>'
    internal: true
    silent: true
    preconditions:
      - sh: '[ -n "{{.ENV}}" ]'
        msg: 'ENV is required (e.g. ENV=dev)'
    cmds:
      - |
        ROOT=$(git rev-parse --show-toplevel)
        ENV="{{.ENV}}"
        TARGET="infra/vault/$ENV/.env.$ENV"
        LINK="$ROOT/.env.$ENV"
        if [ -L "$LINK" ]; then
          CUR=$(readlink "$LINK")
          if [ "$CUR" = "$TARGET" ]; then
            echo "  ✓ .env.$ENV symlink already correct"
          else
            rm "$LINK" && ln -s "$TARGET" "$LINK"
            echo "  ↻ .env.$ENV retargeted ($CUR -> $TARGET)"
          fi
        elif [ -e "$LINK" ]; then
          echo "  ✗ .env.$ENV exists as a real file at the repo root." >&2
          echo "    Back it up or delete it before re-running." >&2
          exit 1
        else
          ln -s "$TARGET" "$LINK"
          echo "  + .env.$ENV → $TARGET"
        fi

  ensure:local:link:
    desc: 'Idempotently create the repo-root .env symlink → infra/vault/local/.env.local'
    internal: true
    silent: true
    cmds:
      - |
        ROOT=$(git rev-parse --show-toplevel)
        TARGET="infra/vault/local/.env.local"
        LINK="$ROOT/.env"
        if [ -L "$LINK" ]; then
          CUR=$(readlink "$LINK")
          if [ "$CUR" = "$TARGET" ]; then
            echo "  ✓ .env symlink already correct"
          else
            rm "$LINK" && ln -s "$TARGET" "$LINK"
            echo "  ↻ .env retargeted ($CUR -> $TARGET)"
          fi
        elif [ -e "$LINK" ]; then
          echo "  ✗ .env exists as a real file at the repo root." >&2
          echo "    Back it up or delete it before re-running." >&2
          exit 1
        else
          ln -s "$TARGET" "$LINK"
          echo "  + .env → $TARGET"
        fi

  ensure:ssh:link:
    desc: 'For each file in infra/vault/<ENV>/keys/ (excluding *.pub), create a ~/.ssh/<basename> symlink'
    internal: true
    silent: true
    preconditions:
      - sh: '[ -n "{{.ENV}}" ]'
        msg: 'ENV is required'
    cmds:
      - |
        ROOT=$(git rev-parse --show-toplevel)
        SCRIPT="$ROOT/infra/setup/scripts/ensure-link.sh"
        KEYS_DIR="$ROOT/infra/vault/{{.ENV}}/keys"
        [ -d "$KEYS_DIR" ] || exit 0
        find "$KEYS_DIR" -maxdepth 1 -type f ! -name '*.pub' \
          | while read -r KEY; do
              "$SCRIPT" "$HOME/.ssh/$(basename "$KEY")" "$KEY"
            done

  # ──────────────────────────────────────────────────────────────────
  # LOCAL
  # ──────────────────────────────────────────────────────────────────

  local:pull:
    desc: 'Pull LOCAL vault from S3 + ensure repo-root .env symlink'
    cmds:
      - vsync pull local
      - task: ensure:local:link

  local:push:
    desc: 'Ensure .env symlink + push LOCAL vault to S3'
    cmds:
      - task: ensure:local:link
      - vsync push local

  local:export:
    desc: 'Generate a passphrase-protected .share file for onboarding'
    cmds: [vsync export local]

  # ──────────────────────────────────────────────────────────────────
  # DEV
  # ──────────────────────────────────────────────────────────────────

  dev:pull:
    desc: 'Pull DEV vault from S3 + ensure .env.dev + ~/.ssh/* symlinks'
    cmds:
      - vsync pull dev
      - task: ensure:link
        vars: { ENV: dev }
      - task: ensure:ssh:link
        vars: { ENV: dev }

  dev:push:
    desc: 'Ensure .env.dev symlink + push DEV vault to S3'
    cmds:
      - task: ensure:link
        vars: { ENV: dev }
      - vsync push dev

  dev:sync:gh:
    desc: 'Fan infra/vault/dev/.env.dev into GitHub Actions secrets'
    cmds:
      - vsync sync dev gh {{.VSYNC_SYNC_FLAGS}}

  dev:export:
    desc: 'Generate a passphrase-protected .share file for onboarding to DEV'
    cmds: [vsync export dev]

  dev:audit:
    desc: 'Print the append-only audit log for DEV'
    cmds: [vsync audit dev]

  # ──────────────────────────────────────────────────────────────────
  # PRODUCTION
  # ──────────────────────────────────────────────────────────────────

  prod:pull:
    desc: 'Pull PRODUCTION vault from S3 + ensure .env.production + ~/.ssh/* symlinks'
    cmds:
      - vsync pull production
      - task: ensure:link
        vars: { ENV: production }
      - task: ensure:ssh:link
        vars: { ENV: production }

  prod:push:
    desc: 'Ensure .env.production symlink + push PRODUCTION vault to S3'
    cmds:
      - task: ensure:link
        vars: { ENV: production }
      - vsync push production

  prod:sync:gh:
    desc: 'Fan infra/vault/production/.env.production into GitHub Actions secrets'
    cmds:
      - vsync sync production gh {{.VSYNC_SYNC_FLAGS}}

  prod:export:
    desc: 'Generate a passphrase-protected .share file for onboarding to PRODUCTION'
    cmds: [vsync export production]

  prod:audit:
    desc: 'Print the append-only audit log for PRODUCTION'
    cmds: [vsync audit production]

  # ──────────────────────────────────────────────────────────────────
  # WORKTREES
  # ──────────────────────────────────────────────────────────────────

  worktree:create:
    desc: 'Create a new git worktree + pre-populate local + dev vaults. Vars: WT, BRANCH; optional PULL=none'
    summary: |
      Required variables:
        WT      — absolute path for the new worktree directory
        BRANCH  — branch name to create (forked off origin/main)

      Optional variables:
        PULL    — "none" to skip vsync pulls (doc-only branches)
    preconditions:
      - sh: '[ -n "{{.WT}}" ]'
        msg: 'WT is required (absolute path for the new worktree)'
      - sh: '[ -n "{{.BRANCH}}" ]'
        msg: 'BRANCH is required'
    cmds:
      - |
        REPO_ROOT=$(git rev-parse --show-toplevel)
        TASKFILE="$REPO_ROOT/infra/setup/Taskfile.yml"
        if [ -e "{{.WT}}" ]; then
          echo "✗ {{.WT}} already exists" >&2
          exit 1
        fi
        git worktree add -b "{{.BRANCH}}" "{{.WT}}" origin/main
        # vsync ≥ 0.9 resolves the canonical repo name from
        # `git remote.origin.url`, so the new worktree shares the keychain
        # entry with the main checkout — no second `vsync import` needed.
        if [ "{{.PULL}}" = "none" ]; then
          echo "  · skipping vsync pulls (PULL=none)"
        else
          ( cd "{{.WT}}" && task -t "$TASKFILE" local:pull )
          ( cd "{{.WT}}" && task -t "$TASKFILE" dev:pull )
        fi
        echo ""
        echo "✓ Worktree ready at {{.WT}} on branch {{.BRANCH}}"
```

## Companion scripts

This Taskfile references three executables at `infra/setup/scripts/`. Copy their contents from `references/setup-scripts.md` and `chmod +x` them.
