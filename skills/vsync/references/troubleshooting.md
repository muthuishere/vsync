# Troubleshooting

Every `(repo, env)` has **two halves** — a config file on disk and an AES key
in the OS keychain. Almost every failure is one half missing, or the repo
identity resolving differently than the user expects.

Run `vsync status` first and read it. Don't diagnose from the error text
alone.

---

## 1. "no config file for `<repo>/<env>`"

The config half is missing. Either they never ran `init` here, or the repo
name resolved differently than last time.

- Never initialised → `vsync init <env> --profile=<name>`
- Teammate with a share file → `vsync import <env> <share-file>`
- Was working yesterday → suspect identity. Check `vsync status`'s `Repo` and
  `Source` lines. A changed git remote or a missing `.vsync` moves the whole
  namespace.

## 2. "encryption key … not found in OS keychain"

Config half present, key half gone. The bucket data is intact but
undecryptable from this machine.

- A teammate can re-`export` and they `import` again
- Or restore from a `.keytree` if they made one: `vsync keystore import <file>`
- **Do not suggest re-running `init`** to "fix" it — that mints a *fresh* key
  which will not match the existing bundle. `init`'s own error text says so.

## 3. "failed to decrypt … doesn't match the bundle's seal"

Both halves present but the key is the wrong one. Usual causes:

- Someone ran `vsync rotate-passphrase` and this machine has the old key →
  they need a fresh `export`/`import`, or to have been the one who rotated
- Two repos accidentally sharing a namespace, so the wrong key is being found
- A restored-from-backup keychain that predates a rotation

`vsync versions <env>` plus `vsync audit <env>` will show whether a rotation
happened and when.

## 4. Repo identity resolved to the wrong name

Since v0.16 the chain is git-only:

1. `--repo=<name>` flag
2. the committed `.vsync` file at the git toplevel
3. parsed `git config --get remote.origin.url`
4. otherwise → error

There is no `$SECRETS_SYNC_REPO`, no `package.json::name`, no cwd basename,
no `"default"` fallback. Outside a git tree at all, vsync refuses.

`vsync status` prints `Repo`, `Source` (`flag`/`file`/`auto`), `Toplevel` and
`Origin`. If `Source` is `auto` and the origin URL recently changed, that's
the bug — commit a `.vsync` to pin it.

## 5. `vsync use` says the target doesn't exist

`use` symlinks to `<vaultFolder>/.env.<env>`, which only exists after a
successful `pull`. So: `vsync pull <env>` first.

In a **linked git worktree** this is usually not an error to fix — worktrees
share the main worktree's vault. Pull once in the main checkout, then run
`vsync use <env>` in the worktree. Do not create a second vault.

Also: `use` refuses to clobber a regular file at the link path. If they have a
real `./.env`, they must rename or delete it themselves — vsync will not
overwrite it.

---

## Things that are working as designed

- **Passphrases aren't stored anywhere.** `export` prints one once. If it's
  lost, the share file is unrecoverable — export again. There is no list of
  past passphrases to recover.
- **No per-user revoke.** Rotating invalidates all outstanding shares, not
  one person's. Historical bucket versions stay readable with the old key.
- **`push` refusing on divergence** is the pull-safety ledger doing its job.
  Pull and reconcile rather than forcing.
