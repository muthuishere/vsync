# secret-lib

Encrypted env-sync CLI for repos.

- **Config file** for one (repo, env) lives at `~/.config/deemwar/config/<repo>/env_<env>` (gzipped JSON, `0600`).
- **Encryption key** lives in the OS keychain (macOS Keychain / Linux libsecret / Windows Credential Manager), via [`Bun.secrets`](https://bun.com/reference/bun/secrets).
- **Bundle on S3** = your `.env` + a vault folder, sealed with AES-256-GCM (PBKDF2-SHA256, 600k iterations) + a manifest pointer so the bucket can't be silently rolled back.

No shell rc edits. No giant base64 blobs in your `~/.zshrc`. Share configs between teammates with one file + one passphrase, sent on different channels.

```bash
bunx @muthuishere/secret-lib --help
```

## Start here

- **Setting up a new repo?** → [`onboarding.md`](./onboarding.md) — `initapp`, init the env, push the first bundle, share with the team.
- **Joining an existing repo?** → [`using.md`](./using.md) — receive a `.share` file + passphrase from a teammate, run `import`, then `pull`.
- **Want a copy-paste Taskfile?** → [`examples/Taskfile.yml`](./examples/Taskfile.yml) — drop into `infra/setup/Taskfile.yml`, customise envs, done. Or run `bunx @muthuishere/secret-lib initapp` and it'll scaffold everything for you.

## Install

You don't. Just run via `bunx`:

```bash
bunx @muthuishere/secret-lib --help
```

For local development of the library itself:

```bash
git clone git@github.com:muthuishere/secret-lib.git
cd secret-lib
bun install
bun test
```

## Mental model

Two persistent halves per (repo, env):

```
┌──────────────────────────────────────────────────────────────────┐
│ Disk (chmod 0600)                                                │
│  ~/.config/deemwar/config/<repo>/env_<env>                       │
│   ├── s3.{endpoint, region, accessKeyId, secretAccessKey, …}     │
│   ├── encryption.salt                                            │
│   └── files.{envFile, vaultFolder}                               │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ OS keychain (Bun.secrets)                                        │
│  service: com.deemwar.secret-lib                                 │
│  name:    <repo>/<env>                                           │
│  value:   <base64 AES-256 key>                                   │
└──────────────────────────────────────────────────────────────────┘
```

Both are required to push/pull. Either one alone is useless: the file gives an attacker the bucket but not the encryption key, the key gives them nothing without the file.

For sharing both with a teammate in one go, use the **share file** — a passphrase-encrypted bundle of (config + key + metadata) that you generate with `export` and they install with `import`.

## Subcommand cheat sheet

```
bootstrap
  initapp [flags]                  scaffold .env stubs + infra/vault + Taskfile

setup + sharing
  init <env> [flags]               create config file + generate AES key
  export <env> [--out=path]        write a passphrase-encrypted share file
  import <env> <share-file>        restore a share file into local config + keychain
  link <env> --key=<key>           save a key to the keychain (when file already exists)

day-to-day
  push <env>                       upload local .env + vault to S3
  pull <env>                       download from S3
  restore-backup <env> <bk> <to>   unzip a local backup with the keychain key

inspection
  show-key <env> [--yes]           print the key (requires confirmation)
  delete-key <env> [--yes]         remove the key from the keychain

other
  sync-secrets <env> <gh|gcp>      push the rendered .env to GitHub / GCP Secret Manager
```

All commands accept `--repo=<name>` (defaults: `$SECRETS_SYNC_REPO` → `package.json::name` (scope-stripped) → git basename → cwd basename).

All commands are driven by **flags or interactive prompts**. Pass `--interactive` to force prompts even when every flag is provided. Pass every flag to skip prompts entirely.

## Versioning

This is **0.2.0** — a breaking change from 0.1.x. The old `<PREFIX>_<NAME>` env-var path is gone; everything is file + keychain now. There's no auto-migration; if you have a 0.1.x deployment, `init` a fresh config or have a teammate `export` you one.

## License

MIT.
