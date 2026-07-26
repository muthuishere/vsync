# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Process — how a change gets made here

Non-trivial work follows this pipeline. **Do not skip to code.**

1. **ADR — decide, via huddle + spikes.**
   Run the `huddle` skill to argue the decision with multiple perspectives, and
   run **spikes** (throwaway proof code in the scratchpad, never in the repo) for
   anything the huddle can't settle from reading alone. The output is one ADR in
   `docs/architecture/` — context, options considered, decision, consequences.
   A spike's job is to kill an option, not to become the implementation.
2. **OpenSpec — write the change.**
   `openspec` (v1.6.0, on PATH) holds the executable spec of the change. The ADR
   says *why*; the OpenSpec change says *what*, precisely enough to review before
   any code exists. Prose design docs in `docs/specs/` are the historical record
   (v0.2–v0.17); new work goes through OpenSpec instead of a new `vN.md`.
3. **Apply — implement against the approved change.**
   Only after 1 and 2 are agreed. Implementation follows the spec; drift from the
   spec means going back and amending the spec, not quietly diverging.

If a request looks small enough to skip the pipeline, say so explicitly and get
agreement — don't silently decide it was small.

## What this is

`@muthuishere/vsync` — a Bun-native CLI that syncs an encrypted vault folder (`.env`, JSON keys, certs, anything) between teammates via an S3-compatible bucket, with an append-only audit log on the bucket and a `vsync use` symlink so apps just `dotenv.config()`. Install globally (`bun install -g @muthuishere/vsync` or `npm install -g …`) and invoke as `vsync`; or run via `bunx @muthuishere/vsync`.

The repo is **not only the CLI** — `libraries/` holds four runtime client
libraries (Python, TypeScript, Go, Java) that read the same vault at app boot.
See "Runtime libraries" below.

Design specs live in `docs/specs/`:

- [`v0.2-secret-lib.md`](docs/specs/v0.2-secret-lib.md) — original full spec (threat model, crypto envelope, repo-name resolution). Still the source of truth for anything not changed since.
- [`v0.3-vsync-rebrand.md`](docs/specs/v0.3-vsync-rebrand.md) — rename + opinionated layout (vault folder at `infra/vault/<env>/`) + `sync` verb for GitHub/GCP fanout. Historical doc describing the rename from the original package name.
- [`v0.4-audit-log.md`](docs/specs/v0.4-audit-log.md) — append-only `audit.csv` on S3, ETag-conditional protocol, expandable `meta` JSON cell.
- [`v0.7-explicit-sync-parser.md`](docs/specs/v0.7-explicit-sync-parser.md) — `parseEnvFile` takes required `ParseOptions` (`inlineFileSuffixes`, `excludeProperties`). No module-level `LOCAL_ONLY` / `ROUTING` / `PATH_SUFFIXES` constants; no defaults applied by the CLI either. `vsync sync` reads `--inline-file-suffix=<suf>` / `--exclude-property=<key>` (both repeatable) and prints the active policy header before every run. In-env routing keys (`GITHUB_REPO`, `GCP_PROJECT_ID`) are gone — routing lives only in `cfg.sync.gh.repo` / `cfg.sync.gcp.project`.
- [`v0.8-multi-target-sync.md`](docs/specs/v0.8-multi-target-sync.md) — `vsync sync` grows from 2 backends to 5 (`gh`, `gcp`, `aws`, `azure`, `vault`) behind a `TargetHandler` interface. Handlers live under `src/synctargets/` and are looked up via a `HANDLERS` registry; `bin/sync.ts::main` is now just the dispatcher. Concurrency is per-handler — gh/gcp/aws/azure share the 6-worker pool, `vault` does one atomic bulk write (KV v2 is path-atomic). Purely additive vs. 0.7.x. New flags: `--aws-region`, `--aws-secret-prefix`, `--azure-vault`, `--vault-addr`, `--vault-mount`, `--vault-path`. Parser policy (v0.7) is target-agnostic and reused unchanged.

