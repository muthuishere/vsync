# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@muthuishere/vsync` — a Bun-native CLI that syncs an encrypted vault folder (`.env`, JSON keys, certs, anything) between teammates via an S3-compatible bucket, with an append-only audit log on the bucket and a `vsync use` symlink so apps just `dotenv.config()`. Install globally (`bun install -g @muthuishere/vsync` or `npm install -g …`) and invoke as `vsync`; or run via `bunx @muthuishere/vsync`.

Design specs live in `docs/specs/`:

- [`v0.2-secret-lib.md`](docs/specs/v0.2-secret-lib.md) — original full spec (threat model, crypto envelope, repo-name resolution). Still the source of truth for anything not changed since.
- [`v0.3-vsync-rebrand.md`](docs/specs/v0.3-vsync-rebrand.md) — rename + opinionated layout (vault folder at `infra/vault/<env>/`) + `sync` verb for GitHub/GCP fanout. Historical doc describing the rename from the original package name.
- [`v0.4-audit-log.md`](docs/specs/v0.4-audit-log.md) — append-only `audit.csv` on S3, ETag-conditional protocol, expandable `meta` JSON cell.

Don't duplicate spec content here — read the spec when context is missing.

## Common commands

```bash
bun install                # one-time
bun test                   # all tests (184 today)
bun test test/repo.test.ts # single file
bun test --watch           # watch mode
./bin/vsync.ts <sub>       # run the CLI directly (no install needed)
bunx . <subcommand>        # run as if installed
```

There is no build step, no linter config, no formatter wired into CI. `bun test` is the only correctness gate. The `engines.bun: ">=1.2.21"` floor is load-bearing — `Bun.secrets` shipped in 1.2.21.

## Architecture — the load-bearing split

Every (repo, env) pair has **two persistent halves** that must both be present for push/pull to work:

| Half | Location | Module |
|---|---|---|
| Config file (gzipped JSON, `0600`) | `${XDG_CONFIG_HOME:-~/.config}/<root>/config/<repo>/env_<env>` (root + path layout finalised per release; v0.3.0 uses `vsync/<repo>/env_<env>`) | `src/configfile.ts` (→ `src/repoconfig.ts` in v0.3.0) |
| Encryption key (base64 AES-256) | OS keychain via `Bun.secrets` — service is the per-release UTI (v0.3.0: `tools.vsync`), account `<repo>/<env>` | `src/keychain.ts` |

`src/envconfig.ts::loadEnvConfig(repo, env)` is the single read-path that joins them into a runtime `EnvConfig`. If you're adding a subcommand that needs S3 creds + the key, call this — don't reinvent the load. Missing file → `ConfigFileMissingError`; missing key → `KeyMissingError`. Both errors carry user-actionable next-step messages (init / import / link); preserve that pattern when adding new failure modes.

The library **never reads or writes shell rc**, never asks the user to export an env var, never prints an `export …` line. This is intentional — see docs/specs/v0.2-secret-lib.md §1 for the incident that motivated it. Don't reintroduce env-var-blob paths.

## Repo identity (`src/repo.ts`)

The `<repo>` namespace used in paths and keychain accounts is resolved by a precedence chain — every subcommand calls `getRepoName({ override: flags.repo })`:

1. `--repo=<name>` flag → 2. `$SECRETS_SYNC_REPO` → 3. `package.json::name` (scope stripped) → 4. git toplevel basename → 5. cwd basename → 6. `"default"`

Result is sanitised to `[A-Za-z0-9._-]+`. Stability of this chain matters — if you change it, an already-initialised user's keychain and config file silently move.

## CLI dispatch (`bin/vsync.ts`)

Single dispatcher; each subcommand is a sibling file exporting `main(argv: string[])`. To add a subcommand:

1. New file in `bin/` exporting `main`
2. Add to the `SUBCOMMANDS` const + the `switch` in `bin/vsync.ts`
3. Update the `usage()` text in the same file
4. Update `README.md` cheat-sheet + `package.json::files` if needed

Every subcommand:
- Parses argv via `src/argv.ts::parseArgs` (positional + `--key=value`)
- Resolves repo via `getRepoName`
- Supports `--interactive` to force prompts even when flags fully specify the input — see `bin/init.ts` for the pattern
- Uses `src/prompt.ts` for TTY input; bails clearly if `!isTty()` and a required value is missing

## Crypto envelopes — don't break the magic bytes

Three nested binary formats. Each has a 4-or-more-byte magic so a wrong-passphrase/corrupt-blob is distinguishable from a wrong-version:

- `RQE1` (`src/crypto.ts`) — AES-256-GCM + PBKDF2-SHA256 (600k iters). Used for both S3 bundle and share-file inner payload.
- `RQEM0001` (`src/manifest.ts`) — manifest pointer-seal. Embeds the timestamp inside the encrypted plaintext so a bucket-write-only attacker can't rename an older version onto `latest`. Pull-side verifies `embeddedTs === remoteTs`.
- `SLS1` (`src/sharefile.ts`) — outer frame of a `.share` file. Carries the passphrase salt + an `RQE1` envelope of the export blob.

Bumping any magic = breaks every existing deployment. Don't touch unless you also add migration.

## Test conventions

- Tests are colocated by module name: `src/foo.ts` ↔ `test/foo.test.ts`.
- Tests that touch `~/.config/...` override `XDG_CONFIG_HOME` to a `mkdtempSync` dir in `beforeAll` and restore in `afterAll` — see `test/configfile.test.ts`. Mirror this when adding new config-touching tests.
- `keychain.test.ts` hits real `Bun.secrets`; passes on macOS, will pass on Linux with libsecret. Windows is untested.

## What's intentionally out of scope

Don't add:
- Cross-platform GUI, per-user ACLs (audit log shipped in v0.4 — see `docs/specs/v0.4-audit-log.md`)
- Per-file passphrase on the disk config (the security envelope is `chmod 0600` + the keychain split)
- Compat shims for env-var-blob shell-rc setups — never reintroduce

`rotate-key`, `doctor`, `list` were on an earlier roadmap but are not implemented; if the user asks for them, surface that and discuss scope rather than improvising.
