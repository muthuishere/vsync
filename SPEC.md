# `secret-lib` v0.2.0 — Spec

**Status:** in-progress · branch `feat/file-config-and-keychain` · all 114 unit/integration tests green on macOS

A Bun-native CLI for sharing per-environment secrets across a small team. Provides:

1. **Local config** stored on disk + the OS keychain
2. **Encrypted S3 sync** of the actual `.env` + vault folder
3. **Share-by-file** for onboarding new teammates without dumping a giant base64 blob into a shell rc

Supersedes the v0.1.x design (env-var-blob in shell rc).

---

## 1. Why this exists / the problem we're rolling

### v0.1.x model (what's being replaced)

Every consuming repo had to put a single ~700-char base64 blob in `~/.zshrc` as `<PREFIX>_<NAME>` (e.g. `REQSUME_ENV_DEV`). The blob carried bucket creds + encryption key + file paths. To share with a teammate you handed them that giant string out of band.

**Friction observed during 2026-05-14 incident:** even the project owner couldn't find his own `REQSUME_ENV_DEV` value across shell rc, dotfiles, 1Password, or any local file — it had only ever existed in the shell session it was originally generated in. The blob is essentially un-findable once dropped from a shell.

### v0.2.0 model (what this spec describes)

Split the blob into two persistent halves whose locations are well-known and inspectable:

| Half | Where it lives | What's in it |
|---|---|---|
| **Config file** | `${XDG_CONFIG_HOME:-$HOME/.config}/deemwar/config/<repo>/env_<env>` (gzipped JSON, `chmod 0600`) | bucket creds, encryption salt, file paths |
| **Encryption key** | OS keychain via `Bun.secrets` — service `com.deemwar.secret-lib`, account `<repo>/<env>` | the AES-256 key |

For onboarding new teammates: a single passphrase-encrypted **share file** (`<repo>-<env>.share`) that bundles config + key + metadata. Owner runs `export`, sends file + passphrase on different channels, teammate runs `import`. After import their (file, keychain) pair is identical to the owner's; the share file can be discarded.

Goals:

- **Discoverable:** standard XDG path + standard keychain entry; both inspectable with `ls -la` / Keychain Access.app.
- **No shell rc edits:** library never reads, never asks you to set, never prints an `export` line.
- **Lossless sharing:** one share file = identical setup on the other machine.
- **Defence in depth:** an attacker who gets the disk file can hit S3 but not decrypt; an attacker who gets the keychain key can decrypt but not reach the bucket.
- **Reusable across repos:** the same library serves `reqsume`, `video-ai`, `volentis`, etc. — repo identity is auto-detected with override flags.

---

## 2. Non-goals

- **Replacing 1Password / Vault.** This is small-team-friendly secret sync, not a full enterprise secret manager. No audit log, no per-user access, no policy engine.
- **Encrypting the disk config file with its own passphrase.** chmod 0600 in `~/.config/` is the security envelope; if your home dir is compromised, the disk file is the least of your problems.
- **Mutating remote S3 state from within `secret-lib` other than `push`/`pull`.** Bucket lifecycle, IAM, retention policy, etc. live outside this tool.
- **Cross-platform GUI.** This is CLI-only by design.

---

## 3. Architecture overview

```
                            ┌─────────────────────┐
                            │   secret-lib CLI    │
                            └──────────┬──────────┘
                                       │ dispatches
       ┌───────┬───────┬───────┬───────┼───────┬───────┬───────┬───────┐
       ▼       ▼       ▼       ▼       ▼       ▼       ▼       ▼       ▼
   initapp   init   export  import   push    pull   link  show-key  delete-key

      bootstrap                share-file                 day-to-day             inspection
   (scaffold a new repo)   (passphrase-encrypted)        (S3 round-trip)       (keychain ops)

                                       │
                                       │ all subcommands use:
                                       ▼
        ┌─────────────────────────────────────────────────────────────────┐
        │                       loadEnvConfig(repo, env)                  │
        │                                                                 │
        │   reads ConfigFile from disk                                    │
        │   + reads encryption key from OS keychain (Bun.secrets)         │
        │   = returns runtime EnvConfig                                   │
        └─────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │  s3 / archive   │
                              │   crypto/manifest│
                              └─────────────────┘
                                  (unchanged from v0.1.x)
```

