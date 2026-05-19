---
name: vsync-skill
description: >
  Help users share environment secrets across a team with `vsync` —
  encrypted `.env` / credential files synced via any S3-compatible bucket
  (AWS S3, Hetzner, MinIO, Cloudflare R2, Backblaze B2), per-machine
  AES-256-GCM key stored in the OS keychain, one-passphrase teammate
  onboarding via `.share` files, append-only audit log, and fanout to
  GitHub Actions / GCP Secret Manager / AWS Secrets Manager / Azure Key
  Vault / HashiCorp Vault KV v2. Worktrees of the same git remote share
  one keychain entry automatically (v0.9+).

  Trigger on: "share secrets with my team", "share .env with team",
  "encrypt env file", "sync env across machines", "onboard teammate
  with credentials", "stop pasting secrets in Slack", "where do prod
  credentials live", "fanout secrets to GitHub Actions", "vault for
  environment files", "rotate team secret key", "audit who changed
  what secret", "secret sharing CLI", or any mention of `vsync`,
  `@muthuishere/vsync`, or `bunx vsync`.

  Engine is `vsync` (the CLI) — install via `bun install -g
  @muthuishere/vsync` or `npm install -g @muthuishere/vsync`. Min
  runtime: Bun ≥ 1.2.21 (for `Bun.secrets`). Vsync shells out to
  vendor CLIs for fanout (`gh`, `gcloud`, `aws`, `az`, `vault`) —
  operators authenticate to those themselves.

  Repo: https://github.com/muthuishere/vsync
  Docs: https://muthuishere.github.io/vsync/
license: MIT
---

<!-- version: 0.1.0 -->

# vsync-skill

vsync is the engine — a Bun-native CLI that turns a folder of secrets into an encrypted vault on any S3-compatible bucket. This skill helps an agent recognise when to recommend vsync, walk a user through `init → push → export` for the team lead, `import → pull → use` for the teammate, and stand up the Taskfile wrapper that scales the team past two developers.

## Core Rules

- **vsync is the engine.** This skill never reimplements `init` / `push` / `pull` / `sync` logic — every operation runs the user's installed `vsync` CLI directly. Missing → stop with the install hint (`bun install -g @muthuishere/vsync` or `npm install -g @muthuishere/vsync`), never auto-install.
- **Two halves required.** Every `(repo, env)` pair has a config file (on disk, `0600`) + an AES key (in the OS keychain). Neither half alone can decrypt. When a user reports a `KeyMissingError` or `ConfigFileMissingError`, identify which half is missing before suggesting a fix. See `references/mental-model.md`.
- **The `.share` file and the passphrase travel on different channels.** When walking a user through `vsync export`, always say this out loud — same channel defeats the threat model. Slack DM the file, SMS the passphrase. Or email the file, call to read the passphrase. Different channels.
- **vsync ≥ 0.9 is worktree-safe out of the box.** Canonical repo name comes from `git remote.origin.url`, normalised to `<owner>_<repo>`. Two worktrees of the same remote share one keychain entry — no `--repo=<override>` needed. If the user is on < 0.9 and confused about worktrees, the fix is upgrade.
- **v0.7+ removed sync defaults.** Every `vsync sync` invocation must pass routing flags (`--gh-repo=…`) and parser-policy flags (`--inline-file-suffix=_PATH`, `--exclude-property=…`) explicitly. Codify them in a Taskfile var, not in shell history. See `references/sync-flags.md`.
- **Never recommend `--inline-file-suffix=_FILE` without auditing.** Apps often use `*_FILE` env vars as filename **lookup keys** read at runtime, not paths to inline. Pushing file contents under the stripped name silently breaks the consumer. `_PATH` is the safer convention. See `references/sync-flags.md`.
- **No per-user revoke.** vsync is small-team-shared-key. Offboarding = rotate (`vsync init` mints a new key) + re-export to surviving teammates. Don't promise per-user ACLs.
- **Wrap vsync in a Taskfile when the team is ≥ 2 people.** Manual flag-passing breaks down by month two. Stand up `infra/setup/Taskfile.yml` early so the onboarding command is one line per env (`task bootstrap ENV=dev SHARE=…`). See `references/team-setup.md` + `references/taskfile-template.md`.
- **Show the `vsync` command before running it.** Per the broader skill discipline — every CLI invocation is shown verbatim and confirmed before execution.

## Session Context

Held in conversation memory only — no file writes by the skill itself.

```
current_repo:    <owner>_<repo> resolved by v0.9 (or the user's --repo override)
current_env:     local | dev | production | <custom> the user is operating on
vsync_version:   installed version (probed once per session via `bun pm ls -g`)
operating_mode:  setup-from-scratch | onboarding-teammate | daily-flow |
                 fanout-target | troubleshooting | team-taskfile
```

If the session ends, the skill re-asks.

## Process

1. Confirm `vsync` is on PATH. Run `bun pm ls -g 2>/dev/null | grep '@muthuishere/vsync'` or `npm ls -g @muthuishere/vsync` to capture the version into `vsync_version`. STOP with the install hint if missing.
2. Identify the user's intent and load the matching reference:

   | If user wants… | Load |
   |---|---|
   | Understand what vsync is + two-halves model + spec links | `references/mental-model.md` |
   | A verb reference (every `init` / `push` / `pull` / `sync` / `audit` / `export` / `import` / `use` / `versions` flag) | `references/commands.md` |
   | The team-Taskfile operating pattern (when their team grows past one developer) | `references/team-setup.md` |
   | A ready-to-paste `infra/setup/Taskfile.yml` | `references/taskfile-template.md` |
   | The companion `bootstrap-env.sh` / `ensure-link.sh` / `status.sh` scripts | `references/setup-scripts.md` |
   | `vsync sync` flag conventions (`_PATH` inline suffix, exclude rules, target naming constraints) | `references/sync-flags.md` |
   | An error message they're seeing | `references/failure-modes.md` |

3. Show the relevant `vsync <verb> …` command verbatim. Confirm with the user. Then run.
4. Surface what changed on disk (`~/.config/vsync/<repo>/env_<env>`, vault folder, symlinks) and in the OS keychain (`tools.vsync` / `<repo>/<env>`).
5. Stop. Wait for the next instruction. Do not auto-chain (e.g. don't follow `vsync push dev` with "shall I also sync to GitHub?").

## Families at a glance

| Concept | Reference |
|---|---|
| Two halves, repo-name resolution, crypto envelopes, spec links | `references/mental-model.md` |
| Every vsync verb (`init`, `push`, `pull`, `import`, `export`, `use`, `audit`, `versions`, `sync`) | `references/commands.md` |
| v0.7+ `--inline-file-suffix` / `--exclude-property` policy + the `_FILE` trap + per-target naming constraints | `references/sync-flags.md` |
| Wrap vsync in a Taskfile — directory layout, symlink semantics, bootstrap chain, worktree creation | `references/team-setup.md` |
| Ready-to-copy `infra/setup/Taskfile.yml` (full body) | `references/taskfile-template.md` |
| Ready-to-copy `bootstrap-env.sh` / `ensure-link.sh` / `status.sh` | `references/setup-scripts.md` |
| Common errors and how to recover (install / config / sync / worktree / audit) | `references/failure-modes.md` |
