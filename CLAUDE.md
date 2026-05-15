# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@muthuishere/secret-lib` — a Bun-native CLI (`bunx @muthuishere/secret-lib`) that syncs an encrypted `.env` + vault folder between teammates via an S3-compatible bucket. v0.2.0 is a clean break from the v0.1.x env-var-blob model.

Full design rationale and threat model live in `SPEC.md`. Onboarding/usage flow lives in `onboarding.md` + `using.md`. Don't duplicate them here — read them when context is missing.

## Common commands

```bash
bun install                # one-time
bun test                   # all tests (114 today)
bun test test/repo.test.ts # single file
bun test --watch           # watch mode
./bin/secret-lib.ts <sub>  # run the CLI directly (no install needed)
bunx . <subcommand>        # run as if installed
```

There is no build step, no linter config, no formatter wired into CI. `bun test` is the only correctness gate. The `engines.bun: ">=1.2.21"` floor is load-bearing — `Bun.secrets` shipped in 1.2.21.

## Architecture — the load-bearing split

Every (repo, env) pair has **two persistent halves** that must both be present for push/pull to work:

| Half | Location | Module |
|---|---|---|
| Config file (gzipped JSON, `0600`) | `${XDG_CONFIG_HOME:-~/.config}/deemwar/config/<repo>/env_<env>` | `src/configfile.ts` |
| Encryption key (base64 AES-256) | OS keychain via `Bun.secrets` — service `com.deemwar.secret-lib`, account `<repo>/<env>` | `src/keychain.ts` |

`src/envconfig.ts::loadEnvConfig(repo, env)` is the single read-path that joins them into a runtime `EnvConfig`. If you're adding a subcommand that needs S3 creds + the key, call this — don't reinvent the load. Missing file → `ConfigFileMissingError`; missing key → `KeyMissingError`. Both errors carry user-actionable next-step messages (init / import / link); preserve that pattern when adding new failure modes.

The library **never reads or writes shell rc**, never asks the user to export an env var, never prints an `export …` line. This is intentional — see SPEC.md §1 for the incident that motivated it. Don't reintroduce env-var-blob paths.

## Repo identity (`src/repo.ts`)

The `<repo>` namespace used in paths and keychain accounts is resolved by a precedence chain — every subcommand calls `getRepoName({ override: flags.repo })`:

1. `--repo=<name>` flag → 2. `$SECRETS_SYNC_REPO` → 3. `package.json::name` (scope stripped) → 4. git toplevel basename → 5. cwd basename → 6. `"default"`

Result is sanitised to `[A-Za-z0-9._-]+`. Stability of this chain matters — if you change it, an already-initialised user's keychain and config file silently move.

## CLI dispatch (`bin/secret-lib.ts`)

Single dispatcher; each subcommand is a sibling file exporting `main(argv: string[])`. To add a subcommand:

1. New file in `bin/` exporting `main`
2. Add to the `SUBCOMMANDS` const + the `switch` in `bin/secret-lib.ts`
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

Don't add (per SPEC.md §2 + §10):
- Cross-platform GUI, audit logging, per-user ACLs
- Per-file passphrase on the disk config (the security envelope is `chmod 0600` + the keychain split)
- Compat shims for v0.1.x env-var blobs — explicitly deleted

`rotate-key`, `doctor`, `list` are on the 0.3.x roadmap (SPEC.md §10) but not implemented; if the user asks for them, point at the spec rather than improvising.
