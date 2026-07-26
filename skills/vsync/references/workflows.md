# Workflows

Command sequences first, prose second. Run one command at a time, confirm
before each. All synopses below match `vsync <sub> --help`.

---

## 1. Owner first-time setup

The user has secrets and wants the team to share them. Nothing exists yet.

```bash
vsync profile add myprofile         # interactive: endpoint, region, bucket, keys
vsync init dev --profile=myprofile  # creates config + AES key + infra/vault/dev/
# user drops .env / JSON keys / certs into infra/vault/dev/
vsync push dev                      # encrypt + upload
```

**Decision point:** which S3 backend. Ask once, up front — it determines the
endpoint they'll type into `profile add`. See `decision-points.md`.

Notes:
- `init` writes a committed `.vsync` file pinning the repo identity. Tell the
  user to commit it — it's what keeps teammates on the same namespace.
- `init` requires `--profile`. If they have no profile yet, `profile add`
  first; there is no inline-credentials path.
- The vault folder defaults to `infra/vault/<env>/` and is gitignored. Don't
  suggest committing it.

After the first push, the natural next step is workflow 2 — onboarding
someone.

---

## 2. Teammate onboarding

Owner side, once per teammate:

```bash
vsync export dev                    # writes ./<repo>-dev.share + prints a passphrase ONCE
```

Then say, every time: **send the file and the passphrase on two different
channels.** The passphrase is printed once and stored nowhere — if the user
loses it, the share file is dead and they must `export` again.

Teammate side:

```bash
vsync import dev ./acme_web-dev.share   # prompts for the passphrase
vsync pull dev                          # download + decrypt into infra/vault/dev/
vsync use dev                           # symlink ./.env -> the vault's .env.dev
```

**Decision point:** where the `.share` file actually landed on their disk.
Ask; don't guess a path.

Three commands, and the app can `dotenv.config()` as normal.

---

## 3. Daily push / pull

```bash
vsync pull dev     # before you start working
vsync push dev     # after you change something
```

No decision point. If `push` reports the remote moved, someone else pushed —
`pull` first, reconcile, push again. Don't reach for `--force` reflexively;
it exists but it discards the divergence check.

`vsync versions dev` lists what's on the bucket; `vsync audit dev` shows who
did what and when.

**Time travel.** Every push is kept forever, so any listed version can be
pulled back:

```bash
vsync versions prod                          # find the timestamp
vsync pull prod --at=20260523-100000 --backup
```

`--at` does *not* move the remote pointer. But warn the user: pushing after
an `--at` pull republishes that old content as the new latest. If they only
want to look at an old value, tell them to copy it out and then
`vsync pull prod` to get back to current.

---

## 4. Production runtime

The app reads the vault at boot via the runtime library — it does not run the
CLI.

```bash
vsync runtime-token --env=prod      # prints a gzip+base64url config blob
```

Paste that into the deployment platform's secret store as `VSYNC_CONFIG`, and
the vault passphrase as `VSYNC_PASSPHRASE`. Both also support the `_FILE`
convention (`VSYNC_CONFIG_FILE`, `VSYNC_PASSPHRASE_FILE`) for platforms that
mount secrets as files.

**Decision point:** which platform. It only changes *where they paste*, not
what they paste.

The app then uses the matching library — Python, TypeScript, Go, or Java —
which fetches and decrypts at `Open()`/boot. Library API lives at
https://muthuishere.github.io/vsync/libraries/ — don't describe it from
memory.

---

## 5. Something broke

Start by finding out which half is missing. Two scopes:

```bash
vsync status            # this repo: envs, profiles, orphans, worktree info
vsync keystore list     # this whole machine: every (repo, env) + key presence
```

`status` is offline-first and reads no network unless `--check-remote`. Read
what it printed *before* proposing anything — see `troubleshooting.md` for the
five common failures and what each looks like.

---

## 6. Fanout to other secret stores

```bash
vsync sync dev gh       # or: gcp | aws | azure | vault
```

Pushes the parsed `.env.<env>` into the target's secret store. Parser policy
is explicit and per-invocation (`--inline-file-suffix=`, `--exclude-property=`,
both repeatable) and prints its active policy before running. Routing lives in
config, not in the env file. Flags differ per target — read
`vsync sync --help` rather than guessing.

---

## 7. Moving to a new machine

```bash
vsync keystore list                                   # what's here?
vsync keystore export --repo=acme_web --env=dev       # or --all
vsync keystore import ./laptop.keytree                # on the new machine
```

Selection is mandatory — `--repo` / `--env` (both repeatable) or `--all`. A
keytree with no selection is refused on purpose, because one file can hold
every key on the machine. Same two-channel rule as `.share`.

`--all` means **everything**: every `(repo, env)` config, its keychain key,
*and* every named profile. Profiles matter — without them the restored
machine can revive existing envs but can't `vsync init` a new one, since
`init` requires `--profile`. A narrowed selection carries no profiles unless
you add `--profiles`.

`import` restores profiles first (configs reference them by name), skips
anything already present, and takes `--force` to overwrite.

After importing, `vsync pull <env>` in each repo to fetch the actual vaults.

---

## 8. Rotating the key

```bash
vsync rotate-passphrase --env=prod
```

Re-encrypts the bundle under a new passphrase, swaps the pointer atomically,
updates this machine's keychain, and writes an audit row.

This is also **offboarding**: rotating invalidates every previously issued
`.share` for future pulls. Re-export for everyone who should still have
access. Note honestly that historical versions on the bucket remain readable
with the old key — rotation protects new data, not old snapshots.
