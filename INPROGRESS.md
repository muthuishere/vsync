# In-progress work — v0.15 / v0.16 / v0.17

This file tracks the three concurrent design lines whose specs have landed and
implementations are partially shipped. It is the operator's source of truth
for "what's done, what's half-done, what's not started" until the next release.

Last updated: 2026-05-25.

## Quick status

| Spec | Spec written? | CLI impl? | Lib impl? | Unit tests? | Integration tests? | Docs/VitePress? |
|---|---|---|---|---|---|---|
| **v0.15** (runtime-lib redesign) | ✅ | n/a | ❌ pending | ❌ pending | ❌ pending | ❌ pending |
| **v0.16** (git-only identity + `.vsync`) | ✅ | ✅ | n/a | ✅ done | ❌ pending | ❌ pending |
| **v0.17** (ledger + refuse-on-divergence) | ✅ | ✅ | n/a | ⚠️ partial | ❌ pending | ❌ pending |

The full suite passes on `main` after the v0.16 + v0.17 implementation lands.
(Run `bun test` for the current count — a hardcoded number here rots.)

---

## v0.16 — repo identity, git-only

**Spec:** [`docs/specs/v0.16-repo-identity-git-only.md`](docs/specs/v0.16-repo-identity-git-only.md)

### Shipped (this push)

- `src/repo.ts` rewritten — new 4-step precedence chain:
  1. `--repo=<name>` flag (refuses to clobber a present `.vsync` that differs)
  2. `.vsync` at git toplevel
  3. parsed `git config --get remote.origin.url`
  4. `RepoIdentityUnresolvedError`
- New `src/vsyncfile.ts` — `.env`-style parser + writer for the committed
  `.vsync` identity pin file. Single required key `repo`; unknown keys are
  silently accepted for forward-compat.
- New error classes:
  - `NotInGitRepoError` — outside any git tree
  - `RepoIdentityUnresolvedError` — git tree but no identity source
  - `VsyncFileMalformedError`
  - `VsyncFileClobberError` — `--repo` differs from a present `.vsync`
  - `ShareRepoMismatchError` — share's embedded repo differs from `.vsync`
- `bin/init.ts` — writes `.vsync` on first init, prints commit hint, no-op if
  the file already matches.
- `bin/import.ts` — uses `getRepoNameForImport()` (flag > `.vsync` > share),
  writes `.vsync` on import.
- `bin/status.ts` + `src/status.ts` — new prefix block: `Repo` / `Source`
  (`flag` / `file` / `auto`) / `Toplevel` / `CWD` / `Origin` / optional
  worktree info. JSON output gains the same keys. Rename notice emitted when
  resolved name differs from auto-parsed origin URL.
- `bin/vsync.ts` — clean-error rendering registered for all v0.16 typed
  errors (no stack trace on user-facing failures).
- Drops:
  - `SECRETS_SYNC_REPO` env var (gone — `--repo` is the only override)
  - `basename(cwd)` fallback
  - `"default"` literal fallback
  - `package.json::name` resolver step (already gone in v0.9; v0.16 confirms
    no resurrection)

### Tests shipped

- `test/repo.test.ts` rewritten — drops SECRETS_SYNC_REPO / cwd / default
  tests; adds `.vsync` precedence (3), error paths (4), `resolveRepoWithSource`
  (4). ~30 tests in this file.
- New `test/vsyncfile.test.ts` — 22 tests covering parser grammar, writer
  refuse-to-clobber, unknown-key forward-compat.
- New `test/helpers/test-repo.ts` — `setupTestRepo()` builds an ephemeral
  git repo + `.vsync` pin for tests that need the resolver to return a
  specific identity.
- Bin tests migrated off `SECRETS_SYNC_REPO`:
  - `test/bin-init.test.ts`
  - `test/bin-status.test.ts`
  - `test/bin-runtime-token.test.ts`
  - `test/bin-rotate-passphrase.test.ts`

### Pending for v0.16

- Integration tests under `test/integration/repo-identity.test.ts` — 12
  scenarios. See **Integration harness** below.
