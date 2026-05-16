# Versioning

| Release | What's in it |
|---|---|
| **0.5.0** | `vsync use <env>` — symlinks `./.env` (or `--link=<path>`) at the vault's env file so `dotenv.config()` just works; switch envs with one command. README rewrite + flow diagram. |
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

The design docs at [`docs/specs/`](/specs/v0.4-audit-log) capture the rationale and constraints for each minor release. Read them when you need to know **why** something is the way it is — they go deeper than the user guide.

---

[All commands →](/guide/commands)
