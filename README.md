# secret-lib

Encrypted env-sync for repos. Bundles a `.env` file + a vault folder, encrypts with AES-256-GCM (PBKDF2-SHA256, 600k iterations), uploads versioned + manifest-sealed bundles to S3, and pulls them back on other machines.

Standalone Bun CLI. Designed for `bunx github:muthuishere/secret-lib …` from any consuming repo.

## Start here

- **Setting up a new project?** → [`onboarding.md`](./onboarding.md) — provision an env-var, push the first bundle, share with the team.
- **Joining an existing project?** → [`using.md`](./using.md) — get the key from 1Password, paste into `~/.zshrc`, pull.
- **Want a copy-paste Taskfile?** → [`examples/Taskfile.yml`](./examples/Taskfile.yml) — drop into `infra/setup/Taskfile.yml`, change the prefix, done.

## Install

You don't. Just run via `bunx`:

```bash
bunx github:muthuishere/secret-lib --help
```

For local development of the library itself:

```bash
git clone git@github.com:muthuishere/secret-lib.git
cd secret-lib
bun install   # only @types/bun for editor types
bun test
```

## Mental model

Each environment (LOCAL, DEV, PROD, …) has one config bundled into a single env var:

```
<PREFIX>_<NAME> = base64( gzip( JSON({s3 creds, encryption key, file paths}) ))
```

Examples (the prefix is supplied by the consumer):

```
VIDEO_AI_ENV_LOCAL = ...    # video-ai's Taskfile passes --prefix=VIDEO_AI_ENV
REQSUME_ENV_LOCAL  = ...    # reqsume's Taskfile passes --prefix=REQSUME_ENV
```

`init-env` reads a JSON config file and prints that string. Once you have it in your shell rc (or 1Password), `push-env` uploads your local `.env` + vault folder to the bucket (encrypted, versioned, manifest-sealed), and `pull-env` downloads the latest, verifies the manifest, replaces local files.

## CLI

```
secret-lib <subcommand> [args...]

  init-env        <NAME> [path-to-json] [--prefix=PREFIX]
  push-env        <NAME> [--prefix=PREFIX]
  pull-env        <NAME> [--prefix=PREFIX]
  restore-backup  <NAME> <backup-file> <target-dir> [--prefix=PREFIX]
```

`PREFIX` resolution order:

1. explicit `--prefix=` flag
2. `SECRETS_SYNC_PREFIX` env var
3. fallback `SECRETS_ENV`

Run via `bunx github:muthuishere/secret-lib <subcommand>`. From the consuming repo's Taskfile:

```yaml
env:
  SECRETS_SYNC_PREFIX: VIDEO_AI_ENV

tasks:
  push-env:
    cmds:
      - bunx github:muthuishere/secret-lib push-env {{.NAME}}
```

Or pass the flag explicitly:

```yaml
- bunx github:muthuishere/secret-lib push-env {{.NAME}} --prefix=VIDEO_AI_ENV
```

## Subcommands

### `init-env <NAME> [path-to-json] [--prefix=PREFIX]`

Reads a JSON config file (default: `envconfig.<lowercase-name>.json` in current dir), validates it, prints the `export <PREFIX>_<NAME>='...'` line ready to paste into your shell rc / 1Password.

```bash
cp envconfig.sample.json envconfig.local.json
# edit envconfig.local.json — fill in real values
bunx github:muthuishere/secret-lib init-env LOCAL --prefix=VIDEO_AI_ENV
```

### `push-env <NAME> [--prefix=PREFIX]`

Reads `<PREFIX>_<NAME>` from env, zips `.env` + vault folder, wraps the zip in a manifest carrying the version timestamp, encrypts (AES-256-GCM), uploads to:

```
s3://<bucket>/<name-lowercase>/versions/<timestamp>.enc
s3://<bucket>/<name-lowercase>/latest         (pointer to that timestamp)
```

### `pull-env <NAME> [--prefix=PREFIX]`

Encrypts the existing local `.env` + vault folder into `~/.config/localdevconfig/<name>-<ts>.zip.enc` (rolling 2-deep backup), then downloads + decrypts + verifies the manifest matches `latest` + unzips into the repo root.

### `restore-backup <NAME> <backup-file> <target-dir> [--prefix=PREFIX]`

Decrypts a `~/.config/localdevconfig/<name>-<ts>.zip.enc` file using the same key+salt and unzips into `<target-dir>`. Use after a pull overwrites local edits.

## Config schema

See `envconfig.sample.json` for an example.

```json
{
  "s3": {
    "endpoint": "hel1.your-objectstorage.com",
    "bucket": "myenvbucket",
    "region": "us-east-1",
    "useSsl": true,
    "accessKeyId": "...",
    "secretAccessKey": "..."
  },
  "encryption": {
    "key": "long-random-passphrase",
    "salt": "deployment-specific-salt"
  },
  "files": {
    "envFile": ".env",
    "vaultFolder": "infra/vault/local"
  }
}
```

- **Encryption:** AES-256-GCM with a key derived via PBKDF2-SHA256 (600,000 iterations) from `key` + `salt`.
- **Validation floor:** `encryption.key` ≥ 20 chars, `encryption.salt` ≥ 16 chars. `init-env` refuses anything weaker.
- **Crypto envelope:** 4-byte magic `"RQE1"` + 12-byte random IV + ciphertext-with-tag.
- **Manifest envelope (inside the encrypted blob):** 8-byte magic `"RQEM0001"` + 15-byte timestamp + zip bytes. `pull-env` rejects any bundle whose embedded ts doesn't match the `latest` pointer — defends against bucket-write pointer-swap attacks.
- **Versioning:** every push uploads `versions/<YYYYMMDD-HHMMSS>.enc` and updates a `latest` text pointer. Set up a bucket lifecycle rule to prune old versions if you want.
- **Local backup:** every pull encrypts (same key+salt) the existing local files into `~/.config/localdevconfig/<name>-<ts>.zip.enc`, keeping the 2 most recent per environment. Recover with `restore-backup`.
- **System deps:** `zip` and `unzip` binaries on PATH (preinstalled on macOS / Linux).

## Layout

```
src/    library code (importable, pure functions where possible)
bin/    CLI entry points (secret-lib dispatcher + per-subcommand modules)
test/   bun:test files
envconfig.sample.json   committed sample config (placeholders)
```

## Tests

```bash
bun test
```

7 files, 63 tests. Covers `argv` (positional + flag parsing), `codec` (round-trip + error paths), `crypto` (round-trip, wrong key/salt, magic, IV randomness, NUL bytes), `manifest` (wrap/unwrap, magic, length, NUL bytes), `archive` (real-fs zip → unzip), `envconfig` (encode/decode, validation including length floors, prefix resolution, env-var parsing), and `backup` (encrypted roundtrip, wrong-key rejection, rolling 2-deep, name-scoped pruning).

The S3 client wrapper is intentionally not unit-tested — exercise it end-to-end via `init-env` → `push-env` → `pull-env` against a real bucket on first setup.

## License

MIT