- VitePress doc page at `docs/architecture/repo-identity.md` (linked from the
  `.vsync` file's header comment).
- Migration notice for operators on v0.13/v0.14/v0.15 who relied on
  `SECRETS_SYNC_REPO` — the error message names the recovery
  (`git remote add origin`, or `--repo=<name>`); no further doc work needed,
  but the upgrade guide should call it out.

---

## v0.17 — pull safety, ledger, refuse-on-divergence

**Spec:** [`docs/specs/v0.17-pull-safety.md`](docs/specs/v0.17-pull-safety.md)

### Shipped (this push)

- New `src/ledger.ts` — per-(repo, env) `{mtime_ms, size}` ledger at
  `${XDG_CONFIG_HOME:-~/.config}/vsync/<repo>/env_<env>.ledger.json`.
  - `readLedger` / `writeLedger` (atomic via tmp+rename)
  - `snapshotLedger` — walks vault, captures mtime+size for every file
  - `checkDirty` — diffs vault against ledger, returns
    `clean` / `untracked` / `dirty {modified, added, deleted}`
- New `src/vaultwalk.ts` — recursive walker that yields `{rel, abs, stat}`
  for every regular file under a root. Raises `SymlinkInVaultError` on
  symlinks (vault is plain data; symlinks would silently leak target
  content through the encrypted bundle).
- New `src/vaultbackup.ts` — `backupVault(repo, env, vaultDir)` writes a
  plain recursive copy to
  `${XDG_CONFIG_HOME}/vsync/backups/<repo>/<env>.backup-<iso>/` so the
  operator can recover their pre-pull state file-by-file.
- New error classes:
  - `LocalDirtyError` — `pull` refuses when local has unsynced edits
  - `RemoteAheadError` — `push` refuses when remote `ts > ledger.last_sync_ts`
  - `LedgerMalformedError`
  - `SymlinkInVaultError`
- `bin/pull.ts`:
  - Refuses on dirty by default (`LocalDirtyError`)
  - `--backup` — snapshot vault under XDG before pulling
  - `--force` — discard local edits without backup
  - `--backup` and `--force` mutually exclusive
  - Writes ledger from the freshly-pulled state
  - One-time migration warning when the ledger is absent
- `bin/push.ts`:
  - Pre-flight symlink check via `walkVault()`
  - HEAD on the remote pointer; refuses if `remoteTs > ledger.last_sync_ts`
    (`RemoteAheadError`); `--force` overrides
  - Writes ledger after successful push
- `bin/vsync.ts` — clean-error rendering registered for all v0.17 typed
  errors.

### Tests shipped

The existing bin tests (`test/bin-init.test.ts`, etc.) exercise the new
ledger/refuse-on-divergence paths indirectly via end-to-end push/pull
flows. **No dedicated unit tests for `src/ledger.ts` or `src/vaultwalk.ts`
yet** — see "Pending" below.

### Pending for v0.17

- **High priority:** dedicated unit tests
  - `test/ledger.test.ts` — atomic write, schema validation, mtime+size
    semantics, malformed handling, untracked vs clean vs dirty kinds
  - `test/vaultwalk.test.ts` — recursive yield, dotfile handling, symlink
    raise, stable sort order
  - `test/vaultbackup.test.ts` — path layout, symlink raise, idempotent
    parent-dir create
  - Pull tests: `--backup` flow, `--force` flow, mutually-exclusive flag,
    LocalDirtyError shape, ledger write after success
  - Push tests: lost-update guard, `--force` override, ledger write after
    success, RemoteAheadError shape
- Integration tests under `test/integration/pull-safety.test.ts` — 6
  scenarios.
- VitePress doc page at `docs/guide/pull-safety.md` covering the
  ledger model, `--backup`/`--force` decision matrix, and `RemoteAheadError`
  recovery.
- Operator runbook for "I lost work to `--force`, can I recover?" (answer:
  check `~/.config/vsync/backups/`; only `--backup` produces a recovery
  point).

---

## v0.15 — runtime library redesign (Python / TS / Go / Java)

**Spec:** [`docs/specs/v0.15-vsync-s3-client.md`](docs/specs/v0.15-vsync-s3-client.md)

### Status

**Nothing shipped yet.** The four runtime libraries still implement the v0.12
surface (`get_env` with fallback chain, `get_as_content`, `open()`/`open_with()`).
The v0.15 spec is locked but the refactor hasn't started.

### Scope when picked up

1. **Python reference impl** (`libraries/python/`):
   - Rename `Vsync` → `VsyncClient`
   - Drop `open_with`, `has_env`, `env_source`, `get_as_content`, module-level
     singleton helpers
   - Add `VsyncClient.open(config_blob, passphrase)` factory
   - Add `env(key)` (vault-only, no fallback)
   - Add `asset(name)` → str (UTF-8 decoded)
   - Add `assetAsBytes(name)` → bytes
   - Add `keys()`, `files()` iterators
   - Add `status(test_passphrase=None)` → `Status` (rich object with
     local/remote generations, has_new_version, passphrase_changed, optional
     safe_to_restart)
   - Drop `close()` (nothing to release)
2. **TS port** (`libraries/typescript/`) — same shape, `Promise<VsyncClient>`
   from `open()`.
3. **Go port** (`libraries/go/`) — `vsync.Open(blob, pp string) (*Client, error)`;
   `Keys() []string`, `Files() []string` (slice idiomatic for Go).
4. **Java port** (`libraries/java/`) — `VsyncClient.open(String, String)`,
   `Status` as a `record`, overloaded `status()` and `status(String testPassphrase)`.
5. **Conformance corpus** — regenerate per spec §6:
   - Delete `client-api-fallback-chain/*`
   - Rename + change `client-api-asset-as-content/*` → `client-api-asset-string/*`
     (default asset accessor returns string), add parallel
     `client-api-asset-bytes/*`
   - Delete `client-api-has-new-version/*`, replace with `client-api-status/*`
     (full Status object assertions)
   - Delete `client-api-open-env/*`
   - Merge `client-api-open-with/*` into `client-api-open/*`
6. **VitePress docs** — every `docs/libraries/*.md` page rewritten; examples
   gallery (`docs/examples/*.md`) regenerated for the new API.
7. **CLI side** — no changes; `vsync runtime-token` blob format unchanged.

### Migration cost for v0.12 consumers

Per `docs/specs/v0.15-vsync-s3-client.md` §10 — every consumer needs a 1-line
edit; the lib hands off bootstrap responsibility to the operator. Consumers
that relied on the fallback chain rewrite their `os.environ` fallbacks
explicitly at the call site.

---

## Integration test harness (cross-cutting v0.16 + v0.17)

**Spec:** [`docs/specs/v0.16-repo-identity-git-only.md`](docs/specs/v0.16-repo-identity-git-only.md) §11.A

### Status

**Nothing shipped yet.** Spec describes 35 integration scenarios across 4
test files plus a dedicated lifecycle Taskfile. None of these files exist
on disk.

### Scope when picked up

1. **`test/integration/docker-compose.yml`** — MinIO only, `tmpfs:/data`,
   ports 15230/15231, no persistence.
2. **`test/integration/setup-minio.sh`** — idempotent bucket + scoped IAM
   user provisioning. Creates `vsync-test` + `vsync-test-alt` buckets,
   `vsync-app` user with policy `vsync-test-rw`.
3. **`test/integration/teardown-minio.sh`** — optional state-wipe without
   bouncing the container.
4. **`test/integration/Taskfile.yml`** — dedicated lifecycle:
   `up` / `setup` / `test` / `down` / `reset` / `logs` / `console` /
   `default` (full cycle with `defer:` teardown).
5. **Root `Taskfile.yml`** — one-line delegate target.
6. **`test/integration/harness.ts`** — `makeWorkspace()` / `Workspace.makeRepo()` /
   `Workspace.makeWorktree()` / `runVsync()` / `s3List/Get/Delete` /
   `ensureMinioReachable()` (graceful skip without Docker).
7. **Test files** — 35 scenarios total:
   - `test/integration/repo-identity.test.ts` (12)
   - `test/integration/push-pull.test.ts` (10)
   - `test/integration/worktree.test.ts` (8)
   - `test/integration/cross-repo.test.ts` (5)
   - Plus `test/integration/pull-safety.test.ts` (6 — v0.17)

### Why this is one task

The harness is shared across all integration tests — landing one of the four
test files without the harness wouldn't compile. The 41 total scenarios
(35 v0.16 + 6 v0.17) are tracked as one piece of work.

---

## Suggested next sessions

1. **Session A (1-2h)** — fill in the v0.17 unit tests (ledger, vaultwalk,
   vaultbackup, pull/push extensions). Stable, no external dependencies.
2. **Session B (2-3h)** — build the integration harness + write the 41
   scenarios. Requires Docker locally.
3. **Session C (3-4h)** — v0.15 runtime-lib refactor across all four
   languages + corpus regeneration. Independent of sessions A and B.

A and B can run in parallel by different operators; C is independent.

---

## Operator notes — running locally today

After this push, `vsync init` writes a `.vsync` file in the current repo's
toplevel. **Commit it** so teammates resolve to the same identity without
typing `--repo=<name>`:

```bash
vsync init dev --profile=hetzner-personal
# → ✅ Setup complete
#    ...
#    .vsync:      /Users/.../repo/.vsync (identity pin — please commit)
git add .vsync && git commit -m "vsync: add identity pin"
git push
```

After this push, `vsync pull` refuses to overwrite local edits. To proceed:

```bash
vsync pull dev --backup      # snapshot vault under XDG, then pull
vsync pull dev --force       # discard local edits (DANGEROUS — no backup)
vsync push dev               # if your local edits ARE the intended state
```

After this push, `vsync push` refuses when remote has advanced past your
last sync. To proceed:

```bash
vsync pull dev               # fetch teammate's changes first
vsync push dev --force       # overwrite teammate's work (DANGEROUS)
```

If you were on `SECRETS_SYNC_REPO`, that env var is gone. Use `--repo=<name>`
or run `vsync init` to write a `.vsync` pin.
