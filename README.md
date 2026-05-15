# vsync

Encrypted secret-sync CLI for small teams.

- **One canonical store on S3** — your `infra/vault/<env>/` folder, sealed with AES-256-GCM and a manifest pointer that prevents silent rollback.
- **Per-machine encryption key** in the OS keychain (`Bun.secrets` — macOS Keychain, Linux libsecret, Windows Credential Manager).
- **Fanout** to GitHub Repo Secrets and GCP Secret Manager from the same source of truth.
- **Share file** for onboarding teammates with one passphrase-protected `.share` and one passphrase, sent on different channels.

```bash
bunx @muthuishere/vsync --help
```

No shell-rc edits. No giant base64 blob in `~/.zshrc`. Run via `bunx`; nothing to install.

---

## Mental model

Two persistent halves per (repo, env). Both required to push or pull:

```
┌──────────────────────────────────────────────────────────────────┐
│ Disk (chmod 0600)                                                │
│  ~/.config/vsync/<repo>/env_<env>        self-contained config   │
│    ├── s3.{endpoint, region, bucket, …}    required              │
│    ├── encryption.salt                     random per init       │
│    ├── files.vaultFolder                   optional override     │
│    │                                       (default infra/vault/<env>)│
│    └── sync.{gh.repo, gcp.project}         set by `vsync sync`   │
│  ~/.config/vsync/defaults                  pre-fills `init` only │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ OS keychain (Bun.secrets)                                        │
│  service: tools.vsync                                            │
│  account: <repo>/<env>                                           │
│  value:   <base64 32-byte AES-256 key>                           │
└──────────────────────────────────────────────────────────────────┘
```

Anyone with **(S3 read access to the bucket)** AND **(the encryption key in their keychain)** can pull. Either alone is useless: the disk file gets you bucket access but no decrypt; the key gets you decrypt but no bucket location.

The per-repo file is self-contained — `push`/`pull`/`sync` never read a second config. `~/.config/vsync/defaults` is consulted *only* by `init` to pre-fill prompts on subsequent setups.

In your repo, all secret content lives in one place. Default layout:

```
infra/vault/
  dev/
    .env.dev
    some-secret.json
    ...
  production/
    .env.production
```

Apps point dotenv (or equivalent) at the path:

```js
dotenv.config({ path: `infra/vault/${env}/.env.${env}` });
```

`vsync init` prints the dotenv snippet so you copy it once.

**Monorepos:** override the vault folder per (repo, env) at init time — `vsync init dev --vault-folder=apps/foo/infra/vault/dev`. The override is stored per-repo, used by every subsequent `push`/`pull`/`sync`, and carried in the `.share` file so teammates inherit it.

---

## Install

You don't. Run via `bunx`:

```bash
bunx @muthuishere/vsync <subcommand>
```

Requires Bun ≥ 1.2.21 (for `Bun.secrets`). For local development of vsync itself:

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
bunx @muthuishere/vsync init dev

# 2. Put your secrets under infra/vault/dev/ and push.
echo "DATABASE_URL=postgres://..." > infra/vault/dev/.env.dev
bunx @muthuishere/vsync push dev

# 3. Hand the team a share file + passphrase (different channels).
bunx @muthuishere/vsync export dev
```

For an onboarding cheat sheet to drop into your repo (so teammates and AI agents know vsync exists), run `vsync docs > infra/AGENTS.md`. Plain stdout — pipe it wherever you want.

## Quickstart — teammate (joining the project)

```bash
cd <cloned-repo>

# 1. Import the share file your teammate sent (carries S3 creds + key).
#    No prior `init` required on this machine.
bunx @muthuishere/vsync import dev ./reqsume-dev.share
# Passphrase: <paste>

# 2. Pull the encrypted bundle.
bunx @muthuishere/vsync pull dev
```

After step 2, `infra/vault/dev/` is populated and the encryption key is in your keychain.

## Daily flow

```bash
# I edited infra/vault/dev/.env.dev locally:
bunx @muthuishere/vsync push dev

# Get the latest from S3:
bunx @muthuishere/vsync pull dev

# See what versions exist on S3:
bunx @muthuishere/vsync versions dev

