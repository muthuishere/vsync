# Fanout to where prod runs

Once your vault is the source of truth, `vsync sync <env> <target>` pushes the KVs in `<vaultFolder>/.env.<env>` to where production actually runs. As of v0.8 there are five first-class targets:

```bash
vsync sync dev gh                       # GitHub Actions repo secrets
vsync sync dev gcp                      # GCP Secret Manager
vsync sync dev aws                      # AWS Secrets Manager
vsync sync dev azure                    # Azure Key Vault
vsync sync dev vault                    # HashiCorp Vault KV v2
```

**One target per invocation.** If you need more than one, run more than one command. (The fold-in `all` target was removed in v0.7.1 — same no-magic theme as the v0.7 parser: the operator names what runs.)

Auth is **outside vsync's scope** — the lib trusts whatever `gh`, `gcloud`, `aws`, `az`, or `vault` are doing on your machine. Run the relevant `<tool> auth login` / `<tool> login` first.

## How sync works

As of v0.7, the env-file parser has **zero implicit policy**. There are no hardcoded suffixes, no hardcoded exclude list, no defaults applied by the CLI. If you don't pass `--inline-file-suffix=_PATH`, then a key called `FOO_PATH` is a plain KV with value `keys/foo`. If you don't pass `--exclude-property=GITHUB_TOKEN`, then `GITHUB_TOKEN` gets pushed.

This makes the call site the single source of truth for parser behavior. The four-flag invocation that matches the old (v0.6) defaults is:

```bash
vsync sync dev gh \
  --inline-file-suffix=_PATH \
  --inline-file-suffix=_FILE \
  --exclude-property=GITHUB_TOKEN \
  --exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

Drop this into your Taskfile / Makefile / CI so the whole policy is visible at a glance. Both `--inline-file-suffix` and `--exclude-property` are **repeated, not comma-separated** — one value per flag occurrence; each occurrence appends to the list. There is no `--no-…` negation flag; absence of a flag is the off state.

### The policy header

Every `vsync sync` run prints the active parser policy before the first push:

```
$ vsync sync dev gh \
    --inline-file-suffix=_PATH \
    --inline-file-suffix=_FILE \
    --exclude-property=GITHUB_TOKEN \
    --exclude-property=GOOGLE_APPLICATION_CREDENTIALS

Parser policy:
  inline-file-suffix: _PATH
  inline-file-suffix: _FILE
  exclude-property:   GITHUB_TOKEN
  exclude-property:   GOOGLE_APPLICATION_CREDENTIALS

Syncing 11 secrets to GitHub: repo=muthuishere/vsync, environment=dev
  skipped (excluded): GITHUB_TOKEN
Setting secret: SSH_PRIVATE_KEY
✓ SSH_PRIVATE_KEY
…
```

When either list is empty, the header is explicit about it:

```
Parser policy:
  inline-file-suffix: (none — file refs disabled)
  exclude-property:   (none — nothing skipped)
```

Two lines per run, zero ambiguity about why a key was or wasn't pushed.

## `vsync sync <env> gh`

1. Resolves `sync.gh.repo` from per-(repo, env) config (or `--gh-repo` flag, or first-run interactive prompt that saves the answer).
2. Parses `<vaultFolder>/.env.<env>` into push-ready KVs (using the rules you passed on the command line — see above).
3. For each KV, in a 6-worker pool: `gh secret set <KEY> --env <env> --repo <sync.gh.repo>` with the value on stdin.
4. Requires `gh` CLI installed and `gh auth login` already done.

## `vsync sync <env> gcp`

1. Resolves `sync.gcp.project` similarly.
2. Same env-file parse.
3. For each KV: `gcloud secrets describe <KEY> --project=<proj>` to check existence; then either `gcloud secrets versions add <KEY> …` (already exists) or `gcloud secrets create <KEY> --replication-policy=automatic …` (new). Value on stdin via `--data-file=-`.
4. Requires `gcloud` CLI installed and `gcloud auth login` done.
5. **Per-env isolation** comes from per-env GCP **projects** (dev project ≠ prod project) — secret names are flat within a project. Don't try to sync dev and prod into the same project.

## `vsync sync <env> aws`

1. Resolves `sync.aws.region` (required) and `sync.aws.secretPrefix` (optional) from per-(repo, env) config, or `--aws-region=<region>` / `--aws-secret-prefix=<prefix>` flags, or first-run prompt that saves the answer.
2. Same env-file parse.
3. For each KV, in a 6-worker pool: `aws secretsmanager describe-secret --secret-id <prefix><KEY> --region <region>`. Exit 0 → secret exists, do `aws secretsmanager put-secret-value …`. Non-zero → secret is new, do `aws secretsmanager create-secret …`. Value passed via stdin (`--secret-string fileb:///dev/stdin`).
4. Requires `aws` CLI installed and credentials available — `aws configure`, `aws sso login`, or `AWS_*` env vars. vsync trusts whatever the AWS CLI resolves; it doesn't manage credentials.
5. AWS Secrets Manager accepts `/_+=.@-` plus alphanumeric, so typical `SCREAMING_SNAKE_CASE` keys work as-is. Use `--aws-secret-prefix=myapp/prod/` to namespace per-env when one AWS account holds multiple environments.

