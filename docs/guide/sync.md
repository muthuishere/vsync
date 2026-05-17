# Fanout to GitHub / GCP

Once your vault is the source of truth, `vsync sync <env> <target>` pushes the KVs in `<vaultFolder>/.env.<env>` to where production actually runs.

```bash
vsync sync dev gh                       # GitHub Actions repo secrets
vsync sync dev gcp                      # GCP Secret Manager
vsync sync dev all                      # both, sequentially
```

Auth is **outside vsync's scope** — the lib trusts whatever `gh` and `gcloud` are doing on your machine. Make sure you've run `gh auth login` / `gcloud auth login` first.

## `vsync sync <env> gh`

1. Resolves `sync.gh.repo` from per-(repo, env) config (or `--gh-repo` flag, or first-run interactive prompt that saves the answer).
2. Parses `<vaultFolder>/.env.<env>` into push-ready KVs (after the path-expansion and skip rules below).
3. For each KV, in a 6-worker pool: `gh secret set <KEY> --env <env> --repo <sync.gh.repo>` with the value on stdin.
4. Requires `gh` CLI installed and `gh auth login` already done.

## `vsync sync <env> gcp`

1. Resolves `sync.gcp.project` similarly.
2. Same env-file parse.
3. For each KV: `gcloud secrets describe <KEY> --project=<proj>` to check existence; then either `gcloud secrets versions add <KEY> …` (already exists) or `gcloud secrets create <KEY> --replication-policy=automatic …` (new). Value on stdin via `--data-file=-`.
4. Requires `gcloud` CLI installed and `gcloud auth login` done.
5. **Per-env isolation** comes from per-env GCP **projects** (dev project ≠ prod project) — secret names are flat within a project. Don't try to sync dev and prod into the same project.

## `vsync sync <env> all`

Runs both targets in sequence. A per-secret failure on one target doesn't abort the other; final summary lists what failed. **Parse-time failures** (a `*_PATH` / `*_FILE` pointing at a missing file — see below) abort the whole run before any push.

## File references in `.env.<env>` — `*_PATH` and `*_FILE`

Any key in `.env.<env>` whose name ends in `_PATH` or `_FILE` is treated as a **file reference**. Vsync reads the file from disk and pushes its contents as the secret value, under the key with the suffix stripped:

| `.env` entry | What gets pushed | Key on the target |
|---|---|---|
| `SSH_PRIVATE_KEY_PATH=keys/reqsume_dev` | contents of `<vault>/keys/reqsume_dev` | `SSH_PRIVATE_KEY` |
| `GCP_SA_KEY_FILE=keys/sa.json` | contents of `<vault>/keys/sa.json` | `GCP_SA_KEY` |
| `TLS_CERT_PATH=~/certs/foo.pem` | contents of `$HOME/certs/foo.pem` | `TLS_CERT` |
| `BOOTSTRAP_FILE=/etc/foo/bootstrap` | contents of `/etc/foo/bootstrap` | `BOOTSTRAP` |

The rule is: **name the env-file key after the secret you want, with `_PATH` or `_FILE` appended.** No rename table, no special cases.

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

If any `*_PATH` / `*_FILE` references a missing or unreadable file, vsync collects every such error across the whole file and aborts before pushing anything. No partial syncs.

Example error:
```
parseEnvFile: aborting sync — 2 file reference(s) could not be resolved:
  - SSH_PRIVATE_KEY_PATH: file not found at /…/vault/dev/keys/missing
  - DEPLOY_KEY_FILE: file not found at /…/vault/dev/deploy.key
```

## Skip + routing keys

Skipped (used by `gh` / `gcloud` on your local machine — never pushed):

- `GITHUB_TOKEN`
- `GOOGLE_APPLICATION_CREDENTIALS`

Routing metadata (consumed by `vsync sync` itself — never pushed):

- `GITHUB_REPO`
- `GCP_PROJECT_ID`

Everything else is pushed verbatim with the same key name.

## Routing config

`vsync sync` stores routing in the per-(repo, env) config:

- `sync.gh.repo` — `<owner>/<repo>` for GitHub Actions
- `sync.gcp.project` — project ID for GCP Secret Manager

First run prompts and saves. Subsequent runs are zero-prompt. Override per-invocation with `--gh-repo=<owner/name>` or `--gcp-project=<id>`.

## When to sync

The vault is the source of truth. Sync runs are **idempotent** — re-syncing pushes the same KVs again with no side effect (GCP gets a new version of each secret, GitHub overwrites). Typical pattern:

```bash
# Owner: I changed a prod secret.
vsync push production
vsync sync production all       # push to GH + GCP

# CI: re-sync just to be safe after a deploy.
VSYNC_AUDIT_NOTE="post-deploy resync run-${{ github.run_id }}" \
  vsync sync production gh
```

The audit log records every sync invocation (see [Audit log](/guide/audit)).

---

[Next: Audit log →](/guide/audit)
