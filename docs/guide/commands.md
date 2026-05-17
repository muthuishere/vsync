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

### `sync <env> <gh|gcp>`

Read `<vaultFolder>/.env.<env>` → push each KV to the named target. **One target per invocation** — if you need both `gh` and `gcp`, run twice. Parallel (6 workers, 10-min timeout). First run prompts for routing config and saves it; subsequent runs zero-prompt. See [Fanout to GitHub / GCP](/guide/sync).

The parser has **zero implicit policy** as of v0.7 — every rule is named at the call site. Before pushing, sync prints the active parser policy header so the operator can see exactly which suffixes and exclusions were in effect for the run (empty lists print `(none — file refs disabled)` / `(none — nothing skipped)`). See [v0.7 spec §4](/specs/v0.7-explicit-sync-parser#_4-visibility-sync-prints-its-policy).

```
--inline-file-suffix=<suf> repeatable; suffix that turns a key into a file
                           reference (e.g. --inline-file-suffix=_PATH).
                           Empty list = no file inlining at all.
--exclude-property=<key>   repeatable; key to skip entirely (never pushed).
                           Empty list = nothing skipped.
--gh-repo=<owner/name>     stored in cfg.sync.gh.repo
--gcp-project=<id>         stored in cfg.sync.gcp.project
```

Both `--inline-file-suffix` and `--exclude-property` are **repeated, not comma-separated** — one value per flag occurrence. Each occurrence appends to the list. There is no `--no-…` negation flag; absence of a flag is the off state.

The four-flag invocation that matches v0.6 behavior:

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

### `docs`

Print a short onboarding reference (commands, vault layout, recovery procedure) to stdout. Pipe wherever you want — `vsync docs > infra/AGENTS.md` to give teammates and AI agents a vsync cheat-sheet inside the repo.

---

[Next: Troubleshooting →](/guide/troubleshooting)
