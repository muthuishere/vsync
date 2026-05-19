---
name: vsync-skill
---

# Failure modes — common errors and recovery

Read this when a user reports an unexpected `vsync` error. Every row here is grounded in real symptom text the CLI emits.

## Install / version issues

| Symptom | Cause | Recovery |
|---|---|---|
| `unknown flag --inline-file-suffix` (or any `--*-suffix` / `--exclude-property`) | vsync < 0.7.0 installed | `bun install -g @muthuishere/vsync@latest` then `bun pm ls -g \| grep vsync` to verify ≥ 0.7.0 |
| `Bun.secrets is not a function` | Bun < 1.2.21 | Upgrade Bun: `curl -fsSL https://bun.sh/install \| bash` |
| `vsync: command not found` after `bun install -g` | `~/.bun/bin` not on `PATH` | Add `export PATH="$HOME/.bun/bin:$PATH"` to shell rc, or invoke as `bunx @muthuishere/vsync …` |

## Config / keychain mismatches

| Symptom | Cause | Recovery |
|---|---|---|
| `ConfigFileMissingError: ~/.config/vsync/<repo>/env_<env> not found` | First-time setup on this machine not done | `vsync import <env> <share-file>` (or `task bootstrap ENV=<env> SHARE=…` if Taskfile-wrapped) |
| `KeyMissingError: keychain entry not found for <repo>/<env>` | Config file exists but the AES key wasn't inserted — usually a half-failed import | Re-run `vsync import <env> <share-file>` (idempotent) |
| `Config already exists at: ~/.config/vsync/<repo>/env_<env>` on `vsync init` | A different repo resolves to the same canonical name (v0.9 collision detection) | Re-run with `--repo=<custom-name>`; the existing repo keeps its name. If this *is* the same repo and the user just wants to re-init, manually delete the file first. |
| `decryption failed: tag mismatch` on `vsync pull` | Wrong key (e.g. the import used a stale `.share` file) or bundle was rolled back | Re-export and re-import: original owner runs `vsync export <env>`; teammate runs `vsync import <env> <new-share>` |

## Parser / sync errors

| Symptom | Cause | Recovery |
|---|---|---|
| `parseEnvFile: aborting sync — file references could not be resolved: <KEY>=…` | A `*_PATH` value points at a file that doesn't exist on disk | Run `vsync pull <env>` first so the referenced files materialise; or fix the path in `.env.<env>` |
| `sync.gh.repo not configured` | v0.7+ no longer auto-resolves the GH repo | Pass `--gh-repo=<owner>/<repo>` once; vsync persists it to `cfg.sync.gh.repo` |
| `az keyvault secret set: name contains invalid characters` | An env var name contains `_` (Azure Key Vault disallows underscores) | Rename the var to use `-`, or `--exclude-property=<KEY>` it, or maintain an Azure-shaped overlay env file |
| `E2BIG` from `vault kv put` | More than ~2 MiB of secrets in one path | Split into multiple Vault paths via separate `--vault-path=…` invocations; or wait for a future patch with `@file.json` mode |

## Worktree / collision issues

| Symptom | Cause | Recovery |
|---|---|---|
| Two worktrees of same repo write to different `~/.config/vsync/<basename>/` and one hits `KeyMissingError` | vsync < 0.9.0 — resolver used `basename(toplevel)` which differs per worktree | Upgrade to ≥ 0.9.0; canonical name now derived from `git remote.origin.url`. Or pass `--repo=<canonical>` on every command (pre-v0.9 workaround). |
| After v0.9 upgrade, an existing vsync install still resolves to the old name | The user passed `--repo=` or `SECRETS_SYNC_REPO` (these still win over the new git-remote step) | Inspect with: `--repo` flag, then `$SECRETS_SYNC_REPO`, then v0.9 git-remote auto-resolve. Drop the override to let the new resolver take over (and re-init under the new name if needed). |
| `Config already exists` after upgrading from a pre-v0.9 install in a worktree | Worktree A had been init'd under v0.8 under `<dir-basename>`; v0.9 in worktree B resolves to `<owner>_<repo>` and tries to init | If both should share state: re-init worktree A under the new canonical name (back up the old config first). If they should stay separate: pass `--repo=<old-name>` on worktree A so it keeps using the legacy name. |

## Audit / history

| Symptom | Cause | Recovery |
|---|---|---|
| `vsync audit <env>` is empty | Audit was disabled at init (`--audit=off`), or no operations have run yet | Check `cfg.audit.enabled` in the config file. To enable: re-init with `--audit=on` (this overwrites the keychain — only do this if no team data is at risk). |
| Audit CSV grows unbounded | Append-only by design; vsync does not rotate it | Manual rotation if needed: copy the bucket-side `audit.csv` to an archive prefix, then `aws s3 rm` (or equivalent) the original |
| Manifest pointer-seal mismatch on `vsync pull` (`RQEM0001`) | Someone with bucket write but no keychain key tried to rename an older version onto `latest` | Genuine attack indicator — pull will refuse. Verify with `vsync versions <env>` and contact whoever has bucket-write access |

## When in doubt

Re-run `task -t infra/setup/Taskfile.yml status` (if Taskfile-wrapped) or check:

```bash
bun pm ls -g | grep '@muthuishere/vsync'           # installed version
ls -la ~/.config/vsync/<repo>/                     # config files per env
ls -la ~/.config/vsync/defaults                    # shared S3 defaults
```

For protocol-level questions, `references/mental-model.md` links the specs that own each wire format.
