# Command reference

Every command works fully via flags or fully via prompts.

All commands accept:

- `--repo=<name>` — override the auto-detected repo name. See [Repo identity](/architecture/repo-identity) for the precedence chain.
- `--interactive` — force prompts even when every flag is provided.

## setup

### `init <env>`

Generate AES key (→ keychain), write self-contained per-(repo, env) config, create the resolved vault folder, relocate an existing root `.env.<env>` if found (with a prompt). First-ever run on a machine also writes `~/.config/vsync/defaults` from the supplied values; subsequent runs pre-fill from defaults.

```
--bucket=<name>        --endpoint=<url>        --region=<name>
--access-key=<id>      --secret-key=<secret>   --use-ssl
--vault-folder=<path>  --migrate-from=<path>   --no-migrate
--audit=on|off
```

## sharing

### `export <env>`

Write a passphrase-encrypted `.share` file containing the full per-(repo, env) config + AES key.

```
--out=<path>           default: ./<repo>-<env>.share
--passphrase=<p>       default: auto-generated 4-word phrase
--no-audit             skip the audit-append for this invocation
--note=<text>          → meta.note
--meta key=value       repeatable; merged into the meta cell
```

### `import <env> <file>`

Decrypt a `.share` file with its passphrase; write the per-(repo, env) config + save key to keychain. Idempotent — re-importing overwrites.

```
--passphrase=<p>       avoids the prompt
--file=<path>          alt to positional
--no-audit  --note=<text>  --meta key=value
```

## environment switch

### `use <env>`

Symlink the chosen path → `<vaultFolder>/.env.<env>`. Apps then just `dotenv.config()` with no path arg. See [Switching envs](/guide/use).

```
--link=<path>          default: ./.env  (resolved against repo root)
```

`vsync use` with no env prints the current target. **Refuses to touch an existing regular file at the link path** — no `--force`, by design. Replaces an existing symlink silently. Warns if the link's basename isn't gitignored.

## day-to-day

### `push <env>`

Zip the resolved vault folder → manifest-seal → AES-256-GCM encrypt → upload to `s3://<bucket>/<repo>/<env>/versions/<ts>.enc`, then update `s3://<bucket>/<repo>/<env>/latest`.

```
--no-audit  --note=<text>  --meta key=value
```

### `pull <env>`

Read `latest` pointer → download version → verify embedded manifest timestamp matches pointer (anti-rollback) → decrypt → unzip into the resolved vault folder. Auto-backs up existing contents first.

```
--no-audit  --note=<text>  --meta key=value
```

### `versions <env>`

List `s3://<bucket>/<repo>/<env>/versions/`. One line per version with size + age. `*` marker on the active one. Read-only; no decrypt.

## external fanout

### `sync <env> <gh|gcp|aws|azure|vault>`

Read `<vaultFolder>/.env.<env>` → push each KV to the named target. **One target per invocation** — if you need more than one, run more than one command. gh / gcp / aws / azure run in a 6-worker pool with a 10-min timeout; `vault` writes the whole map in a single atomic `vault kv put` (KV v2 is path-atomic). First run for a given target prompts for routing config and saves it; subsequent runs zero-prompt. See [Fanout to where prod runs](/guide/sync) for per-backend details and [v0.8 spec](/specs/v0.8-multi-target-sync) for the rationale.

The parser has **zero implicit policy** as of v0.7 — every rule is named at the call site, and the same parser policy applies uniformly across all five targets. Before pushing, sync prints the active parser policy header so the operator can see exactly which suffixes and exclusions were in effect for the run (empty lists print `(none — file refs disabled)` / `(none — nothing skipped)`). See [v0.7 spec §4](/specs/v0.7-explicit-sync-parser#_4-visibility-sync-prints-its-policy).

```
--inline-file-suffix=<suf>     repeatable; suffix that turns a key into a file
                               reference (e.g. --inline-file-suffix=_PATH).
                               Empty list = no file inlining at all.
--exclude-property=<key>       repeatable; key to skip entirely (never pushed).
                               Empty list = nothing skipped.

--gh-repo=<owner/name>         stored in cfg.sync.gh.repo
--gcp-project=<id>             stored in cfg.sync.gcp.project
--aws-region=<region>          stored in cfg.sync.aws.region          (required for aws)
--aws-secret-prefix=<prefix>   stored in cfg.sync.aws.secretPrefix    (optional)
--azure-vault=<vault-name>     stored in cfg.sync.azure.vaultName     (vault NAME, not URL)
--vault-addr=<url>             stored in cfg.sync.vault.addr          (required for vault)
--vault-mount=<mount>          stored in cfg.sync.vault.mount         (KV v2 mount)
--vault-path=<path>            stored in cfg.sync.vault.secretPath
```

Both `--inline-file-suffix` and `--exclude-property` are **repeated, not comma-separated** — one value per flag occurrence. Each occurrence appends to the list. There is no `--no-…` negation flag; absence of a flag is the off state.

The four-flag invocation below shows the `gh` shape with the v0.6-default behavior preserved; the [v0.8 spec](/specs/v0.8-multi-target-sync) §3–5 has per-backend recipes for `aws`, `azure`, and `vault`:

```bash
vsync sync dev gh \
  --inline-file-suffix=_PATH \
  --inline-file-suffix=_FILE \
  --exclude-property=GITHUB_TOKEN \
  --exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

## visibility

### `audit <env>`

Print the S3-side audit log: who/where/when of every push/pull/import/export. See [Audit log](/guide/audit).

```
--limit=N              default: 50
--all                  show full log
--csv                  raw CSV passthrough (header + rows)
```

## docs

### `docs [<topic>]`

`vsync docs` (no argument) prints a **CLI capability guide** — what every verb does, plus pointers to the runbooks below and `vsync <sub> --help`. It documents the CLI; it is not a file to commit.

With a topic, it prints a complete, copy-paste, offline runbook:

```bash
vsync docs aws        # create an AWS S3 bucket + IAM key, then init/push/pull/sync
vsync docs gcp        # GCS bucket + HMAC interop key
vsync docs custom     # self-hosted MinIO / any S3-compatible (VPS, R2, B2, Wasabi…)
vsync docs agent      # workflow map an AI assistant follows to drive vsync
vsync docs list       # list available topics
```

The same provider runbooks live on the site under the [handbook](/handbook/).

---

[Next: Troubleshooting →](/guide/troubleshooting)
