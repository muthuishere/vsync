# vsync

**An encrypted vault for your environment secrets — shared across your team, mirrored to GitHub / GCP / AWS / Azure / HashiCorp Vault, audited every time someone touches it.**

![vsync flow](https://raw.githubusercontent.com/muthuishere/vsync/main/docs/public/vsync-flow.png)

A CLI for owners and CI, plus runtime libraries in **Python, TypeScript, Go, and Java** for apps that need to read the vault at boot. Same wire format across all four languages; every binding passes the same conformance corpus.

📖 **Full documentation:** **<https://muthuishere.github.io/vsync/>**

---

## Install

```bash
bun  install -g @muthuishere/vsync     # or:  npm install -g @muthuishere/vsync
vsync --help
```

Requires Bun ≥ 1.2.21 on PATH (`Bun.secrets` lives there). Don't want a global install? `bunx @muthuishere/vsync <subcommand>` works too.

---

## Two-minute quickstart

```bash
# One-time per machine — name your S3 backend
vsync profile add hetzner-personal              # endpoint, bucket, IAM key

# Per repo + env
vsync init dev --profile=hetzner-personal       # generates per-(repo, env) key + config
echo "DB_URL=postgres://..." > infra/vault/dev/.env.dev
vsync push dev                                  # encrypt + upload to S3

# Onboard a teammate
vsync export dev                                # → ./<repo>-dev.share + passphrase
# Send the file + passphrase on different channels.

# Teammate side
vsync import dev ./<repo>-dev.share             # config + key into keychain
vsync pull dev && vsync use dev                 # ./.env → infra/vault/dev/.env.dev

# Production app — mint a bootstrap token
vsync runtime-token --env=prod                  # → vsync-cfg-v1:... (paste into your platform's secret store)
```

[Full quickstart →](https://muthuishere.github.io/vsync/guide/quickstart) · [Command reference →](https://muthuishere.github.io/vsync/guide/commands) · [Architecture →](https://muthuishere.github.io/vsync/architecture/mental-model)

---

## Runtime libraries

Read the vault inside your app — two env vars, one S3 round trip at boot, in-memory `getEnv` / `getAsContent` accessor with a deterministic fallback chain:

| Language | Package | Install |
|---|---|---|
| **Python** (reference impl) | [`vsync-s3-client`](https://pypi.org/project/vsync-s3-client/) | `pip install vsync-s3-client` |
| **TypeScript / Node** | [`@muthuishere/vsync-s3-client`](https://www.npmjs.com/package/@muthuishere/vsync-s3-client) | `npm install @muthuishere/vsync-s3-client` |
| **Go** | [`github.com/muthuishere/vsync/libraries/go`](https://pkg.go.dev/github.com/muthuishere/vsync/libraries/go) | `go get …@v0.11.0` |
| **Java** | [`io.github.muthuishere:vsync-s3-client`](https://central.sonatype.com/artifact/io.github.muthuishere/vsync-s3-client) | Maven coordinate, JDK 17+ |

```python
# Python — same shape in every language, idiomatic naming
import vsync_s3_client

with vsync_s3_client.open() as v:
    db_url   = v.get_env("DATABASE_URL")          # str | None
    has_key  = v.has_env("STRIPE_KEY")            # bool
    src      = v.env_source("DATABASE_URL")       # "vault" | "env" | "default" | "missing"
    sa_bytes = v.get_as_content("gcp-sa.json")    # bytes — operator writes tempfile if needed
```

[Libraries documentation →](https://muthuishere.github.io/vsync/libraries/) · [Examples gallery →](https://muthuishere.github.io/vsync/examples/)

---

## Fanout to where prod runs

`vsync sync <env> <target>` pushes the env's keys to:

- `gh` — GitHub Actions secrets
- `gcp` — GCP Secret Manager
- `aws` — AWS Secrets Manager
- `azure` — Azure Key Vault
- `vault` — HashiCorp Vault KV v2

One edit in the vault; every place that needs the secret stays in step. [Sync targets →](https://muthuishere.github.io/vsync/guide/sync)

---

## What's in the box

- **CLI** at `bin/vsync.ts` (Bun-native, ships as `@muthuishere/vsync` on npm)
- **Runtime libraries** at `libraries/{python,typescript,go,java}/` — at `v0.11.0` (catch up to CLI's `0.13.0` in next release), all behaviorally identical
- **Conformance corpus** at `docs/specs/test-vectors/` — every library passes the same 31 vectors
- **Specs** at `docs/specs/` — versioned design notes (v0.2 envelope, v0.4 audit log, v0.10 CLI verbs, v0.11 test vectors, v0.12 runtime lib API, v0.13 profile system, v0.16 git-only identity + `.vsync` pin, v0.17 pull-safety ledger)
- **Site** at `docs/` — VitePress, auto-deployed to <https://muthuishere.github.io/vsync/>

---

## Security model — read the docs, not the marketing

- AES-256-GCM bundles. Per-machine AES key in the OS keychain. The bucket alone is useless; the key alone is useless. Both halves required.
- The two-input runtime bootstrap (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`) is **separation-of-leak-channels**, not MFA. Full process compromise leaks both. [Trust ceiling, verbatim →](https://muthuishere.github.io/vsync/architecture/security)
- Pre-1.0 (`0.x.x`). Wire format may break between minors. **No backwards-compat shims.** Plan for at least 12 months at `0.x` before `1.0` — see [versioning](https://muthuishere.github.io/vsync/guide/versioning).

---

## Versioning

Current CLI release: **`0.13.0`**. Runtime libraries are at `0.11.0` and will catch up to `0.13.0` when the v0.15 lib redesign lands.

- `0.13.0` `vsync docs` is now a CLI capability guide ("what vsync does + how"), not a committable repo file. New offline runbooks: `vsync docs aws | gcp | custom` (create the S3 bucket → profile → init/push/pull/use/sync) and `vsync docs agent` (intent→command map for AI assistants); `vsync docs list` indexes them. New `vsync --version` / `-v`. Onboarding handbook added to the docs site. Packaging fix: dropped a stale `skills` entry from the npm `files` list so `bun install -g` no longer warns.
- `0.12.0` **Breaking.** Git is now a precondition — every subcommand errors outside a git tree. `SECRETS_SYNC_REPO` is gone (use `--repo=<name>`). New committed `.vsync` identity pin file ([v0.16](docs/specs/v0.16-repo-identity-git-only.md)). `vsync pull` refuses on unsynced local edits; `vsync push` refuses when remote has advanced — `--backup` / `--force` escape hatches ([v0.17](docs/specs/v0.17-pull-safety.md)). New typed errors render without stack traces. `vsync status` adds a prefix block showing identity source.
- `0.11.0` Profile system replaces single defaults. New `vsync runtime-token`, `vsync rotate-passphrase`, `vsync status` subcommands. Four runtime libraries: Python (reference impl), TypeScript, Go, Java. Detailed `--help` on every subcommand. [Upgrade notes →](https://muthuishere.github.io/vsync/guide/upgrade-to-0.11)
- `0.8.0` Multi-target sync — `aws`, `azure`, `vault` joined `gh`, `gcp`. [`docs/specs/v0.8-multi-target-sync.md`](docs/specs/v0.8-multi-target-sync.md)
- `0.7.0` Explicit `vsync sync` parser — no implicit policy. [`docs/specs/v0.7-explicit-sync-parser.md`](docs/specs/v0.7-explicit-sync-parser.md)
- `0.4.0` Append-only audit log on the bucket. [`docs/specs/v0.4-audit-log.md`](docs/specs/v0.4-audit-log.md)
- `0.2.0` Original spec — RQE1 envelope + RQEM0001 manifest seal. [`docs/specs/v0.2-secret-lib.md`](docs/specs/v0.2-secret-lib.md)

[Full changelog →](https://muthuishere.github.io/vsync/guide/versioning)

---

## License

MIT. © Muthukumaran Navaneethakrishnan.