# Push secrets out to GitHub / GCP:
bunx @muthuishere/vsync sync dev gh
bunx @muthuishere/vsync sync dev gcp
bunx @muthuishere/vsync sync dev all
```

`pull` makes a local backup at `~/.config/vsync/backups/<env>-<ts>.zip.enc` before overwriting (two-deep rolling buffer). See "Recovering a local backup" below if you ever need one.

---

## Subcommand reference

All commands accept `--repo=<name>` (override auto-detected repo name) and `--interactive` (force prompts even when every flag is provided). Auto-detected repo precedence: `$SECRETS_SYNC_REPO` → `package.json::name` (scope-stripped) → git toplevel basename → cwd basename.

Every command works fully via flags or fully via prompts.

| Cmd | Purpose |
|---|---|
| `init <env>` | Generate AES key (→ keychain), write self-contained per-repo config, create the resolved vault folder, relocate an existing root `.env.<env>` if found (with a prompt). First-ever run on a machine also writes `~/.config/vsync/defaults` from the supplied values; subsequent runs pre-fill from defaults. Flags: `--bucket --endpoint --region --access-key --secret-key --use-ssl --vault-folder=<path> --migrate-from=<path> --no-migrate`. |
| `export <env>` | Write a passphrase-encrypted `.share` file containing the full per-repo config + key. Flags: `--out=<path>` (default `./<repo>-<env>.share`), `--passphrase=<p>` (default: auto-generated readable passphrase). |
| `import <env> <file>` | Decrypt a `.share` file with its passphrase; write the per-repo config + save key to keychain. Idempotent — re-importing overwrites. Flags: `--passphrase=<p>`, `--file=<path>` (alt to positional). |
| `push <env>` | Zip the resolved vault folder → manifest-seal → AES-256-GCM encrypt → upload to `s3://<bucket>/<env>/versions/<ts>.enc`, then update `s3://<bucket>/<env>/latest`. |
| `pull <env>` | Read `latest` pointer → download version → verify embedded manifest timestamp matches pointer (anti-rollback) → decrypt → unzip into the resolved vault folder. Auto-backs up existing contents first. |
| `versions <env>` | List `s3://<bucket>/<env>/versions/`. One line per version with size + age, `* latest` marker on the active one. Read-only; no decrypt. |
| `sync <env> <gh\|gcp\|all>` | Read `<vaultFolder>/.env.<env>` → push each KV to the named target. Parallel (6 workers, 10-min timeout). First run prompts for routing config (gh repo / gcp project) and saves it; subsequent runs zero-prompt. Flags: `--gh-repo=<owner/name>`, `--gcp-project=<id>`. |
| `docs` | Print a short onboarding reference (commands, vault layout, backup recovery procedure) to stdout. Pipe wherever you want — e.g. `vsync docs > infra/AGENTS.md`. |

### `sync` env-file parsing

Two special-case keys (path → file content inlining):

- `GCP_SA_KEY_FILE_PATH=<path>` → reads the file, pushes the contents as `GCP_SA_KEY` (must look like JSON).
- `SSH_KEY_PATH=<path>` → reads the file, pushes as `SSH_PRIVATE_KEY`.

Two local-only keys (skipped — used by `gh` / `gcloud` on the local machine, not pushed):

- `GITHUB_TOKEN`
- `GOOGLE_APPLICATION_CREDENTIALS`

Everything else is pushed verbatim.

---

## How sync works (gh + gcp)

Auth is **outside vsync's scope** — the lib trusts whatever `gh` and `gcloud` are doing on your machine.

**`vsync sync <env> gh`:**
1. Resolves `sync.gh.repo` from per-repo config (or `--gh-repo` flag, or first-run prompt).
2. Parses `<vaultFolder>/.env.<env>` into push-ready KVs (after special-case + skip rules).
3. For each KV in a 6-worker pool: `gh secret set <KEY> --env <env> --repo <sync.gh.repo>` with the value on stdin.
4. Requires `gh` CLI installed and `gh auth login` already done.

**`vsync sync <env> gcp`:**
1. Resolves `sync.gcp.project` similarly.
2. Same parse step.
3. For each KV: `gcloud secrets describe <KEY> --project=<proj>` to check existence; either `gcloud secrets versions add <KEY>` (exists) or `gcloud secrets create <KEY> --replication-policy=automatic` (new). Value on stdin via `--data-file=-`.
4. Requires `gcloud` CLI installed and `gcloud auth login` done. Per-env isolation comes from per-env GCP projects (dev project ≠ prod project) — secret names are flat within a project.

**`vsync sync <env> all`** runs both in sequence. Failures don't abort siblings; final summary lists what failed.

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

This is **0.3.0** — a clean break from `@muthuishere/secret-lib` 0.2.x. New package name, new bin (`vsync`), new keychain service (`tools.vsync`), new config root (`~/.config/vsync/`), new vault layout (`infra/vault/<env>/.env.<env>`). The crypto envelope (`RQE1`) is unchanged.

0.3.x does not auto-migrate from 0.2.x. The supported upgrade path is to re-`init` from scratch:

```bash
vsync init dev          # auto-relocates root .env.dev if it exists
vsync push dev
vsync export dev        # re-share with team
```

Any leftover 0.2.x on-disk config tree and keychain entries can be deleted; nothing in 0.3.x reads them. `@muthuishere/secret-lib` 0.2.x stays on npm for users who can't migrate.

---

## License

MIT.
