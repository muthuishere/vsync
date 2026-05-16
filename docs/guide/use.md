# Switching environments — `vsync use`

So apps don't need to know vault paths, `vsync use <env>` creates a symlink that points the conventional `.env` location at the vault's env file:

```bash
vsync use dev                          # ./.env → infra/vault/dev/.env.dev
vsync use production                   # repoint to infra/vault/production/.env.production
vsync use                              # print current target
```

Any framework reading `.env` (Vite, Next.js, Bun, dotenv, every Python lib) just works — no path argument, no custom loader. Switch environments with one command; restart your dev server and you're running against the new env.

## `--link=<path>` — pick a different name or location

```bash
vsync use dev  --link=.env.dev          # ./.env.dev → infra/vault/dev/.env.dev
vsync use prod --link=apps/web/.env     # apps/web/.env → … (monorepo)
```

Useful when you already have a `.env`, want the conventional `.env.<env>` naming, or work in a monorepo.

All link paths resolve against the **repo root**, regardless of which subdirectory you invoke `vsync use` from — consistent with every other vsync verb.

## Safety: never clobber a real file

If the link path already exists as a **regular file**, vsync refuses to touch it — full stop, no `--force` escape hatch:

```bash
$ vsync use dev
./.env exists as a regular file — refusing to touch it (no --force, by design).
Move or delete it first if you want vsync to manage ./.env:
  mv .env .env.local.bak    # or: rm .env
then re-run 'vsync use dev'.
```

This is intentional. A real `.env` file might contain bespoke local overrides that aren't in your vault. Move it aside yourself before letting vsync take over.

An existing **symlink** at the link path is replaced silently — symlinks are cheap to recreate, and "switch envs" is the primary use case.

## Gitignore check

`vsync use` warns if the link's basename isn't covered by `.gitignore`:

```
⚠  .env is not in .gitignore — add a rule for it before committing
```

It recognises `.env`, `.env*`, `.env.*`, `*.env`, and exact basename matches.

## Platform support

- **macOS / Linux / WSL** — POSIX symlinks. Works out of the box.
- **Windows** — uses `symlinkSync(target, path, "file")` (Node's Windows-aware variant). Requires either:
  - **Developer Mode** (Settings → Privacy & security → For developers), OR
  - **Elevated terminal** (Run as administrator)

  vsync catches `EPERM` and prints the above hint. Junctions aren't an option — they're directory-only.

---

[Next: Push / pull / versions →](/guide/daily)
