# `vsync` v0.3.0 — Spec

**Status:** design · target package `@muthuishere/vsync` · breaking rename of `@muthuishere/secret-lib` 0.2.x

A rebrand + opinionation cut. `secret-lib` becomes `vsync`. The library was already moving toward "S3 is the canonical vault; everything else is a mirror"; this spec commits to that model and removes everything inessential to it.

For prior design context (threat model, crypto envelope, manifest seal, repo-name resolution), see `SPEC.md` — v0.2.0. This document only covers what changes.

---

## 1. Diff from 0.2.0

| | 0.2.0 | 0.3.0 |
|---|---|---|
| npm | `@muthuishere/secret-lib` | `@muthuishere/vsync` |
| Bin | `secret-lib` | `vsync` |
| Keychain UTI | (0.2.x service) | `tools.vsync` |
| Config root | (0.2.x path under `~/.config/`) | `~/.config/vsync/<repo>/env_<env>` + optional `~/.config/vsync/defaults` |
| Env file path | `.env.<env>` at repo root | `<vaultFolder>/.env.<env>`, default `infra/vault/<env>` |
| Vault folder | `infra/vault/<env>` (configurable, prompted) | Default `infra/vault/<env>`, `--vault-folder=<path>` override on `init` |
| Scaffolding | `initapp` writes stubs + Taskfile + `.gitignore` rules | Dropped. `init` warns if the vault folder's parent isn't in `.gitignore`. Onboarding docs via `vsync docs` (stdout). |
| External fanout | `sync-secrets <env> <gh\|gcp>` | `sync <env> <gh\|gcp\|all>` |
| Verb count | initapp, init, export, import, link, push, pull, show-key, delete-key, restore-backup, sync-secrets — 11 | init, export, import, push, pull, versions, sync, docs — 8 |

---

## 2. Naming (locked)

- npm: `@muthuishere/vsync`
- Bin: `vsync` — single CLI entry, dispatcher pattern unchanged from 0.2.x
- Keychain service: `tools.vsync`
- Keychain account: `<repo>/<env>` (unchanged)

---

## 3. Layout

### 3.1 User machine

```
${XDG_CONFIG_HOME:-~/.config}/vsync/
  defaults                    # optional template — pre-fills `init` prompts only
  <repo>/
    env_dev                   # self-contained per-(repo, env) config
    env_production
  backups/
    <env>-<ts>.zip.enc        # auto-backup before each pull
```

Files `chmod 0600`, dirs `chmod 0700`, gzip(JSON) — same wire conventions as 0.2.x.

### 3.2 Consuming repo

Default layout (single-repo, no overrides):

```
infra/vault/
  dev/
    .env.dev
    some-secret.json
    ...
  production/
    .env.production
```

`.env.<env>` lives **inside** the vault folder. There is no `.env.<env>` at the repo root. The consuming app points dotenv (or equivalent) at it:

```js
dotenv.config({ path: `infra/vault/${env}/.env.${env}` });
```

`vsync init` prints this one-liner so users copy it once.

**Monorepos** override the vault folder per (repo, env) at `init` time:

```bash
vsync init dev --vault-folder=apps/foo/infra/vault/dev
```

The override is stored in the per-repo config (§4.2), used by every subsequent `push`/`pull`/`sync`, and carried in the `.share` file so teammates inherit it. Path is interpreted relative to the git toplevel (or `cwd` if no git).

---

## 4. Config model — one file per (repo, env)

Every push/pull/sync resolves to a single self-contained file plus the keychain. No layered merge, no runtime composition between defaults and per-repo, no `Partial<S3Credentials>` half-states. If the file is on disk, it's complete; if it isn't, you re-`init`.

```ts
loadEnvConfig(repo, env):
  cfg = await loadRepoEnv(repo, env)        // complete or null
  if (!cfg) throw ConfigFileMissingError
  key = await getKey(repo, env)
  if (!key) throw KeyMissingError
  return { ...cfg, encryption: { ...cfg.encryption, key } }
```

### 4.1 Defaults template (`~/.config/vsync/defaults`, optional)