---

## 4. Concepts + data shapes

### 4.1 ConfigFile (on disk)

Lives at `~/.config/deemwar/config/<repo>/env_<env>`. Mode `0600`. Parent dir mode `0700`. Format: `gzip(JSON.stringify(ConfigFile))` — raw bytes, no base64 wrapper.

```ts
type ConfigFile = {
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    useSsl: boolean;
  };
  encryption: {
    salt: string;   // PBKDF2 salt, ≥16 chars. Stable per (repo, env).
  };
  files: {
    envFile: string;      // path relative to repo root, e.g. ".env.dev"
    vaultFolder: string;  // path relative to repo root, e.g. "infra/vault/dev"
  };
};
```

**Note:** there is no `encryption.key` in this shape. The key lives in the keychain (next section).

### 4.2 Keychain entry

Stored via `Bun.secrets` (macOS Keychain / Linux libsecret / Windows Credential Manager).

```
service: "com.deemwar.secret-lib"   // UTI per Bun's best-practice guidance
name:    "<repo>/<env>"             // e.g. "reqsume/dev"
value:   <base64 32-byte AES-256 key>
```

Inspectable in macOS Keychain Access.app: search "secret-lib", filter by service, account name shows `<repo>/<env>`.

### 4.3 Runtime EnvConfig

Returned by `loadEnvConfig(repo, env)`. Combines the file and the keychain. This is what every push/pull code path consumes.

```ts
type EnvConfig = ConfigFile & {
  encryption: {
    salt: string;
    key: string;   // spliced in from the keychain
  };
};
```

If the file is missing → throws `ConfigFileMissingError`.
If the file exists but the key is missing → throws `KeyMissingError`.
Both errors carry actionable messages pointing the user at `init` / `import` / `link`.

### 4.4 Share file

The unit of exchange between teammates. A binary file (typically named `<repo>-<env>.share`, `chmod 0600`) that bundles **config + key + metadata** behind a passphrase.

**Wire format:**

```
bytes 0..3      "SLS1"          ASCII magic for the share file itself
byte  4         saltLen         length of the salt that follows (0..255)
bytes 5..5+L    salt            ASCII base64 string used for PBKDF2-SHA256
bytes rest      encrypted blob  output of crypto.encrypt() — has its own "RQE1" magic + 12-byte IV + AES-GCM ciphertext
```

The encrypted plaintext is the gzip+base64 of:

```ts
type ExportPayload = {
  version: 1;
  repo: string;     // e.g. "reqsume"
  env: string;      // e.g. "dev"
  config: ConfigFile;
  key: string;      // the AES key that the recipient will store in their keychain
};
```

Passphrase shape (auto-generated by `export` when not supplied): `XXXX-XXXX-XXXX` (3 hyphen-separated groups of 4 chars from an alphabet that excludes 0/O/1/l/I — easy to read aloud, hard to mis-type).

---

## 5. Repo identity resolution

Every command that touches the file or keychain needs a `repo` namespace. The library resolves it via this precedence chain (first match wins):

1. CLI flag `--repo=<name>` (override)
2. `SECRETS_SYNC_REPO` env var
3. `package.json::name` at the repo root, with leading `@scope/` stripped (so `@muthuishere/secret-lib` → `secret-lib`)
4. `git rev-parse --show-toplevel | basename`
5. `basename(process.cwd())` as a last resort

The result is sanitised to `[A-Za-z0-9._-]+`. Empty result returns `"default"` (degenerate fallback).

This lets the same library serve multiple repos without per-repo config: each repo's `package.json` name acts as its namespace.

---

## 6. CLI surface