```bash
vsync sync production aws \
  --aws-region=us-east-1 \
  --aws-secret-prefix=myapp/prod/ \
  --inline-file-suffix=_PATH \
  --inline-file-suffix=_FILE \
  --exclude-property=GITHUB_TOKEN \
  --exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

## `vsync sync <env> azure`

1. Resolves `sync.azure.vaultName` (required) — pass the **vault name**, not the URL — from per-(repo, env) config, or `--azure-vault=<vault-name>` flag, or first-run prompt.
2. Same env-file parse.
3. For each KV, in a 6-worker pool: `az keyvault secret set --vault-name <vault> --name <KEY> --file /dev/stdin`. The command is idempotent — it creates if missing, adds a new version if present. No describe-first dance.
4. Requires `az` CLI installed and `az login` already done.

**Naming constraint — Azure Key Vault only allows `0-9 A-Z a-z -`.** Underscores fail at push time with an `az` CLI error. **Per the no-magic theme, vsync does not silently translate `_` → `-`.** The operator has three options:

- **Rename keys in `.env.<env>`** so they only use the allowed character set (e.g. `DB-URL` instead of `DB_URL`).
- **Skip the offending keys** with `--exclude-property=<key>` (repeatable) — useful when only a couple of keys are problematic and the rest of the env file should still ship to Azure.
- **Maintain a separately-shaped env file** for Azure if your shared `.env.<env>` is committed to using underscores for gh/gcp/aws.

A future `--key-translate=<from>:<to>` parser flag may land if there's demand; it's explicitly out of scope for v0.8.

```bash
vsync sync production azure \
  --azure-vault=myapp-prod-kv \
  --inline-file-suffix=_PATH \
  --inline-file-suffix=_FILE \
  --exclude-property=GITHUB_TOKEN \
  --exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

## `vsync sync <env> vault`

1. Resolves `sync.vault.addr`, `sync.vault.mount`, and `sync.vault.secretPath` (all required) from per-(repo, env) config, or `--vault-addr=<url>` / `--vault-mount=<mount>` / `--vault-path=<path>` flags, or first-run prompt.
2. Same env-file parse.
3. **Single bulk write — the 6-worker pool is bypassed.** All KVs land in one atomic `vault kv put`:

   ```
   VAULT_ADDR=<addr> vault kv put -mount=<mount> <secretPath> KEY1=value1 KEY2=value2 …
   ```

   KV v2 is path-atomic — either the whole map lands or none of it does. There is no per-key partial-success state to surface, so vsync's summary is all-or-nothing per invocation.

4. Requires `vault` CLI installed and `vault login` already done (token in `~/.vault-token`).

**Scope: KV v2 only.** KV v1, Transit, PKI, Vault namespaces, and Enterprise features are not supported. A future patch will switch to `@file.json` mode if the per-env KV map ever bumps into `ARG_MAX` (~2 MiB on Linux); v0.8 lets `E2BIG` surface loudly if you ever hit it.

```bash
vsync sync production vault \
  --vault-addr=https://vault.example.com \
  --vault-mount=secret \
  --vault-path=myapp/production \
  --inline-file-suffix=_PATH \
  --inline-file-suffix=_FILE \
  --exclude-property=GITHUB_TOKEN \
  --exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

## File references in `.env.<env>` — explicit opt-in

When you pass `--inline-file-suffix=<suffix>`, any key in `.env.<env>` ending in that suffix is treated as a **file reference**. Vsync reads the file from disk and pushes its contents as the secret value, under the key with the suffix stripped.

With `--inline-file-suffix=_PATH --inline-file-suffix=_FILE` in effect:

| `.env` entry | What gets pushed | Key on the target |
|---|---|---|
| `SSH_PRIVATE_KEY_PATH=keys/reqsume_dev` | contents of `<vault>/keys/reqsume_dev` | `SSH_PRIVATE_KEY` |
| `GCP_SA_KEY_FILE=keys/sa.json` | contents of `<vault>/keys/sa.json` | `GCP_SA_KEY` |
| `TLS_CERT_PATH=~/certs/foo.pem` | contents of `$HOME/certs/foo.pem` | `TLS_CERT` |
| `BOOTSTRAP_FILE=/etc/foo/bootstrap` | contents of `/etc/foo/bootstrap` | `BOOTSTRAP` |

The rule is: **name the env-file key after the secret you want, with the configured suffix appended.** No rename table, no special cases. If you pass `--inline-file-suffix=_KEY` instead, then `FOO_KEY=…` becomes the file rule and `FOO_PATH` is a plain KV again.

If you pass no `--inline-file-suffix` flag at all, file references are disabled — every value is pushed verbatim, paths included.

### Path resolution

Relative paths anchor to `VAULT_ROOT` (the directory of the `.env.<env>` file being parsed):

| In env file | Resolves to |
|---|---|
| `keys/foo` or `./keys/foo` | `<vault>/keys/foo` |
| `${VAULT_ROOT}/keys/foo` | same (explicit form) |
| `~/.ssh/id_rsa` or `${HOME}/.ssh/id_rsa` | `$HOME/.ssh/id_rsa` |
| `/abs/path` | absolute, pass-through |

The three placeholders (`${VAULT_ROOT}`, `${HOME}`, leading `~/`) are expanded in **every** value — not just file-ref values — so you can also write `DATA_DIR=${VAULT_ROOT}/cache` for plain KVs.

### All-or-none on missing files

If any file reference resolves to a missing or unreadable file, vsync collects every such error across the whole file and aborts before pushing anything. No partial syncs.

Example error:
```
parseEnvFile: aborting sync — 2 file reference(s) could not be resolved:
  - SSH_PRIVATE_KEY_PATH: file not found at /…/vault/dev/keys/missing
  - DEPLOY_KEY_FILE: file not found at /…/vault/dev/deploy.key