```ts
type Defaults = {
  version: 1;
  s3?: {
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    useSsl?: boolean;
  };
};
```

Read by `init` only, exclusively to pre-fill prompts. Never consulted at push/pull/sync time. The first-ever `init` on a machine writes this file from the user-supplied values; subsequent inits pre-fill from it. The user can edit it by hand; nothing else depends on it.

### 4.2 Per-repo file (`~/.config/vsync/<repo>/env_<env>`)

Complete and self-contained:

```ts
type RepoEnvConfig = {
  version: 1;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    useSsl: boolean;
  };
  encryption: { salt: string };             // always present, random per init
  files?: { vaultFolder?: string };         // override default `infra/vault/<env>`
  sync?: {
    gh?:  { repo: string };                 // "owner/name"
    gcp?: { project: string };
  };
};
```

Written by `vsync init` (S3 + salt + any `--vault-folder`), `vsync import` (full config from team's `.share`), or `vsync sync` first-run (adds `sync.gh` / `sync.gcp`).

### 4.3 Keychain

```
service: "tools.vsync"
account: "<repo>/<env>"
value:   <base64 32-byte AES-256 key>
```

---

## 5. CLI surface

All commands accept `--repo=<name>` (override auto-detected repo name) and `--interactive` (force prompts even when every other flag is provided). Repo-name precedence chain unchanged from 0.2.x.

**Every command works fully via flags or fully via prompts.** Tests cover both modes per command — no separate doctrine, no rule section.

### 5.1 Init

| Cmd | What |
|---|---|
| `init <env>` | Generate AES key (→ keychain), write self-contained per-repo file (S3 + salt + optional `--vault-folder` for monorepos), create the resolved vault folder, relocate any pre-existing root `.env.<env>` into it (with a prompt), warn if the vault folder's parent isn't in `.gitignore`, print dotenv snippet. First-ever invocation on the machine also writes `~/.config/vsync/defaults` from the supplied values; subsequent inits read defaults to pre-fill prompts. |

Flags: `--bucket --endpoint --region --access-key --secret-key --use-ssl --vault-folder --migrate-from=<path> --no-migrate`.

The only filesystem artefact `init` writes inside the repo is the resolved vault folder (and possibly relocates one pre-existing `.env.<env>` into it).

#### Migration of an existing root `.env.<env>`

`init` looks for `.env.<env>` at the repo root (or `--migrate-from=<path>` if supplied). If found:

1. Prompt: `Move existing .env.dev to infra/vault/dev/.env.dev? [Y/n]` (default Y, skipped with `--no-migrate`).
2. On Y, `mv` the file.
3. On N, leave alone and print a one-line warning naming the new path.

This is the *only* thing migrated. v0.2.x on-disk config and keychain entries are not auto-read. Re-`init` from scratch is the supported path. See §7.

### 5.2 Sharing

| Cmd | What |
|---|---|
| `export <env> [--out=<path>] [--passphrase=<p>]` | Build `.share` carrying the full per-repo config + key. Recipients don't need any prior `init` on their machine. |
| `import <env> <file> [--passphrase=<p>]` | Decrypt, write per-repo file from team's payload, save key to keychain. Idempotent — re-importing overwrites. |

### 5.3 Day-to-day

| Cmd | What |
|---|---|
| `push <env>` | Zip the resolved vault folder → manifest-seal → AES-256-GCM → upload to `s3://<bucket>/<repo>/<env>/versions/<ts>.enc` + update `s3://<bucket>/<repo>/<env>/latest`. |
| `pull <env>` | Pointer → version → manifest-ts verify → decrypt → unzip into the resolved vault folder. Auto-backs up existing contents to `~/.config/vsync/backups/<env>-<ts>.zip.enc` (the format and decryption procedure are documented in `vsync docs`). |
| `versions <env>` | List `s3://<bucket>/<repo>/<env>/versions/` — one line per `<ts>.enc` with size + age, `* latest` marker on the active one. Read-only; no decrypt. |

### 5.4 External fanout

| Cmd | What |
|---|---|
| `sync <env> <gh\|gcp\|all>` | Read `<resolved-vault-folder>/.env.<env>` → push each KV to the named target. First run prompts for routing config (gh repo / gcp project), saves to the per-repo file under `sync.gh` / `sync.gcp`. Subsequent runs zero-prompt. `all` = every configured target. |

#### Routing config

Routing config lives in the per-repo vsync config, not in the env file. The env file holds pure secrets.

| Target | Routing field | Source on first run |
|---|---|---|
| `gh` | `sync.gh.repo` (e.g. `muthuishere/reqsume`) | prompt, or `--gh-repo=<owner/name>` |
| `gcp` | `sync.gcp.project` (e.g. `reqsume-dev`) | prompt, or `--gcp-project=<id>` |

Once saved, both subsequent local invocations and teammates who `vsync import` inherit the routing automatically (the `.share` file carries the per-repo config).

#### Path-expansion + skip rules (unchanged from 0.2.x)

- **Path → content inlining.** `GCP_SA_KEY_FILE_PATH=<path>` → contents pushed as `GCP_SA_KEY` (validated as JSON). `SSH_KEY_PATH=<path>` → `SSH_PRIVATE_KEY`.
- **Local-only skip.** `GITHUB_TOKEN` and `GOOGLE_APPLICATION_CREDENTIALS` are never pushed — they're auth for `gh` / `gcloud` on the local machine.

Everything else is pushed verbatim.

### 5.5 Docs

| Cmd | What |
|---|---|
| `docs` | Print a short reference (commands, vault layout, backup decryption procedure, agent rules) to stdout. User redirects if they want a file: `vsync docs > infra/AGENTS.md`. Content lives as a static string in `src/templates/docs.md.ts` so it ships with the binary and stays in sync with the verb set. |

---

## 6. Wire-format version bumps

- **Share file inner payload** (`ExportPayload`): `version: 1` → `2`. Shape changes (no more `files.envFile`; S3 fields are required, not Partial; gains optional `sync.gh` / `sync.gcp` blocks; `files.vaultFolder` becomes optional and only present when overridden). 0.2.x `.share` files cannot be imported by a 0.3.x client. Outer `SLS1` framing unchanged.
- **Per-repo config file:** new `version: 1` field. 0.2.x's on-disk format had none and lived at a different path — no collision possible.
- **Defaults template:** new file, `version: 1`. Optional.
- **Crypto / manifest magics** (`RQE1`, `RQEM0001`): unchanged.

---

## 7. Migration policy

0.3.0 is a clean break. `@muthuishere/secret-lib` 0.2.x stays on npm forever; users who can't migrate keep using it. Existing users on a 0.2.x deployment re-`init` from scratch (which auto-relocates the root `.env.<env>` per §5.1). Any leftover 0.2.x on-disk config tree and keychain entries can be deleted at any time; nothing in 0.3.x reads them.

---

## 8. Unchanged from 0.2.0

- AES-256-GCM + PBKDF2-SHA256 (600k) — `src/crypto.ts` (magic `RQE1`).
- Manifest pointer-seal anti-rollback — `src/manifest.ts` (magic `RQEM0001`).
- Repo-name precedence — `src/repo.ts`.
- Argv parser, prompt helpers, `Bun.S3Client` wrapper.
- Threat model — see SPEC.md §8.
- Test convention: `test/<module>.test.ts` colocated, `XDG_CONFIG_HOME` override in `beforeAll`.

---

## 9. File map (post-rewrite)

```
vsync/
├── bin/
│   ├── vsync.ts            # dispatcher (renamed from secret-lib.ts)
│   ├── init.ts             # writes self-contained per-repo file + defaults template
│   ├── export.ts           # payload v2
│   ├── import.ts           # payload v2
│   ├── push.ts             # uses resolved vault folder
│   ├── pull.ts             # uses resolved vault folder
│   ├── versions.ts         # NEW — list s3://<bucket>/<repo>/<env>/versions/ for this (repo, env)
│   ├── sync.ts             # renamed from sync-secrets.ts, routing moved to per-repo
│   └── docs.ts             # NEW — prints static reference to stdout
├── src/
│   ├── repoconfig.ts       # rewritten from configfile.ts — self-contained
│   ├── defaults.ts         # NEW — defaults template (read by init only)
│   ├── envconfig.ts        # rewritten — load + splice key, no merge
│   ├── keychain.ts         # service rename
│   ├── sharefile.ts        # payload v2
│   ├── passphrase.ts
│   ├── repo.ts
│   ├── prompt.ts
│   ├── argv.ts
│   ├── codec.ts
│   ├── crypto.ts
│   ├── manifest.ts
│   ├── archive.ts
│   ├── backup.ts
│   ├── s3.ts
│   ├── syncpool.ts
│   ├── envfile.ts          # kept; used by sync.ts to parse .env.<env>
│   └── templates/
│       └── docs.md.ts      # static content emitted by `vsync docs`
├── test/                   # parallel; path-touching tests rewritten
├── README.md               # rewritten
├── SPEC.md                 # v0.2.0 (historical)
├── SPEC-v0.3.md            # this file
└── package.json            # name, bin, version 0.3.0
```

Dropped from 0.2.x: `bin/initapp.ts`, `bin/link.ts`, `bin/show-key.ts`, `bin/delete-key.ts`, `bin/restore-backup.ts`, `examples/Taskfile.yml`, `onboarding.md`, `using.md` (folded into README + `vsync docs`).

---

## 10. Acceptance criteria

1. `bun test` green on macOS.
2. `bunx @muthuishere/vsync --help` lists exactly: `init`, `export`, `import`, `push`, `pull`, `versions`, `sync`, `docs`.
3. End-to-end on a real bucket:
   - First-ever `vsync init dev` → key in keychain, per-repo file written, `~/.config/vsync/defaults` written, vault folder created.
   - Subsequent `vsync init prod` pre-fills S3 prompts from `defaults`.
   - User creates `infra/vault/dev/.env.dev`, runs `vsync push dev` → object visible at `s3://<bucket>/dev/versions/<ts>.enc` + `latest` pointer.
   - Second machine: clone repo, `vsync import dev <share-file>`, `vsync pull dev` → `infra/vault/dev/.env.dev` restored. No prior `vsync init` on the second machine.
4. `vsync sync dev gh` → GitHub Repo Secrets reflect `infra/vault/dev/.env.dev`. First run prompts for repo; subsequent runs zero-prompt.
5. `vsync init` warns when the vault folder's parent isn't in `.gitignore` (does not auto-write — user's call).
6. Repo-name auto-detect unchanged: scope-stripped `package.json::name` → git toplevel basename → cwd basename.
7. `vsync docs` exits 0, writes ≥1KB of markdown to stdout, output lists every command in §5.
8. Per-command: at least one integration test per command exercises flag-mode (no TTY, all flags) and prompt-mode (mock TTY, no flags). No meta-rule test.

---

## 11. Out of scope for 0.3.0

- `vsync run <env> -- <cmd>` — env-export wrapper that exec's the user's command with vars injected.
- `vsync rotate-key`, `vsync doctor`, `vsync list` — carried over from 0.2.x roadmap.
- `vsync pull <env> --version=<ts>` and `vsync rollback` — `versions` covers "see what's there"; rollback via cloud provider CLI in the rare case it's needed.
- `vsync diff <ts1> <ts2>` — decrypt-both-and-diff.
- Linux libsecret / Windows Credential Manager smoke (untested on those platforms; same caveat as 0.2.x).

---

## 12. Handoff checklist

- [ ] Branch off `main` → `feat/v0.3-vsync-rebrand`.
- [ ] Rewrite per file map (§9).
- [ ] Update `package.json`: `name`, `bin`, `version: 0.3.0`.
- [ ] Rewrite tests touching paths/keychain.
- [ ] Manual smoke against a real S3 bucket per §10.3.
- [ ] Manual smoke on Linux for `Bun.secrets` + libsecret.
- [ ] Publish: `npm publish --access public`.
- [ ] Sunset note on `@muthuishere/secret-lib` README pointing at `@muthuishere/vsync`.
