# Versioning

| Release | What's in it |
|---|---|
| **0.7.0** | `vsync sync` parser has zero implicit policy. **Two intentional breaks vs. 0.6.x:** (1) no defaults — `GITHUB_TOKEN` / `GOOGLE_APPLICATION_CREDENTIALS` are no longer skipped automatically, and `*_PATH` / `*_FILE` are no longer auto-inlined. The operator names every rule with `--inline-file-suffix=<suf>` and `--exclude-property=<key>` (both repeatable, one value per occurrence). (2) In-env routing keys removed — `GITHUB_REPO` / `GCP_PROJECT_ID` lines in `.env.<env>` are now plain KVs; routing lives only in `cfg.sync.gh.repo` / `cfg.sync.gcp.project`. Every `vsync sync` run also prints the active parser policy header before pushing. Wire format / audit log / config schema unchanged — 0.6.x ↔ 0.7.0 bundles are mutually readable. See [v0.7 spec](/specs/v0.7-explicit-sync-parser) for the full rationale and migration steps. |
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
