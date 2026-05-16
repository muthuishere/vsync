# Repo identity

The `<repo>` namespace in `s3://<bucket>/<repo>/<env>/…` and in the keychain account `<repo>/<env>` is resolved by a **precedence chain**. Every subcommand calls `getRepoName({ override: flags.repo })` from `src/repo.ts`. The first source that yields a non-empty value wins.

## Precedence (highest → lowest)

1. `--repo=<name>` flag — explicit override.
2. `$SECRETS_SYNC_REPO` env var — for scripted use, e.g. CI.
3. `package.json::name` at the repo root, with leading `@scope/` stripped. So `@muthuishere/cool-thing` → `cool-thing`.
4. `git rev-parse --show-toplevel` basename — the working tree's git root directory name.
5. `process.cwd()` basename — last resort if no git repo.
6. Literal string `"default"` — if everything above is unreachable (no git, no package.json, etc.).

All sources are sanitised through `[^A-Za-z0-9._-]+` → `-`, so weird characters in folder names (spaces, slashes, emoji) become `-`. Final repo name matches `[A-Za-z0-9._-]+`.

## Why this order

| Source | Use case |
|---|---|
| `--repo` | Explicit override; mostly for tests + edge cases. |
| `$SECRETS_SYNC_REPO` | CI environments where the repo is the same regardless of cwd. |
| `package.json::name` | The most common case for app developers. Stable across renames of the directory. |
| git basename | Works when there's no `package.json` (Go, Python, Rust projects). Stable across `cd`. |
| cwd basename | Last-resort. |
| `"default"` | Lets vsync work in `/tmp` or anywhere lacking git/package.json. |

## Why stability matters

The repo name is **load-bearing** — it's part of the keychain account name, the disk config path, and every S3 key. If the same machine resolves a different repo name tomorrow than today, the keychain entry and disk config silently move and the user sees `no config for <repo>/<env>` until they re-`import`.

So **the precedence chain itself is a stability contract.** Changing the order, or adding a new source above an existing one, would silently break already-initialised users.

If you ever need to change the chain (e.g., add a `.vsync-repo` dotfile source), it has to go at the **end** of the precedence — never inserted ahead of existing sources.

## Common pitfalls

### Different repo name on two machines for the same project

Machine A has `package.json::name = "my-app"`. Machine B doesn't have a `package.json` (cloned the repo, forgot to run anything that creates one). Machine B falls through to git basename, which might be `my-app-fork` or similar.

→ Different repo names → different S3 prefixes → push from A doesn't appear in pull on B.

**Fix:** ensure `package.json` exists on both machines (which is the case for ~all JS projects), or set `SECRETS_SYNC_REPO=my-app` on the machine that's drifting.

### Renaming the git directory

Repo name is read from `package.json` first. So `mv my-app my-app-renamed` doesn't change the repo name as long as the `package.json` is intact.

If you renamed AND have no `package.json`, git basename becomes the new name, and you'll see `no config for <new-name>/<env>`. Run `vsync use --repo=my-app …` to confirm the old name still works, then move config and keychain entry manually (no `vsync rename` verb).

### Monorepo with multiple subpackages

Each subpackage's `package.json::name` will be different. `vsync` invoked from `apps/web/` → repo = `web`. From `apps/api/` → repo = `api`. So each app has its own S3 prefix and keychain key — which is usually what you want for monorepos.

If you want them to **share** secrets, pin the repo at the top level: `SECRETS_SYNC_REPO=monorepo` in your shell rc, or `--repo=monorepo` per invocation.

## Where it's used

- S3 key prefix: `s3://<bucket>/<repo>/<env>/…`
- Keychain account: `<repo>/<env>` (service is constant: `tools.vsync`)
- Disk config path: `~/.config/vsync/<repo>/env_<env>`
- Backup path: `~/.config/vsync/backups/<repo>-<env>-<ts>.zip.enc` *(currently `<env>-<ts>.zip.enc` — bug; repo isn't in the path)*

## Implementation

`src/repo.ts`. Tests in `test/repo.test.ts` cover every level of the chain.

---

[Next: Security model →](/architecture/security)
