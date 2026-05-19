---
name: vsync-skill
---

# Team Setup — wrap vsync in a Taskfile

This is the operating pattern a real team converges on after a few weeks of using vsync. Pick this up when one developer's manual `vsync init / push / export` flow needs to scale to a team that won't remember the flags.

The pattern in one paragraph: standardise the vault folder layout (`infra/vault/<env>/`), wrap every vsync verb in `infra/setup/Taskfile.yml`, codify the v0.7+ flag set as a Taskfile var, and ship a `bootstrap` task that chains `vsync import` + `<env>:pull` so first-day-on-the-job is one command per env. Runnable templates are next to this file in `../templates/`.

## Directory layout

```
<repo>/
├── infra/
│   ├── vault/                            ← gitignored (add infra/vault/ to .gitignore)
│   │   ├── local/
│   │   │   └── .env.local
│   │   ├── dev/
│   │   │   ├── .env.dev
│   │   │   ├── keys/
│   │   │   │   ├── myapp_dev             ← SSH private key, sealed in the vault
│   │   │   │   └── myapp_dev.pub
│   │   │   └── tls/
│   │   │       └── cert.pem
│   │   └── production/
│   │       ├── .env.production
│   │       └── keys/
│   │           └── myapp_prod
│   └── setup/
│       ├── Taskfile.yml                  ← all vsync verbs wrapped
│       ├── scripts/
│       │   ├── bootstrap-env.sh
│       │   ├── ensure-link.sh
│       │   └── status.sh
│       └── README.md                     ← onboarding doc your teammates read
└── .env.dev                              ← SYMLINK → infra/vault/dev/.env.dev
                                              (created by dev:pull, so framework
                                               code that hardcodes `./.env.dev`
                                               keeps working)
```

The vault folder is the single source of truth for that env's secrets. Everything else (repo-root `.env.<env>`, `~/.ssh/<key>`, etc.) is a symlink that points into the vault — created/maintained by Taskfile verbs.

## The two symlink rules — different conservatism levels

Two flavours of symlink exist in this pattern, with deliberately different safety semantics:

| Symlink location | Helper | Retarget on mismatch? | Why |
|---|---|---|---|
| Repo-root (`./.env.<env>`, `e2e/.env.e2e`, …) | Inline Taskfile recipe | **Yes** — silently rm + re-link | Each worktree owns its own repo-root files; retargeting is correct when the previous link was for a different env or a stale path |
| `$HOME`-scoped (`~/.ssh/<key>`, `~/.config/<file>`, …) | `scripts/ensure-link.sh` | **No** — log and skip | `$HOME` is shared across all worktrees + side projects on the machine. If a link already points somewhere unexpected, another checkout owns it. Never silently steal. |

This is why two worktrees of the same repo can both run `dev:pull` safely. Both vaults hold byte-identical keys; the first worktree's `dev:pull` creates `~/.ssh/myapp_dev`; the second's `dev:pull` sees an existing correct symlink and no-ops. If the user has manually put a key at `~/.ssh/myapp_dev` for some reason, `ensure-link.sh` refuses to clobber it.

## The bootstrap chain — what `task bootstrap` actually does

A new teammate runs **one** command per env:

```bash
task -t infra/setup/Taskfile.yml bootstrap ENV=dev SHARE=~/Downloads/myapp-dev.share
```

That dispatches to `scripts/bootstrap-env.sh dev ~/Downloads/myapp-dev.share`, which:

1. Validates `ENV` is one of `local|dev|production` and the `SHARE` file is readable.
2. Runs `vsync import <env> <share-file>` — vsync prompts for the passphrase that was sent on a separate channel; on success the AES key lands in the OS keychain.
3. Runs `task -t infra/setup/Taskfile.yml <env>:pull` — which itself chains: `vsync pull <env>` → repo-root symlink → any e2e/extra-file symlinks → SSH-key symlinks (one per file in `infra/vault/<env>/keys/`).

End state: their vault folder is decrypted on disk, their root `.env.<env>` is a symlink into it, and `~/.ssh/myapp_<env>` is a symlink to the deploy key in the vault. They can `ssh ...`, `task local:dev:all`, `task migrate` — everything Just Works.

The bootstrap script is idempotent: re-running re-imports (overwriting the existing keychain entry — useful after a key rotation) and re-pulls.

## Daily verbs

| What | Command |
|---|---|
| Pull latest dev secrets | `task -t infra/setup/Taskfile.yml dev:pull` |
| Push my dev edits | `task -t infra/setup/Taskfile.yml dev:push` |
| Same for local / production | swap `dev` for `local` / `prod` |
| Fan dev secrets into GitHub Actions | `task -t infra/setup/Taskfile.yml dev:sync:gh` |
| Generate a `.share` to onboard a teammate | `task -t infra/setup/Taskfile.yml dev:export` |
| Audit who touched what | `vsync audit dev` |
| Status — is vsync new enough? | `task -t infra/setup/Taskfile.yml status` |

Note `prod:` is shorthand in the task namespace, but the vault directory + vsync env name stays `production` — match what your team says out loud.

## Push tasks defend the symlink before sealing