All subcommands accept:

- `<env>` positional (lowercased before file/keychain lookup)
- `--repo=<name>` to override auto-detected repo
- `--interactive` to force prompts even when every other flag is provided

Subcommands:

### 6.1 bootstrap

| Cmd | What |
|---|---|
| `initapp` | Scaffold `.env` stubs, `infra/vault/<env>/.gitkeep`, `infra/setup/Taskfile.yml`, append `.gitignore` rules. Flags: `--envs=dev,production` (default `local,dev,production`), `--force` (overwrite), `--no-taskfile`. |

### 6.2 setup + sharing

| Cmd | What |
|---|---|
| `init <env>` | Generate fresh AES-256 key; collect bucket creds via flags + prompts; write `ConfigFile` to disk; save key to keychain. Flags: `--endpoint --region --bucket --access-key --secret-key --use-ssl --env-file --vault-folder --salt`. |
| `export <env>` | Read config + key, build share file at `./<repo>-<env>.share` (or `--out=<path>`); generate (or accept via `--passphrase=…`) a passphrase; print path + passphrase. |
| `import <env> <file>` | Decrypt share file; write `ConfigFile` to disk; save key to keychain. Flags: `--passphrase=…`, `--file=path` (alternative to positional). |
| `link <env> --key=<key>` | Save just the key to the keychain (when file already exists). Rare; mainly for edge cases where someone shipped you the file but the keychain entry got lost. |

### 6.3 day-to-day

| Cmd | What |
|---|---|
| `push <env>` | Zip `envFile + vaultFolder` → manifest-seal → AES-256-GCM encrypt → upload to `s3://<bucket>/<env>/versions/<ts>.enc` + update `s3://<bucket>/<env>/latest` pointer. |
| `pull <env>` | Read `latest` pointer; download version; verify embedded manifest ts matches pointer (anti-rollback); decrypt; unzip into repo root. Auto-backs up existing local state to `~/.config/localdevconfig/<env>-<ts>.zip.enc`. |
| `restore-backup <env> <backup> <target-dir>` | Decrypt a `~/.config/localdevconfig/` backup with the keychain key + on-disk salt. |

### 6.4 inspection

| Cmd | What |
|---|---|
| `show-key <env> [--yes]` | Print the key to stdout. `--yes` (or interactive y/n) gate to prevent screen-share leaks. |
| `delete-key <env> [--yes]` | Remove the keychain entry. Idempotent (no error if missing). |

### 6.5 other

| Cmd | What |
|---|---|
| `sync-secrets <env> <gh\|gcp>` | Existing v0.1.x command; reads `.env.<env>` directly (not via `loadEnvConfig`) and pushes vars to GitHub Repo Secrets or GCP Secret Manager. Untouched by this rewrite. |

---

## 7. Subcommand sequences

### 7.1 First-time owner setup

```bash
bunx @muthuishere/secret-lib initapp                 # scaffold layout
bunx @muthuishere/secret-lib init dev --bucket=… …   # generate key + write config
bunx @muthuishere/secret-lib push dev                # encrypt + upload .env + vault
bunx @muthuishere/secret-lib export dev              # → ./<repo>-dev.share + passphrase
```

### 7.2 Teammate onboarding (recipient)

```bash
bunx @muthuishere/secret-lib import dev ./reqsume-dev.share
# Passphrase: <paste>
bunx @muthuishere/secret-lib pull dev                # decrypt latest bundle
```

After `import`, the teammate's `~/.config/deemwar/config/<repo>/env_dev` + keychain entry mirror the owner's. The `.share` file can be deleted.

### 7.3 Day-to-day

```bash
bunx @muthuishere/secret-lib push dev    # I changed .env.dev locally
bunx @muthuishere/secret-lib pull dev    # I want what the team pushed last
```

### 7.4 Recovering after losing the key

If a teammate's keychain entry is gone (fresh OS install, etc.) but their disk config file is intact:

- Option 1 (recommended): get a fresh `.share` from any other teammate, `import` it. Overwrites both.
- Option 2: get just the key plaintext from any teammate (`show-key`), then `link <env> --key=<paste>`.

If both halves are gone: same as new-teammate onboarding.

---

## 8. Security model

### 8.1 Threat model

| Threat | Defence |
|---|---|
| Attacker reads the disk file | Gets bucket creds. Cannot decrypt any S3 bundle. Cannot push (S3 IAM permits but bundle would be unverifiable to legit pulls due to keyless decrypt failure). |
| Attacker reads the keychain only | Gets the AES key. No bucket location. No reach to S3 at all. |
| Attacker reads both | Compromises the (repo, env). Should rotate immediately (see §10.2). |
| Attacker intercepts the `.share` file | Cannot decrypt without the passphrase. If passphrase also intercepted on the same channel: full compromise. Mitigation: send file + passphrase on different channels. |
| Attacker tampers with an S3 object | Pull-time manifest-pointer check (`embeddedTs === remoteTs`) rejects renamed-old-bundles + AES-GCM auth tag rejects any byte-level tamper. |
| Local-user-on-shared-machine reads the file | `chmod 0600` on the file + `0700` on the dir = POSIX denies other users. macOS Keychain ACLs deny other login sessions. |
| User commits the file to git | `infra/vault/` is in `.gitignore` (added by `initapp`). The disk file at `~/.config/…` is outside any repo. |

### 8.2 Crypto choices

- **PBKDF2-SHA256, 600k iterations** for both the S3-bundle encryption and the share-file wrapper. Matches OWASP 2023 guidance.
- **AES-256-GCM** for the actual encryption. 12-byte random IV per encryption, embedded in the envelope.
- **Magic headers** so a corrupt blob is distinguishable from a wrong passphrase: `RQE1` for the inner crypto envelope, `SLS1` for the share-file outer frame.
- **Manifest pointer seal** for S3 bundles: the timestamp is embedded inside the encrypted plaintext AND used as the S3 pointer value. Prevents an attacker with bucket-write but no key from silently rolling `latest` back to a renamed older version (we verify the two match before unzipping).

### 8.3 Out-of-scope hardening (intentional)

- **No HSM / TPM integration.** The keychain is the strongest secret store we can use with no extra deps.
- **No client-side certificate auth to S3.** Standard IAM access-key pairs only.
- **No audit log of who pulled / pushed what.** Bucket access logs are the substitute.

---

## 9. Acceptance criteria

1. `bun test` → all suites green on macOS (114/114 today). On Linux with libsecret installed, same.
2. `bunx @muthuishere/secret-lib --help` lists every subcommand with a 1-line description.
3. **End-to-end owner→teammate share** flow (manual smoke):
   - `init dev` → file written, key in keychain, `show-key dev --yes` returns same value as `Bun.secrets.get`.
   - `push dev` → object visible in S3 at `<bucket>/dev/versions/<ts>.enc` and `<bucket>/dev/latest` pointer present.
   - `export dev` → `.share` file at default path, passphrase printed.
   - On a second machine (or after wiping keychain + file): `import dev <file>` with the passphrase → file restored, key in keychain, `pull dev` succeeds, repo's `.env.dev` + vault recreated.
4. `initapp` in an empty dir creates the expected layout; idempotent unless `--force`.
5. Repo name auto-detect: in a repo with `package.json::name = "@muthuishere/foo"`, no `--repo` flag and no `SECRETS_SYNC_REPO` → uses `"foo"` for both file path and keychain account.
6. All commands respond to `--interactive` by forcing prompts even when all flags provided.

---

## 10. Roadmap

### 10.1 Out of scope for 0.2.0, in scope for 0.3.x

- **`rotate-key <env>`** — generate a new key, decrypt the latest S3 bundle with the old key, re-encrypt with the new, push, update keychain. (Today: manual `delete-key` + `init` + `push`.)
- **`rotate-passphrase`** — for the next export blob, prompt for a new passphrase (decoupled from the key rotation).
- **Per-team encrypted backup of keys** to a shared cloud bucket — opt-in, encrypted with a team master key from 1Password. Eliminates the "everyone on different keychains" friction.

