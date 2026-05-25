# Versioning

| Release | What's in it |
|---|---|
| **0.12.0** | **Breaking on the CLI surface.** (1) Git is now a precondition — every subcommand errors outside a git tree. (2) `SECRETS_SYNC_REPO` env var is gone; `--repo=<name>` is the only override. (3) New committed `.vsync` identity pin file at the git toplevel, written by `init` / `import` ([v0.16 spec](/specs/v0.16-repo-identity-git-only)). (4) `vsync pull` now refuses on unsynced local edits — `--backup` snapshots vault to `$XDG_CONFIG_HOME/vsync/backups/<repo>/<env>.backup-<ts>/`, `--force` discards without backup. (5) `vsync push` refuses when remote has advanced since your last sync; `--force` overrides ([v0.17 spec](/specs/v0.17-pull-safety)). (6) Symlinks in vault folder are no longer allowed (vault is plain data). (7) New typed errors render cleanly without stack traces: `NotInGitRepoError`, `RepoIdentityUnresolvedError`, `VsyncFileMalformedError`, `VsyncFileClobberError`, `ShareRepoMismatchError`, `LocalDirtyError`, `RemoteAheadError`, `LedgerMalformedError`, `SymlinkInVaultError`. (8) `vsync status` adds a prefix block: `Repo` / `Source` (`flag` / `file` / `auto`) / `Toplevel` / `Origin` / optional worktree info. **Wire format unchanged** — bundles produced by 0.12.0 are still readable by 0.11.0 clients, but 0.11.0 push/pull won't surface the new safety errors. Runtime libraries stay at 0.11.0 for this release; they catch up to 0.12.0 when v0.15 lands. |
| 0.8.0 | Three new `vsync sync` targets: `aws` (AWS Secrets Manager), `azure` (Azure Key Vault), `vault` (HashiCorp Vault KV v2). Dispatcher rewritten around a `TargetHandler` registry — `gh` / `gcp` move into the registry unchanged, three new handlers land alongside. **Purely additive — every 0.7.x invocation works byte-for-byte in 0.8.0.** New flags per target: `--aws-region`, `--aws-secret-prefix`, `--azure-vault`, `--vault-addr`, `--vault-mount`, `--vault-path` (persisted to `cfg.sync.<target>` on first use). gh / gcp / aws / azure share the 6-worker pool; `vault` writes the whole map in **one atomic `vault kv put`** since KV v2 is path-atomic. Wire format / audit log / parser policy / share-file format unchanged. See [v0.8 spec](/specs/v0.8-multi-target-sync) for the rationale and per-backend details. |
| 0.7.1 | `vsync sync <env> all` removed. Only `gh` and `gcp` remained as 0.7 targets; one target per invocation. (Joined by `aws`, `azure`, `vault` in 0.8 — the one-target-per-invocation rule still applies.) Same no-magic theme as v0.7's parser refactor — the operator names what runs. CLI rejects `all` as an unknown target. |
| 0.7.0 | `vsync sync` parser has zero implicit policy. **Two intentional breaks vs. 0.6.x:** (1) no defaults — `GITHUB_TOKEN` / `GOOGLE_APPLICATION_CREDENTIALS` are no longer skipped automatically, and `*_PATH` / `*_FILE` are no longer auto-inlined. The operator names every rule with `--inline-file-suffix=<suf>` and `--exclude-property=<key>` (both repeatable, one value per occurrence). (2) In-env routing keys removed — `GITHUB_REPO` / `GCP_PROJECT_ID` lines in `.env.<env>` are now plain KVs; routing lives only in `cfg.sync.gh.repo` / `cfg.sync.gcp.project`. Every `vsync sync` run also prints the active parser policy header before pushing. Wire format / audit log / config schema unchanged — 0.6.x ↔ 0.7.0 bundles are mutually readable. See [v0.7 spec](/specs/v0.7-explicit-sync-parser) for the full rationale and migration steps. |
| 0.6.0 | `.env.<env>` file-reference convention: any key ending in `_PATH` / `_FILE` is read from disk and the file's contents are pushed under the stripped name. Paths anchor to `VAULT_ROOT` (the env file's own directory); `${VAULT_ROOT}` / `${HOME}` / `~/` placeholders work in every value. Missing files abort the sync before any push (all-or-none). Replaces the two hardcoded keys from 0.5.x (`SSH_KEY_PATH`, `GCP_SA_KEY_FILE_PATH`) — see [migration](/specs/v0.6-vault-relative-file-refs). |
| 0.5.0 | `vsync use <env>` — symlinks `./.env` (or `--link=<path>`) at the vault's env file so `dotenv.config()` just works; switch envs with one command. README rewrite + flow diagram. |
| 0.4.0 | Append-only audit log at `s3://<bucket>/<repo>/<env>/audit.csv` + `vsync audit` viewer. Expandable `meta` JSON cell via `--note` / `--meta` + matching env vars. |
| 0.3.0 | Opinionated layout: vault folder at `infra/vault/<env>/` with `--vault-folder` override; self-contained per-(repo, env) config; `vsync sync` for GitHub / GCP fanout. |

All 0.x releases are wire-compatible with each other on the S3 bundle envelope (`RQE1`) and manifest seal (`RQEM0001`). New clients tolerate the absence of features added in later versions; old clients ignore new objects (like `audit.csv`) on the bucket.

## Upgrading between minor versions

`bun install -g @muthuishere/vsync@latest` (or `npm install -g @muthuishere/vsync@latest`) — that's it. No config migration. No keychain reshuffle. New features land additively.

If your team upgrades unevenly, the older clients continue to work — they just won't see new behaviour. Example: pre-0.4 clients ignore `audit.csv` on the bucket; post-0.4 clients see all rows including ones written by the older clients (no rows, in their case).

## Semver discipline

- **Patch** (0.5.0 → 0.5.1) — bug fixes, doc tweaks, no behaviour change.
- **Minor** (0.5.0 → 0.6.0) — new verb, new flag, new behaviour. Old code paths unchanged.
- **Major** (0.x.x → 1.0.0) — wire-format break or removed verb. Has not happened; 0.x is intentionally pre-stable.

## Source of truth for each release

The design docs at [`docs/specs/`](/specs/v0.6-vault-relative-file-refs) capture the rationale and constraints for each minor release. Read them when you need to know **why** something is the way it is — they go deeper than the user guide.

---

[All commands →](/guide/commands)
