---
name: vsync-skill
---

# Mental model — two halves, one canonical name

Every `(repo, env)` pair has **two persistent halves** on a given machine. Both are required to decrypt a bundle; either alone is useless.

## Half 1 — the config file (on disk, mode 0600)

Path: `${XDG_CONFIG_HOME:-~/.config}/vsync/<repo>/env_<env>`
Format: gzip(JSON), no base64 wrapper
Owner-only readable (file mode `0600`, parent dir `0700`).

Holds everything `push` / `pull` / `sync` need at runtime **except** the AES key:

- S3 bucket creds + endpoint + region
- Manifest salt (PBKDF2 input)
- Vault folder override (for monorepos with non-default layout)
- Sync routing config (`sync.gh.repo`, `sync.gcp.project`, etc.) — written on first `sync` invocation
- Audit-log enable flag

## Half 2 — the encryption key (OS keychain)

Service: `tools.vsync` (the per-release UTI)
Account: `<repo>/<env>`
Value: AES-256 key, base64-encoded

Backed by `Bun.secrets` — macOS Keychain, Linux libsecret (gnome-keyring / kwallet), Windows Credential Manager. The minimum Bun version (`>=1.2.21`) is load-bearing because `Bun.secrets` shipped in that release.

vsync **never** reads or writes a shell rc file. Never prints an `export …` line. Never asks the user to set an env var to carry the key. This is intentional — see `docs/specs/v0.2-secret-lib.md §1` for the incident that motivated the policy.

## Why two halves

Defense in depth. The S3 bucket alone gives an attacker AES-256-GCM ciphertext + the manifest salt — no plaintext. The keychain key alone gives an attacker an AES key for a bundle they cannot reach. **Both** are required to read a secret. The threat model that motivates this: a leaked S3 access key on a laptop where the OS keychain is locked (typical post-laptop-loss scenario).

## How `<repo>` is resolved

v0.9 precedence chain (first match wins, every result passes through `normalize()`):

1. `--repo=<name>` flag
2. `$SECRETS_SYNC_REPO` env var
3. **`git config --get remote.origin.url` → `parseRemoteUrl()` → `<owner>/<repo>`** (the predominant auto-resolver)
4. `basename(process.cwd())`
5. literal `"default"`

Step 3 is the critical change in v0.9: it's derived from the git remote, not the directory name. All worktrees of the same repo (different toplevel paths, same `origin`) resolve to the same canonical name → same `~/.config/vsync/<repo>/`, same keychain entry. No `--repo=` override needed.

`normalize()` rules: lowercase, replace `/` and `-` with `_`, strip anything outside `[a-z0-9._]`, reject if longer than 100 chars.

Example: `https://github.com/Best-Practice-Creations/volentis_mono_repo.git` → `best_practice_creations_volentis_mono_repo`.

## Crypto envelopes — magic bytes are load-bearing

Three nested binary formats. Each has a 4+ byte magic prefix so a wrong-passphrase or corrupt bundle is distinguishable from a wrong-version one:

| Magic | What it wraps | Where | Spec |
|---|---|---|---|
| `RQE1` | AES-256-GCM + PBKDF2-SHA256 (600k iters) | S3 bundle body, share-file inner payload | `docs/specs/v0.2-secret-lib.md` |
| `RQEM0001` | Manifest pointer-seal — embeds timestamp inside the encrypted plaintext so an attacker with bucket write but no keychain key cannot rename an older version onto `latest` | S3 manifest | same |
| `SLS1` | Outer frame of a `.share` file — carries passphrase salt + an `RQE1` envelope of the export blob | `<repo>-<env>.share` | same |

Bumping any magic = breaks every existing deployment. The codebase treats these as constants.

## Spec references

For the exact wire format and threat model:

- `docs/specs/v0.2-secret-lib.md` — original full spec (crypto envelope, threat model, repo-name resolution as originally designed)
- `docs/specs/v0.3-vsync-rebrand.md` — rebrand from `secret-lib`, `infra/vault/<env>/` layout, `sync` verb introduction
- `docs/specs/v0.4-audit-log.md` — append-only audit CSV protocol, ETag-conditional write loop
- `docs/specs/v0.6-vault-relative-file-refs.md` — `*_PATH` resolution semantics
- `docs/specs/v0.7-explicit-sync-parser.md` — explicit `--inline-file-suffix` / `--exclude-property` (no defaults applied by the CLI)
- `docs/specs/v0.8-multi-target-sync.md` — `TargetHandler` interface + 5 fanout backends
- `docs/specs/v0.9-repo-name-resolution.md` — worktree-safe canonical naming (this skill's mental model section reflects v0.9)