### 10.2 Operational concerns we should document later

- **Key rotation schedule.** Recommendation TBD (90 days?). Currently no enforcement, no expiry.
- **What to do when a teammate leaves.** Today: rotate. Should be in `onboarding.md` as a checklist.
- **Bucket lifecycle.** Should `versions/` be auto-pruned past N? Outside the library; ops Q.

### 10.3 Possible quality-of-life adds

- `secret-lib doctor` — checks disk file presence, keychain entry, bucket reachability, current `latest` pointer. One-shot health check.
- `secret-lib list` — list every (repo, env) pair on this machine (introspect `~/.config/deemwar/config/`).
- `secret-lib export --to-clipboard` — copy the share file path + passphrase to the macOS clipboard for fast handoff.
- 1Password CLI integration (`op`) for fully-automated share-storage if a teammate uses 1Password.

---

## 11. Migration from 0.1.x

There is no compatibility shim. The env-var loader is deleted. The two paths:

1. **You're the owner of an existing 0.1.x deployment:**
   - Run `init <env>` to bootstrap a fresh (file, keychain) pair with the same bucket creds.
   - Run `push <env>` from the same machine that has the legacy `.env` + vault — overwrites the S3 bundle with the new encryption key.
   - Run `export <env>` and re-share with your team. They run `import` to get the new pair; their old env-var becomes obsolete and can be deleted from their shell rc.

2. **You're joining a project that just upgraded:** wait for the owner to send a `.share` file + passphrase. Run `import` + `pull`. Delete the old env-var from your shell rc.

Old shell-rc entries (`<PREFIX>_<NAME>=<base64>`) are not read by the 0.2.x CLI. They're harmless to leave or remove.

---

## 12. Publishing to npm

```bash
# From the secret-lib repo root, on the feat/file-config-and-keychain branch:
bun test                                           # confirm 114/114 green
npm login                                          # one-time, scoped to @muthuishere
npm publish --access public                        # public publish for the scope
# Verify:
bunx @muthuishere/secret-lib@0.2.0 --help          # should fetch from npm and run
```

`package.json` already has:
- `name: "@muthuishere/secret-lib"`
- `version: "0.2.0"`
- `bin.secret-lib` pointing at `./bin/secret-lib.ts`
- `files: ["bin", "src", "examples", "README.md", "onboarding.md", "using.md"]`
- `publishConfig.access: "public"`
- `engines.bun: ">=1.2.21"` (`Bun.secrets` shipped in 1.2.21)

After publish, consuming repos drop their forked `infra/setup/scripts/` and switch all task invocations to `bunx @muthuishere/secret-lib …`.

---

## 13. Open decisions for the handoff

These weren't locked during design and are listed here so whoever picks this up can make a call:

1. **Pre-publish dogfood.** Should the reqsume monorepo drop its `infra/setup/scripts/` first (and consume the local secret-lib via `bun link`) before npm publish? Lower-risk path. Today we'd just publish + integrate.
2. **`export` default file path.** Today: `./<repo>-<env>.share` in cwd. Alternative: `~/.config/deemwar/share/<repo>-<env>.share` (per-user). cwd is more discoverable for "where did the file go" but pollutes the consuming repo's working directory.
3. **Passphrase complexity.** Today: 12 chars from a 54-char alphabet → ~71 bits of entropy. Is that enough given two-channel sharing? Could bump to 16 chars or word-based (`correct-horse-battery`) for higher type-ability.
4. **Multiple repos with the same `package.json::name`.** Unlikely but possible (forks, monorepos). Today the repo name is also a path component → collision = same config file = stomp. Maybe hash the repo path in addition? Or document the override flag prominently.
5. **Linux + Windows keychain backends.** Tests run on macOS only today; the keychain.test.ts will work on Linux with libsecret if installed, on Windows via Credential Manager (untested by us). Worth a manual smoke before publish.

