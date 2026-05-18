# vsync

**One encrypted vault for your environment secrets, shared across your team, mirrored to GitHub / GCP / AWS / Azure / HashiCorp Vault, audited every time someone touches it.**

![vsync flow](https://raw.githubusercontent.com/muthuishere/vsync/main/docs/public/vsync-flow.png)

A `.env` file is the friendliest thing in your repo: one line per secret, edited by hand, loaded by every framework. It's also the worst thing in your repo — passed around on Slack, copy-pasted into the wrong window, never the same on any two laptops, **never encrypted, never versioned, never auditable**. The moment one teammate's secrets drift from another's, you stop trusting `.env` and start emailing JSON files.

vsync keeps the `.env` you already write, and turns it into a real vault:

- **One folder per environment.** Anything secret — `.env.dev`, `gcp-sa.json`, TLS certs, regression fixtures, signing keys — lives under `infra/vault/<env>/`. No naming convention to learn; whatever is in there gets sealed.
- **Encrypted bucket as the canonical store.** `vsync push <env>` zips the folder, seals it with AES-256-GCM + manifest-anti-rollback, uploads to any S3-compatible bucket: **AWS S3, Hetzner Object Storage, self-hosted MinIO, Cloudflare R2, Backblaze B2**. The bucket holds the only blessed copy.
- **One-passphrase onboarding.** New teammate runs `vsync import dev <file>.share`, types the passphrase you sent on a separate channel, runs `vsync pull dev`. Done. No shell-rc edits, no env-var blobs, no key sharing in Slack DMs.
- **Fanout to where prod actually runs.** `vsync sync dev <target>` pushes the same `.env.<env>` keys to GitHub Actions secrets, GCP Secret Manager, AWS Secrets Manager, Azure Key Vault, or HashiCorp Vault KV v2. One edit in the vault; every place that needs the secret stays in step.
- **Append-only audit log.** Every push/pull/import/export records `who, where, when, version, free-form note` to a CSV on the bucket. `vsync audit dev` prints it. CI passes `--note="run #1234"` and it shows up.
- **Per-machine key in the OS keychain.** `Bun.secrets` — macOS Keychain, Linux libsecret, Windows Credential Manager. The S3 bucket alone is useless; the key alone is useless. Both halves required to decrypt.

```bash
bun  install -g @muthuishere/vsync     # or:  npm install -g @muthuishere/vsync
vsync --help
```

One global install, then `vsync` is on PATH. No shell-rc edits, no giant base64 blob in `~/.zshrc`. (Allergic to global installs? `bunx @muthuishere/vsync <subcommand>` works too — same code path, slower invocation.)

---

## What lives in the vault

Whatever your app needs at runtime that you'd otherwise scatter across Slack DMs, a password manager, or `~/Downloads/`:

```
infra/vault/
  dev/
    .env.dev                  # KV secrets — vsync sync ships these to gh/gcp/aws/azure/vault
    gcp-sa.json               # JSON service account key
    regression-fixture.json   # test data that mirrors prod shape
    tls/cert.pem
    tls/key.pem
  production/
    .env.production
    gcp-sa.json
```

vsync doesn't care what's in there — it zips and seals the whole folder. The `.env.<env>` file is special only in that `vsync sync` reads it for KV fanout to GitHub / GCP / AWS / Azure / Vault. Everything else (JSON keys, certs, regression fixtures, anything binary) just rides along in the encrypted bundle and lands back on every teammate's disk after `pull`.

So regression tests, scripts, or any tool that needs real-shape inputs read directly from `infra/vault/<env>/whatever.json` — no separate test-data dance.

For monorepos, override per-(repo, env): `vsync init dev --vault-folder=apps/foo/infra/vault/dev`. The path is stored in the per-repo config and carried in the `.share` file so teammates inherit it automatically.

---

## Switching environments — `vsync use`

So apps don't need to know vault paths, `vsync use <env>` creates a symlink that points the conventional `.env` location at the vault's env file:

```bash
vsync use dev                          # ./.env → infra/vault/dev/.env.dev
vsync use production                   # repoint to infra/vault/production/.env.production
vsync use                              # print current target
```

Any framework reading `.env` (Vite, Next.js, Bun, dotenv, every Python lib) just works — no path argument, no custom loader. Switch environments with one command; restart your dev server and you're running against the new env.

**Pick a different link name or location** with `--link=<path>` — useful when you already have a `.env`, want the conventional `.env.<env>` name, or work in a monorepo:

```bash
vsync use dev  --link=.env.dev          # ./.env.dev → infra/vault/dev/.env.dev
vsync use prod --link=apps/web/.env     # apps/web/.env → … (monorepo)
```

**Safety:** if the link path already exists as a *regular file*, vsync refuses to touch it — no `--force`, by design. Move or delete it first (`mv .env .env.local.bak`) and re-run. An existing *symlink* at that path is replaced silently (symlinks are cheap to recreate). vsync also warns if the link's basename isn't covered by `.gitignore`.

**Platform support:** POSIX symlinks on macOS / Linux / WSL out of the box. On Windows it uses the same call with `type: "file"` — requires Developer Mode (Settings → Privacy & security → For developers) or an elevated terminal. vsync prints actionable guidance if the privilege is missing.

---

## Mental model

Every (repo, env) is held by **two persistent halves**. Both required to push or pull; either one alone is useless.

```
┌──────────────────────────────────────────────────────────────────┐
│ Disk (chmod 0600)                                                │
│  ~/.config/vsync/<repo>/env_<env>        self-contained config   │
│    ├── s3.{endpoint, region, bucket, …}    where to find bytes   │
│    ├── encryption.salt                     PBKDF2 input          │
│    ├── files.vaultFolder                   optional override     │
│    └── sync.{gh, gcp, aws, azure, vault}   set by `vsync sync`   │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ OS keychain (Bun.secrets)                                        │
│  service: tools.vsync                                            │
│  account: <repo>/<env>                                           │
│  value:   <base64 32-byte AES-256 key>                           │
└──────────────────────────────────────────────────────────────────┘
```

The disk file gets you bucket access — no decrypt. The keychain key gets you decrypt — no bucket location. Stealing one is a non-event; you need both to read a single secret. Offboarding cuts the bucket side (the cloud provider's IAM), then `vsync init` mints a fresh key for the team that stays.

A `.share` file bundles **both halves** under one passphrase. Sent on a different channel than the passphrase itself, it's the smallest possible onboarding step.

---

## Install

```bash
bun install -g @muthuishere/vsync     # or:  npm install -g @muthuishere/vsync
vsync --help
```

Requires Bun ≥ 1.2.21 on PATH (for `Bun.secrets`) — the shebang is `#!/usr/bin/env bun`, so `bun` must be installed even if you used `npm install -g` for the package itself. Most users have Bun anyway; if not, see [bun.sh](https://bun.sh).

Don't want to install? `bunx @muthuishere/vsync <subcommand>` runs the same code from npm cache each time — fine for trying it out, slower for daily use.

For local development of vsync itself:

```bash
git clone git@github.com:muthuishere/vsync.git
cd vsync
bun install
bun test
```

---

## Quickstart — owner (first time on a project)

```bash
# 1. Generate the per-(repo, env) key + config. First-ever invocation prompts
#    for S3 creds; subsequent inits pre-fill from ~/.config/vsync/defaults.
vsync init dev

# 2. Put your secrets under infra/vault/dev/ and push.
echo "DATABASE_URL=postgres://..." > infra/vault/dev/.env.dev
vsync push dev

# 3. Hand the team a share file + passphrase (different channels).
vsync export dev
```

For an onboarding cheat sheet to drop into your repo (so teammates and AI agents know vsync exists), run `vsync docs > infra/AGENTS.md`. Plain stdout — pipe it wherever you want.

## Quickstart — teammate (joining the project)

```bash
cd <cloned-repo>

# 1. Import the share file your teammate sent (carries S3 creds + key).
#    No prior `init` required on this machine.
vsync import dev ./reqsume-dev.share
# Passphrase: <paste>

# 2. Pull the encrypted bundle.
vsync pull dev
```

After step 2, `infra/vault/dev/` is populated and the encryption key is in your keychain.

## Daily flow

```bash
# I edited infra/vault/dev/.env.dev locally:
vsync push dev

# Get the latest from S3:
vsync pull dev

# See what versions exist on S3:
vsync versions dev

# Push secrets out — one target per invocation:
vsync sync dev gh                       # GitHub Actions repo secrets
vsync sync dev gcp                      # GCP Secret Manager
vsync sync dev aws                      # AWS Secrets Manager
vsync sync dev azure                    # Azure Key Vault
vsync sync dev vault                    # HashiCorp Vault KV v2
```

One target per `vsync sync` invocation — if you need more than one, run more than one command. `pull` makes a local backup at `~/.config/vsync/backups/<env>-<ts>.zip.enc` before overwriting (two-deep rolling buffer). See "Recovering a local backup" below if you ever need one.

---

## Subcommand reference

All commands accept `--repo=<name>` (override auto-detected repo name) and `--interactive` (force prompts even when every flag is provided). Auto-detected repo precedence: `$SECRETS_SYNC_REPO` → `package.json::name` (scope-stripped) → git toplevel basename → cwd basename.

Every command works fully via flags or fully via prompts.

| Cmd | Purpose |
|---|---|
| `init <env>` | Generate AES key (→ keychain), write self-contained per-repo config, create the resolved vault folder, relocate an existing root `.env.<env>` if found (with a prompt). First-ever run on a machine also writes `~/.config/vsync/defaults` from the supplied values; subsequent runs pre-fill from defaults. Flags: `--bucket --endpoint --region --access-key --secret-key --use-ssl --vault-folder=<path> --migrate-from=<path> --no-migrate --audit=on\|off`. |
| `export <env>` | Write a passphrase-encrypted `.share` file containing the full per-repo config + key. Flags: `--out=<path>` (default `./<repo>-<env>.share`), `--passphrase=<p>` (default: auto-generated readable passphrase), `--no-audit`, `--note=<text>`, `--meta key=value` (repeatable). |
| `import <env> <file>` | Decrypt a `.share` file with its passphrase; write the per-repo config + save key to keychain. Idempotent — re-importing overwrites. Flags: `--passphrase=<p>`, `--file=<path>` (alt to positional), `--no-audit`, `--note=<text>`, `--meta key=value` (repeatable). |
| `use <env>` | Symlink the chosen path → `<vaultFolder>/.env.<env>` so plain `dotenv.config()` works without a path arg. Default link path is `./.env`; override with `--link=<path>` (e.g. `--link=.env.dev` or `--link=apps/web/.env`). `vsync use` with no env prints the current target. **Refuses to touch an existing regular file at the link path — no `--force`, by design.** Replaces an existing symlink silently. Warns if the link's basename isn't `.gitignore`d. POSIX symlinks everywhere; Windows requires Developer Mode or an elevated terminal. |
| `push <env>` | Zip the resolved vault folder → manifest-seal → AES-256-GCM encrypt → upload to `s3://<bucket>/<repo>/<env>/versions/<ts>.enc`, then update `s3://<bucket>/<repo>/<env>/latest`. Flags: `--no-audit`, `--note=<text>`, `--meta key=value` (repeatable). |
| `pull <env>` | Read `latest` pointer → download version → verify embedded manifest timestamp matches pointer (anti-rollback) → decrypt → unzip into the resolved vault folder. Auto-backs up existing contents first. Flags: `--no-audit`, `--note=<text>`, `--meta key=value` (repeatable). |
| `versions <env>` | List `s3://<bucket>/<repo>/<env>/versions/`. One line per version with size + age, `* latest` marker on the active one. Read-only; no decrypt. |
| `sync <env> <gh\|gcp\|aws\|azure\|vault>` | Read `<vaultFolder>/.env.<env>` → push each KV to the named target. **One target per invocation** — if you need more than one, run more than one command. gh / gcp / aws / azure run in a 6-worker pool (10-min timeout); `vault` writes the whole map in a single atomic `vault kv put` (KV v2 is path-atomic). First run for a given target prompts for routing config and saves it; subsequent runs zero-prompt. Parser has no defaults — pass `--inline-file-suffix=<suf>` and `--exclude-property=<key>` (both repeatable) to control file inlining and excluded keys; see "Typical `vsync sync` invocation" below. Flags: `--inline-file-suffix=<suf>`, `--exclude-property=<key>`, `--gh-repo=<owner/name>`, `--gcp-project=<id>`, `--aws-region=<region>`, `--aws-secret-prefix=<prefix>`, `--azure-vault=<vault-name>`, `--vault-addr=<url>`, `--vault-mount=<mount>`, `--vault-path=<path>`. |
| `audit <env>` | Print the S3-side audit log: who/where/when of every pull/push/import/export. Flags: `--limit=N`, `--all`, `--csv`. |
| `docs` | Print a short onboarding reference (commands, vault layout, backup recovery procedure) to stdout. Pipe wherever you want — e.g. `vsync docs > infra/AGENTS.md`. |

### `sync` env-file parsing

As of v0.7 the parser has **zero implicit policy** — no hardcoded suffixes, no hardcoded exclude list, no defaults applied by the CLI. Every rule is named at the call site.

**File references — opt in with `--inline-file-suffix=<suf>` (repeatable).** Any key in `.env.<env>` whose name ends in a configured suffix is read from disk; vsync pushes the file's contents under the key with the suffix stripped. Pass `--inline-file-suffix=_PATH --inline-file-suffix=_FILE` for the v0.6 shape:

- `SSH_PRIVATE_KEY_PATH=keys/reqsume_dev` → pushes `<vault>/keys/reqsume_dev` as `SSH_PRIVATE_KEY`.
- `GCP_SA_KEY_FILE=keys/sa.json` → pushes `<vault>/keys/sa.json` as `GCP_SA_KEY`.

Relative paths anchor to `VAULT_ROOT` (the directory of the env file being parsed). Placeholders `${VAULT_ROOT}`, `${HOME}`, and leading `~/` are expanded in every value. Any missing or unreadable referenced file aborts the whole sync before any push (all-or-none).

**Excluded keys — opt in with `--exclude-property=<key>` (repeatable).** Any key in this list is dropped from the run and never pushed. Typical candidates are tokens that exist locally for `gh` / `gcloud` to use directly:

- `GITHUB_TOKEN`
- `GOOGLE_APPLICATION_CREDENTIALS`

If you pass no `--exclude-property` flag at all, **nothing is skipped** — every KV gets pushed. Same for `--inline-file-suffix`: with no flag, no file inlining happens.

Every `vsync sync` run prints the active parser policy header before the first push, so you can see exactly which rules were in effect. Full convention in [`docs/guide/sync.md`](docs/guide/sync.md) and design context in [`docs/specs/v0.7-explicit-sync-parser.md`](docs/specs/v0.7-explicit-sync-parser.md).

### Typical `vsync sync` invocation

The parser has no defaults. Pass the rules you want, every time. The shape
that matches v0.6 behavior is:

```bash
vsync sync dev gh \
  --inline-file-suffix=_PATH \
  --inline-file-suffix=_FILE \
  --exclude-property=GITHUB_TOKEN \
  --exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

Drop this into your Taskfile / Makefile / CI so the call site shows the
whole policy at a glance.

**Migrating from v0.6?** Bare `vsync sync dev gh` no longer skips `GITHUB_TOKEN` / `GOOGLE_APPLICATION_CREDENTIALS` and no longer inlines `*_PATH` / `*_FILE`. Append the four flags above to every invocation to preserve the old behavior. The in-env routing keys `GITHUB_REPO` / `GCP_PROJECT_ID` are also no longer recognized — move them into config via `--gh-repo` / `--gcp-project` (persisted) and delete the lines from `.env.<env>`. See [`docs/specs/v0.7-explicit-sync-parser.md`](docs/specs/v0.7-explicit-sync-parser.md) §5 for full migration steps.

### Audit log

Every `pull`, `push`, `import`, and `export` appends a row to `s3://<bucket>/<repo>/<env>/audit.csv` so the team can see who did what, from where, and when. Columns:

- `ts, action, version_ts, hostname, local_ip, os_user, git_email, vsync_version, bun_version, meta`

On by default. Skip a single invocation with `--no-audit`. Disable per (repo, env) with `vsync init <env> --audit=off` (or pick "off" at the first-time prompt).

Tag any row with free-form context via `--note=<text>` (sugar for `--meta note=<text>`) or `--meta key=value` (repeatable). The matching env vars `VSYNC_AUDIT_NOTE` and `VSYNC_AUDIT_META` (a JSON object) merge in for CI ergonomics. Example one-liner:

```bash
VSYNC_AUDIT_META='{"run_id":"7891234","commit":"abc123"}' \
  vsync pull production --note="prod deploy" --meta ticket=BUG-42
```

View the log with `vsync audit <env>` (`--limit=N`, `--all`, `--csv`).

Two honesty bullets:

- This is a transparency aid, not tamper-proof. Anyone with bucket write can rewrite the CSV; vsync just makes honest activity legible.
- The log does not let you reclaim already-pulled secrets. Once a teammate has pulled, they hold a local copy — rotate the key to invalidate future pulls.

---

## How sync works (gh + gcp + aws + azure + vault)

Auth is **outside vsync's scope** — the lib trusts whatever `gh`, `gcloud`, `aws`, `az`, and `vault` are doing on your machine.

**`vsync sync <env> gh`:**
1. Resolves `sync.gh.repo` from per-repo config (or `--gh-repo` flag, or first-run prompt).
2. Parses `<vaultFolder>/.env.<env>` into push-ready KVs (using the `--inline-file-suffix` / `--exclude-property` flags you passed — see below).
3. For each KV in a 6-worker pool: `gh secret set <KEY> --env <env> --repo <sync.gh.repo>` with the value on stdin.
4. Requires `gh` CLI installed and `gh auth login` already done.

**`vsync sync <env> gcp`:**
1. Resolves `sync.gcp.project` similarly.
2. Same parse step.
3. For each KV: `gcloud secrets describe <KEY> --project=<proj>` to check existence; either `gcloud secrets versions add <KEY>` (exists) or `gcloud secrets create <KEY> --replication-policy=automatic` (new). Value on stdin via `--data-file=-`.
4. Requires `gcloud` CLI installed and `gcloud auth login` done. Per-env isolation comes from per-env GCP projects (dev project ≠ prod project) — secret names are flat within a project.

**`vsync sync <env> aws`:**
1. Resolves `sync.aws.region` (required) and `sync.aws.secretPrefix` (optional) from per-repo config (or `--aws-region` / `--aws-secret-prefix` flags, or first-run prompt).
2. Same parse step.
3. For each KV in a 6-worker pool: `aws secretsmanager describe-secret --secret-id <prefix><KEY> --region <region>`; either `put-secret-value` (exists) or `create-secret` (new). Value via stdin (`--secret-string fileb:///dev/stdin`).
4. Requires `aws` CLI installed and credentials available — `aws configure`, `aws sso login`, or `AWS_*` env vars.

**`vsync sync <env> azure`:**
1. Resolves `sync.azure.vaultName` from per-repo config (or `--azure-vault` flag, or first-run prompt). Pass the vault **name**, not the URL.
2. Same parse step.
3. For each KV in a 6-worker pool: `az keyvault secret set --vault-name <vault> --name <KEY> --file /dev/stdin` — idempotent (creates or versions in one call).
4. Requires `az` CLI installed and `az login` done. **Naming constraint:** Azure Key Vault only allows `0-9 A-Z a-z -`. Underscores fail at push time; vsync does not silently translate `_` → `-` (no-magic theme). Rename keys, `--exclude-property` them, or maintain an Azure-shaped env file.

**`vsync sync <env> vault`:**
1. Resolves `sync.vault.addr`, `sync.vault.mount`, and `sync.vault.secretPath` (all required) from per-repo config (or `--vault-addr` / `--vault-mount` / `--vault-path` flags, or first-run prompt).
2. Same parse step.
3. **Single bulk write — the 6-worker pool is bypassed.** All KVs land in one atomic call: `VAULT_ADDR=<addr> vault kv put -mount=<mount> <secretPath> KEY1=value1 KEY2=value2 …`. KV v2 is path-atomic — either the whole map lands or none of it does.
4. Requires `vault` CLI installed and `vault login` already done (token in `~/.vault-token`). KV v2 only; KV v1 / Transit / PKI / namespaces are out of scope.

**One target per invocation** as of v0.7.1 — if you need more than one, run more than one command. For gh / gcp / aws / azure, per-secret push failures within a single run don't abort siblings; the final summary lists what failed. `vault` is all-or-nothing per invocation (atomic). Parse-time failures (see "all-or-none" below) abort the whole run before any push for every target.

Every run also prints the active parser policy header before the first push, so the operator can see which suffixes and exclusions were in effect for this invocation.

### File-reference convention (`.env.<env>`) — explicit opt-in

Vsync reads each line of `.env.<env>` and pushes a KV to the chosen target (gh / gcp / aws / azure / vault). When you pass `--inline-file-suffix=<suffix>`, keys ending in that suffix are treated as file paths — vsync reads the file and pushes its bytes under the stripped name.

With `--inline-file-suffix=_PATH --inline-file-suffix=_FILE` in effect:

| In env file | Pushed as | Notes |
|---|---|---|
| `FOO_PATH=keys/foo` | `FOO` = file contents | suffix `_PATH` stripped; file resolved vault-relative |
| `FOO_FILE=keys/foo` | `FOO` = file contents | suffix `_FILE` stripped; same resolution |
| `SSH_PRIVATE_KEY_PATH=keys/dev` | `SSH_PRIVATE_KEY` = file contents | name the env-file key after the secret you want |

With no `--inline-file-suffix` flag, no inlining happens — `FOO_PATH=keys/foo` is pushed as the literal string `keys/foo`.

With `--exclude-property=GITHUB_TOKEN --exclude-property=GOOGLE_APPLICATION_CREDENTIALS` in effect, those keys are dropped from the run. With no `--exclude-property` flag, nothing is skipped.

**Path resolution.** Relative paths anchor to `VAULT_ROOT` (the directory of the env file being parsed). Three forms of placeholder expansion are recognised in **every** value — file-ref or plain:

| Form | Means |
|---|---|
| `${VAULT_ROOT}/keys/foo` | `<vault>/keys/foo` (explicit) |
| `keys/foo` or `./keys/foo` | `<vault>/keys/foo` (implicit — no placeholder needed) |
| `~/.ssh/id_rsa` or `${HOME}/.ssh/id_rsa` | `$HOME/.ssh/id_rsa` |
| `/abs/path` | absolute, pass-through |

**All-or-none on file refs.** If any configured file-ref references a missing or unreadable file, vsync collects every such error and aborts before pushing anything. No partial syncs.

The canonical short-form reference lives in the header comment of [`src/envfile.ts`](src/envfile.ts); design context is in [`docs/specs/v0.7-explicit-sync-parser.md`](docs/specs/v0.7-explicit-sync-parser.md).

---

## Security model

| Threat | Defence |
|---|---|
| Attacker reads disk config only | Gets bucket creds + routing. Cannot decrypt any S3 bundle. |
| Attacker reads keychain only | Gets the AES key. No bucket location. No reach. |
| Attacker reads both | Compromises the (repo, env). Rotate immediately. |
| Attacker intercepts the `.share` file | Cannot decrypt without the passphrase. Mitigation: send file + passphrase on different channels. |
| Attacker tampers with an S3 object | Pull-time manifest-pointer check (`embeddedTs === remoteTs`) rejects renamed-old-bundles. AES-GCM auth tag rejects byte-level tampering. |
| Local user on shared machine | `chmod 0600` on the file + `0700` on the dir = POSIX denies other users. macOS Keychain ACLs deny other login sessions. |

**Crypto:** AES-256-GCM with a per-encryption 12-byte random IV. Envelope magic `RQE1`. PBKDF2-SHA256 (600k iters) over (keychain-key, per-repo salt) for the S3 envelope, and over (user passphrase, share-file salt) for the share-file wrapper. Manifest pointer-seal magic `RQEM0001`. Share file outer frame magic `SLS1`.

**Offboarding:** there's no per-user revoke. When someone leaves: revoke their bucket access at the cloud provider (separate axis), then rotate the encryption key by re-`init`-ing the (repo, env) and re-`export`-ing for surviving teammates. Per-user audit and a built-in `rotate-key` are explicitly out of scope.

**Inspecting / removing the keychain entry** is done with your OS tools — Keychain Access.app on macOS, `secret-tool` / `seahorse` on Linux, Credential Manager on Windows. vsync doesn't ship verbs to wrap those.

---

## Recovering a local backup

Before each `pull`, vsync writes the existing vault folder to `~/.config/vsync/backups/<env>-<ts>.zip.enc` (two-deep rolling buffer). The format is AES-256-GCM with the same per-(repo, env) keychain key + salt. To decrypt one by hand:

1. Get the key — on macOS: `security find-generic-password -s tools.vsync -a <repo>/<env> -w`. On Linux: `secret-tool lookup service tools.vsync account <repo>/<env>`.
2. Get the salt: `gunzip -c ~/.config/vsync/<repo>/env_<env> | jq -r .encryption.salt`.
3. The envelope is `RQE1` (4-byte magic) + 12-byte IV + AES-GCM ciphertext. Derive: `AES-GCM key = PBKDF2-SHA256(keychain-key, salt, 600k)`.

In practice, just don't lose the keychain entry. `pull` itself is the recovery path 99% of the time.

---

## Troubleshooting

**"no config file for `<repo>/<env>`"** — the per-repo file isn't on disk. Run `vsync init <env>` to create one, or `vsync import <env> <share-file>` if a teammate sent you one.

**"encryption key for `<repo>/<env>` not found in keychain"** — the file exists but the keychain entry is gone. Re-run `import` (carries both halves), or re-`init` if you don't have a `.share` (generates a fresh key, so any prior S3 bundle becomes inaccessible to you — re-`push` from local).

**"failed to decrypt share file — passphrase wrong or file corrupt"** — double-check the passphrase. If still failing, ask the sender to re-export.

**"pointer claims X but bundle was sealed as Y" during pull** — defensive anti-rollback check failed. Someone with bucket-write access pointed `latest` at a renamed older bundle, but the embedded manifest timestamp doesn't match. Refuse + report to ops.

**`gh` / `gcloud` not found on PATH** — install and authenticate them locally. vsync shells out; it doesn't manage external CLI auth.

---

## Versioning

| Release | What's in it |
|---|---|
| **0.8.0** | Three new `vsync sync` targets: `aws` (AWS Secrets Manager), `azure` (Azure Key Vault), `vault` (HashiCorp Vault KV v2). Dispatcher rewritten around a `TargetHandler` registry — `gh` / `gcp` move into the registry unchanged, three new handlers land alongside. **Purely additive — every 0.7.x invocation works byte-for-byte in 0.8.0.** New flags per target: `--aws-region`, `--aws-secret-prefix`, `--azure-vault`, `--vault-addr`, `--vault-mount`, `--vault-path`. gh / gcp / aws / azure share the 6-worker pool; `vault` writes the whole map in one atomic `vault kv put`. Wire format / audit log / parser policy unchanged. See [`docs/specs/v0.8-multi-target-sync.md`](docs/specs/v0.8-multi-target-sync.md). |
| 0.7.1 | `vsync sync <env> all` removed. Only `gh` and `gcp` remained as 0.7 targets; one target per invocation. (Now joined by `aws`, `azure`, `vault` in 0.8 — still one target per invocation.) |
| 0.7.0 | `vsync sync` parser has zero implicit policy. New repeatable flags `--inline-file-suffix=<suf>` and `--exclude-property=<key>` replace the old hardcoded `_PATH` / `_FILE` suffixes and the implicit `GITHUB_TOKEN` / `GOOGLE_APPLICATION_CREDENTIALS` skip-list — name every rule at the call site. In-env routing keys `GITHUB_REPO` / `GCP_PROJECT_ID` are no longer recognized (routing lives in config only). Every run prints the active policy header before pushing. Two intentional breaks vs. 0.6.x — see [`docs/specs/v0.7-explicit-sync-parser.md`](docs/specs/v0.7-explicit-sync-parser.md) §5. |
| 0.6.0 | `.env.<env>` file-reference convention: any key ending in `_PATH` / `_FILE` is read from disk and the file's contents are pushed under the stripped name. Paths anchor to `VAULT_ROOT`; `${VAULT_ROOT}` / `${HOME}` / `~/` placeholders work in every value. All-or-none on missing files. (Superseded in 0.7 — suffixes are no longer hardcoded; pass `--inline-file-suffix` explicitly.) |
| 0.5.0 | `vsync use <env>` — symlinks `./.env` (or `--link=<path>`) at the vault's env file so `dotenv.config()` just works; switch envs with one command. README rewrite + flow diagram. |
| 0.4.0 | Append-only audit log at `s3://<bucket>/<repo>/<env>/audit.csv` + `vsync audit` viewer. Expandable `meta` JSON cell via `--note` / `--meta` + matching env vars. |
| 0.3.0 | Opinionated layout: vault folder at `infra/vault/<env>/` with `--vault-folder` override; self-contained per-(repo, env) config; `vsync sync` for GitHub / GCP fanout. |

All 0.x releases are wire-compatible with each other on the S3 bundle envelope (`RQE1`) and manifest seal (`RQEM0001`). New clients tolerate the absence of features added in later versions; old clients ignore new objects (like `audit.csv`) on the bucket.

---

## License

MIT.