- [`v0.9`](docs/specs/v0.9-repo-name-resolution.md) → [`v0.13`](docs/specs/v0.13-profiles-init-status.md) — repo-name resolution, runtime-token CLI, conformance test vectors, the S3 client, profiles/`init`/`status`.
- [`v0.14-agent-skill.md`](docs/specs/v0.14-agent-skill.md) — spec for the agent skill (onboarding-first, ≤600 lines, `SKILL.md` + ≤3 references). **Spec only — no implementation is in this repo**; §11 defers it to a follow-up.
- [`v0.15`](docs/specs/v0.15-vsync-s3-client.md) / [`v0.16`](docs/specs/v0.16-repo-identity-git-only.md) / [`v0.17`](docs/specs/v0.17-pull-safety.md) — runtime-library redesign, git-only repo identity + committed `.vsync`, pull-safety ledger. **These three are partially landed** — `INPROGRESS.md` is the authoritative per-spec status table; read it before touching any of them.

Don't duplicate spec content here — read the spec when context is missing.

## Runtime libraries (`libraries/`)

Four sibling client libraries read the vault at app boot: `libraries/python`,
`libraries/typescript`, `libraries/go`, `libraries/java`. Each has its own
`Taskfile.yml`, its own test suite, and a `README.md`. They are **clients of the
same wire format** the CLI writes — so the crypto envelopes and manifest magic
below are a cross-language contract, not a TypeScript detail. `docs/specs/
v0.11-conformance-test-vectors.md` + `docs/specs/test-vectors/` exist so all four
can be proven byte-identical; conformance tests (`conformance_test.go`,
`conformance.test.ts`, …) consume those vectors. Change the format in one
language and you must move all four plus the vectors.

## Common commands

```bash
bun install                # one-time
bun test                   # all CLI tests (don't hardcode a count here — it rots)
bun test test/repo.test.ts # single file
bun test --watch           # watch mode
./bin/vsync.ts <sub>       # run the CLI directly (no install needed)
bunx . <subcommand>        # run as if installed
```

There is no build step, no linter config, no formatter wired into CI for the CLI.
`bun test` is the correctness gate **for the CLI only** — each library under
`libraries/` has its own `Taskfile.yml` and must be tested in its own directory
(`task test` there). A green `bun test` says nothing about the Go/Python/Java/TS
clients. The `engines.bun: ">=1.2.21"` floor is load-bearing — `Bun.secrets` shipped in 1.2.21.

## Architecture — the load-bearing split

Every (repo, env) pair has **two persistent halves** that must both be present for push/pull to work:

| Half | Location | Module |
|---|---|---|
| Config file (gzipped JSON, `0600`) | `${XDG_CONFIG_HOME:-~/.config}/<root>/config/<repo>/env_<env>` (root + path layout finalised per release; v0.3.0 uses `vsync/<repo>/env_<env>`) | `src/configfile.ts` (→ `src/repoconfig.ts` in v0.3.0) |
| Encryption key (base64 AES-256) | OS keychain via `Bun.secrets` — service is the per-release UTI (v0.3.0: `tools.vsync`), account `<repo>/<env>` | `src/keychain.ts` |

`src/envconfig.ts::loadEnvConfig(repo, env)` is the single read-path that joins them into a runtime `EnvConfig`. If you're adding a subcommand that needs S3 creds + the key, call this — don't reinvent the load. Missing file → `ConfigFileMissingError`; missing key → `KeyMissingError`. Both errors carry user-actionable next-step messages (init / import / link); preserve that pattern when adding new failure modes.

The library **never reads or writes shell rc**, never asks the user to export an env var, never prints an `export …` line. This is intentional — see docs/specs/v0.2-secret-lib.md §1 for the incident that motivated it. Don't reintroduce env-var-blob paths.

## Repo identity (`src/repo.ts`)

The `<repo>` namespace used in paths and keychain accounts is resolved by a precedence chain — every subcommand calls `getRepoName({ override: flags.repo })`.

Since **v0.16 the chain is git-only** (see [`v0.16-repo-identity-git-only.md`](docs/specs/v0.16-repo-identity-git-only.md)):

1. `--repo=<name>` flag (refuses to clobber a present `.vsync` that differs)
2. the committed `.vsync` file at git toplevel (`src/vsyncfile.ts`)
3. parsed `git config --get remote.origin.url`
4. otherwise → `RepoIdentityUnresolvedError`

Deliberately **removed** in v0.16 — do not resurrect: `$SECRETS_SYNC_REPO`,
`package.json::name`, `basename(cwd)`, and the `"default"` literal fallback.
Outside a git tree at all → `NotInGitRepoError`.

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