---

## 14. File map (post-rewrite)

```
secret-lib/
├── bin/
│   ├── secret-lib.ts        ← dispatcher
│   ├── initapp.ts           ← bootstrap scaffold
│   ├── init.ts              ← generate key + write config
│   ├── export.ts            ← share file out
│   ├── import.ts            ← share file in
│   ├── link.ts              ← save just the key
│   ├── push.ts              ← S3 push
│   ├── pull.ts              ← S3 pull
│   ├── show-key.ts          ← inspect (gated)
│   ├── delete-key.ts        ← remove from keychain
│   ├── restore-backup.ts    ← decrypt a local backup
│   └── sync-secrets.ts      ← (untouched) push to GH / GCP secret manager
├── src/
│   ├── keychain.ts          ← Bun.secrets wrapper
│   ├── configfile.ts        ← on-disk gzipped JSON
│   ├── envconfig.ts         ← runtime composite + export blob shape
│   ├── sharefile.ts         ← passphrase-encrypted share file framing
│   ├── passphrase.ts        ← readable passphrase generator
│   ├── repo.ts              ← repo-name resolution chain
│   ├── prompt.ts            ← TTY helpers for interactive mode
│   ├── argv.ts              ← positional + --flag parser
│   ├── codec.ts             ← gzip+base64 framing (used by export blob)
│   ├── crypto.ts            ← AES-256-GCM + PBKDF2-SHA256 envelope
│   ├── manifest.ts          ← pointer-seal for S3 bundles
│   ├── archive.ts           ← zip/unzip helpers
│   ├── backup.ts            ← rolling local backups
│   ├── s3.ts                ← Bun S3 client wrapper
│   ├── syncpool.ts          ← parallel runner for sync-secrets
│   └── envfile.ts           ← (used by sync-secrets) .env parser
├── test/
│   ├── keychain.test.ts     ← NEW
│   ├── configfile.test.ts   ← NEW
│   ├── sharefile.test.ts    ← NEW
│   ├── passphrase.test.ts   ← NEW
│   ├── repo.test.ts         ← NEW
│   ├── envconfig.test.ts    ← rewritten
│   ├── archive.test.ts      ← unchanged
│   ├── argv.test.ts         ← unchanged
│   ├── backup.test.ts       ← unchanged
│   ├── codec.test.ts        ← unchanged
│   ├── crypto.test.ts       ← unchanged
│   ├── envfile.test.ts      ← unchanged
│   └── manifest.test.ts     ← unchanged
├── examples/
│   └── Taskfile.yml         ← rewritten — uses `bunx @muthuishere/secret-lib` + new verbs
├── README.md                ← rewritten
├── onboarding.md            ← rewritten
├── using.md                 ← rewritten
├── SPEC.md                  ← this file
└── package.json             ← 0.2.0
```

---

## 15. Handoff checklist

- [ ] Push the branch: `git push -u origin feat/file-config-and-keychain`
- [ ] Open a PR on the secret-lib repo. Title: `feat: file-config + OS keychain (Bun.secrets) + share file + initapp`. Body can largely copy this spec's §1 and §3.
- [ ] Manual smoke against a real S3-compatible bucket (Backblaze B2 is what reqsume uses): `init` → `push` → `export` → on a second machine `import` → `pull` → verify `.env.<env>` round-tripped.
- [ ] Manual smoke on Linux for `Bun.secrets` (the macOS path is covered by tests; libsecret untested).
- [ ] Decide on the §13 open items.
- [ ] Run `npm publish --access public` after PR merges.
- [ ] In each consuming repo (starting with reqsume), replace `infra/setup/scripts/` with `bunx @muthuishere/secret-lib` invocations + regenerate `infra/setup/Taskfile.yml` via `initapp --force`.

When the bullets above are checked, 0.2.0 is shipped and consumed.
