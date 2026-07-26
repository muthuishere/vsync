# This machine — `vsync keystore`

Every other verb is scoped to **one repo**. `vsync keystore` is scoped to
**one machine**: it sees every `(repo, env)` pair you've ever set up, and can
seal a chosen subset into a single file you restore somewhere else.

This is the answer to *"I got a new laptop"* and *"give this contractor two
of my six environments"* — without hunting for six `.share` files and six
passphrases you no longer have.

## See what this machine knows

```bash
vsync keystore list
```

```
acme_api
  dev              key

acme_web
  dev              key
  prod             NO KEY

3 pair(s) across 2 repo(s).
1 pair(s) have a config but no key in the OS keychain — they cannot pull.
```

Each `(repo, env)` needs **two halves**: a config file on disk and an AES key
in the OS keychain. `list` shows both, so a missing half is visible
immediately rather than at the next failed `pull`.

::: tip Why can't it just read the keychain?
`Bun.secrets` exposes `get` / `set` / `delete` and no enumeration — there is
no API to list what's in the OS keychain. So vsync walks its own config tree
instead, and probes the keychain per pair. That's why a key with no config is
invisible: nothing points at it.
:::

## Export a chosen subset

```bash
# everything on this machine — pairs, keys, and every named profile
vsync keystore export --all --out=~/laptop.keytree

# just two repos' dev environments
vsync keystore export --repo=acme_web --repo=acme_api --env=dev
```

`--repo` and `--env` are both repeatable and combine as a filter. Output
defaults to `./<hostname>.keytree`, mode `0600`.

**Selection is mandatory.** Running `vsync keystore export` with no filters
and no `--all` is refused:

```
refusing to export without a selection.
  A keytree can hold every secret on this machine, so the selection must be explicit.
```

That refusal is deliberate. A keytree is the highest-value artifact vsync
produces — see [the warning below](#this-file-outranks-a-share).

### What `--all` includes

| | `--all` | narrowed selection |
|---|---|---|
| `(repo, env)` configs | ✅ | matching only |
| OS keychain keys | ✅ | matching only |
| Named profiles | ✅ | only with `--profiles` |

Profiles matter more than they look. `vsync init` **requires**
`--profile=<name>`, so a machine restored without profiles can revive the
environments it already had but cannot create a new one. `--all` includes
them for that reason.

## Restore on another machine

```bash
vsync keystore import ~/laptop.keytree
```

```
  restored profile myprofile
  restored acme_api/dev
  restored acme_web/dev

2 pair(s) and 1 profile(s) restored from /Users/you/laptop.keytree.

Next: 'vsync pull <env>' inside each repo to fetch its vault.
```

- **Profiles restore first**, because configs reference them by name.
- Pairs that already exist are **skipped**, not overwritten. Pass `--force` to
  overwrite them.
- Import is **all-or-nothing at validation**: the entire file is checked
  before a single byte is written, so a malformed keytree cannot leave the
  machine half-restored.

The keytree carries configs and keys — not vault contents. Run
`vsync pull <env>` in each repo afterwards to fetch the actual secrets.

## This file outranks a `.share`

A `.share` file carries **one** environment. A keytree made with `--all`
carries **every AES key and every S3 access key on the machine**.

- Send the file and the passphrase on **two different channels**, same as
  `.share`.
- The passphrase is generated and printed **once**. It is stored nowhere. If
  you lose it, the keytree is unrecoverable — export again.
- Delete the file once the other machine has imported it. It does not expire.
- Prefer a narrowed selection over `--all` when you're handing it to someone
  else rather than to your own next laptop.

## Keytree vs. share file

|  | `.share` | `.keytree` |
|---|---|---|
| Scope | one `(repo, env)` | any selection, up to the whole machine |
| Contains | config + key | configs + keys + profiles |
| Made by | `vsync export <env>` | `vsync keystore export` |
| Restored by | `vsync import <env> <file>` | `vsync keystore import <file>` |
| Typical use | onboard a teammate | rebuild your own machine |
| Format magic | `SLS1` | `VKT1` |

Feeding one to the other's command fails on the magic bytes with a message
naming the right verb — they can't be confused silently.

## Reserved repo names

`profiles` and `backups` cannot be used as repo names. vsync stores its own
state in directories of those names, so a repo called either would write its
config *inside* vsync's own directory and disappear from `keystore list`.
Both are refused with an actionable error; use `--repo=<name>` or a `.vsync`
pin to choose something else.

---

[Command reference →](/guide/commands) · [Onboarding a teammate →](/guide/share)