The `<env>:push` tasks call the `ensure:link` helper **before** `vsync push <env>`. Why: vsync push reads the vault folder from disk and seals it. If a teammate accidentally `rm`'d the repo-root symlink and re-created it as a regular file, the next `push` would seal the wrong bytes. Re-creating the symlink as a precondition means push always knows what it's sealing.

For the same reason, `pull` runs `vsync pull` **before** the symlink recipes — pull writes the source-of-truth bytes; the symlinks point at them after.

## Status probe — guard against old vsync installs

`scripts/status.sh` is a small defensive script: it checks that `git`, `vsync`, `brew`, `bun` are on PATH, then runs `vsync sync 2>&1` (no args — exits non-zero by design, but prints help) and greps for `--inline-file-suffix`. If the flag is absent, the install is pre-0.7 and the `<env>:sync:gh` tasks will fail with a confusing error. The status script surfaces the upgrade instruction up front.

Run it as part of new-machine setup, or wire it into CI to guard against accidentally checking in flag combos that need a newer vsync than the developer has installed.

## Worktree creation — git worktree add + pre-pull

The `worktree:create` task takes `WT=/abs/path BRANCH=feat/x` and:

1. Refuses if `WT` already exists.
2. `git worktree add -b <BRANCH> <WT> origin/main`
3. `cd $WT && task -t .../Taskfile.yml local:pull && dev:pull`

After v0.9 (current vsync), the worktree's keychain entries are automatically shared with the main checkout because `getRepoName()` resolves from `git remote.origin.url` — both checkouts of `https://github.com/acme/myapp.git` resolve to `acme_myapp` regardless of the directory name. No re-import needed.

Set `PULL=none` for doc-only branches that don't need secrets.

## The flag set that goes into every `*:sync:gh` task

vsync 0.7+ requires every routing target and every excluded property to be passed explicitly. Codify these in a Taskfile var:

```yaml
vars:
  GH_REPO: acme/myapp
  VSYNC_SYNC_FLAGS: >-
    --gh-repo={{.GH_REPO}}
    --inline-file-suffix=_PATH
    --exclude-property=GITHUB_TOKEN
    --exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

Then every `<env>:sync:gh` task is just `vsync sync <env> gh {{.VSYNC_SYNC_FLAGS}}`. One place to add a new excluded property; the dev and production tasks pick it up automatically.

### Why `_PATH` and not `_FILE` for the inline suffix

The default convention this template encourages:

| Suffix | Meaning |
|---|---|
| `<NAME>_PATH=/absolute/path/to/file` | Path to a file whose **contents** should be pushed as a secret named `<NAME>` |
| `<NAME>_FILE=service-account-dev.json` | A filename string read by the app at runtime as a lookup key — push the literal string, NOT the file contents |

`--inline-file-suffix=_PATH` matches the first form. **Do not** add `--inline-file-suffix=_FILE` without auditing every `*_FILE` variable in your env files first — apps that read `APP_FIREBASE_FILE` as a lookup key will silently break when the var suddenly contains JSON bytes instead of a filename.

If you need a different convention, pick a suffix and apply it consistently across your env files and the sync task's flags.

## Why a separate Taskfile that doesn't load dotenv

The repo's root `Taskfile.yml` likely declares `dotenv: [".env"]`. On a fresh clone, that `.env` doesn't exist yet — it gets created by the first `local:pull`. Any setup task therefore has to run **before** the dotenv chain, or the very first run crashes trying to load a non-existent file.

Keep `infra/setup/Taskfile.yml` free of `dotenv:` declarations. All vsync verbs live there. The root Taskfile handles the post-bootstrap world.

## Rotation

```bash
vsync init dev      # mints a fresh AES key, overwrites the keychain entry
vsync push dev      # uploads a bundle sealed with the new key
vsync export dev    # send the new .share + passphrase to surviving teammates
```

Any S3 bundle sealed with the old key becomes unreadable — push immediately after re-init. Per vsync's design there is no per-user revoke; offboarding = rotate, then re-share with everyone but the leaving teammate.

## What this Taskfile does NOT cover

- Running the app locally → root `Taskfile.yml`
- DB migrations → wherever your migration tool lives
- Deploys → CI workflows
- Per-env config files committed to git (not secrets) → live in the repo, not the vault

Keep `infra/setup/Taskfile.yml` scoped to secrets-plumbing. Don't let it grow into a general-purpose orchestrator.

## See also

- [`../SKILL.md`](../SKILL.md) — agent-skill router + core rules + process
- [`taskfile-template.md`](./taskfile-template.md) — full Taskfile body with customisation checklist (copy block into `infra/setup/Taskfile.yml`)
- [`setup-scripts.md`](./setup-scripts.md) — `bootstrap-env.sh`, `ensure-link.sh`, `status.sh` (copy into `infra/setup/scripts/`)
- [`commands.md`](./commands.md) — every vsync verb the Taskfile wraps
- [`sync-flags.md`](./sync-flags.md) — `--inline-file-suffix` / `--exclude-property` policy
- vsync docs: https://muthuishere.github.io/vsync/
- vsync repo: https://github.com/muthuishere/vsync