```

## Excluded keys — explicit opt-in

Pass `--exclude-property=<key>` (repeatable) for any key you don't want pushed. Common candidates are tokens that exist on the local machine for `gh` / `gcloud` to use directly:

```bash
--exclude-property=GITHUB_TOKEN \
--exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

The policy header lists every exclude rule that was in effect, and the run output prints a `skipped (excluded): <KEY>` line for each match. If you pass no `--exclude-property` flag at all, nothing is skipped — every KV in the env file is pushed.

## Routing config

`vsync sync` stores routing in the per-(repo, env) config:

- `sync.gh.repo` — `<owner>/<repo>` for GitHub Actions
- `sync.gcp.project` — project ID for GCP Secret Manager
- `sync.aws.region` + `sync.aws.secretPrefix` — region (required) + optional name prefix for AWS Secrets Manager
- `sync.azure.vaultName` — Azure Key Vault name (not URL)
- `sync.vault.addr` + `sync.vault.mount` + `sync.vault.secretPath` — Vault server URL + KV v2 mount + path

First run for each target prompts and saves. Subsequent runs are zero-prompt. Override per-invocation with the matching flag — `--gh-repo`, `--gcp-project`, `--aws-region`, `--aws-secret-prefix`, `--azure-vault`, `--vault-addr`, `--vault-mount`, `--vault-path`.

As of v0.7, **routing lives only in config** — the in-env routing keys `GITHUB_REPO` and `GCP_PROJECT_ID` are no longer recognized by the parser. If those lines still exist in your `.env.<env>` files, they're now plain KVs and (unless `--exclude-property`'d) will be pushed. Delete them once routing is stored via the config.

## Migration from v0.6

There are two intentional behavior breaks vs. 0.6.x. Both are described in detail in [`docs/specs/v0.7-explicit-sync-parser.md` §5](/specs/v0.7-explicit-sync-parser#_5-migration-0-6-x-→-0-7-0); the short version:

1. **No defaults.** Bare `vsync sync dev gh` no longer skips `GITHUB_TOKEN` / `GOOGLE_APPLICATION_CREDENTIALS` and no longer inlines `*_PATH` / `*_FILE`. To preserve v0.6 behavior verbatim, append the four flags from the [recipe above](#how-sync-works) to every invocation. Update Taskfiles in one pass — the patch is mechanical.
2. **In-env routing keys removed.** `GITHUB_REPO=…` and `GCP_PROJECT_ID=…` lines in `.env.<env>` files are no longer special. Move routing into config (`vsync sync dev gh --gh-repo=<owner/name>` once, persisted; same for `--gcp-project`), then delete the dead lines from your env files.

Wire format, audit log, and config schema are unchanged — 0.6.x and 0.7.0 clients can read each other's S3 bundles.

## When to sync

The vault is the source of truth. Sync runs are **idempotent** — re-syncing pushes the same KVs again with no side effect (GCP gets a new version of each secret, GitHub overwrites). Typical pattern:

```bash
# Owner: I changed a prod secret.
vsync push production
vsync sync production gh        # push to GitHub Actions
vsync sync production gcp       # … then GCP Secret Manager

# CI: re-sync just to be safe after a deploy.
VSYNC_AUDIT_NOTE="post-deploy resync run-${{ github.run_id }}" \
  vsync sync production gh
```

The audit log records every sync invocation (see [Audit log](/guide/audit)).

---

[Next: Audit log →](/guide/audit)
