---
name: vsync-skill
---

# Sync flags — v0.7+ explicit-flag policy

vsync 0.7 removed every built-in default from the `sync` verb. Each inclusion and exclusion must be passed explicitly on the CLI; the parser policy header prints the active flag set before every run. The reason: silent defaults bit users when their `.env` evolved past what vsync assumed in 0.6 and earlier.

This file covers what those flags are, the standard set most teams converge on, and the traps that come up.

## Routing flags — one required per target

| Target | Required flag(s) | Persists to |
|---|---|---|
| `gh` | `--gh-repo=<owner>/<repo>` | `cfg.sync.gh.repo` |
| `gcp` | `--gcp-project=<project-id>` | `cfg.sync.gcp.project` |
| `aws` | `--aws-region=<region>` + optional `--aws-secret-prefix=<prefix>` | `cfg.sync.aws.{region,secretPrefix}` |
| `azure` | `--azure-vault=<vault-name>` | `cfg.sync.azure.vaultName` |
| `vault` | `--vault-addr=<url>` + `--vault-mount=<mount>` + `--vault-path=<path>` | `cfg.sync.vault.{addr,mount,secretPath}` |

The flag value persists into the config file on first invocation. Subsequent invocations can omit it (still printed in the policy header, with `(from config)` annotation).

## Parser-policy flags — same shape for all 5 targets

The parser turns a `.env.<env>` file into key/value pairs that the target handler pushes. Two flag families control the transformation; both are repeatable:

### `--inline-file-suffix=<SUFFIX>` (repeatable)

Treats env vars whose name ends in `<SUFFIX>` as **path pointers**. The parser opens the file at that path and pushes its bytes under the **stripped** name.

Example:

```
SSH_PRIVATE_KEY_PATH=/Users/me/projects/myapp/infra/vault/dev/keys/myapp_dev
```

With `--inline-file-suffix=_PATH`, the parser pushes:

```
SSH_PRIVATE_KEY = <bytes of /Users/.../myapp_dev>
```

The standard suffix to enable for most teams: `_PATH`. It catches `SSH_PRIVATE_KEY_PATH`, `TLS_CERT_PATH`, `GOOGLE_SERVICE_ACCOUNT_PATH` etc.

### `--exclude-property=<KEY>` (repeatable)

Drops the named key from the sync set. The key still exists in the local `.env.<env>` — it just never leaves the machine. Used for env vars that authenticate the **local** developer to a cloud provider but should not be pushed to the remote target.

Standard exclusions for most teams:

```
--exclude-property=GITHUB_TOKEN                       # gh CLI auth — local only
--exclude-property=GOOGLE_APPLICATION_CREDENTIALS     # gcloud auth — local only
```

## The standard flag set most teams converge on

Codify these in a Taskfile var (see `references/team-setup.md`):

```bash
vsync sync <env> gh \
  --gh-repo=<owner>/<repo> \
  --inline-file-suffix=_PATH \
  --exclude-property=GITHUB_TOKEN \
  --exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

One place to add a new excluded property; the dev and production task chains pick it up automatically.

## The `_FILE` trap

**Do not blindly add `--inline-file-suffix=_FILE`.**

Many apps use `*_FILE` env vars as **filename lookup keys** read at runtime, not paths to be inlined. For example:

```
APP_FIREBASE_SERVICE_ACCOUNT_FILE=myapp-dev.json
```

The app reads `myapp-dev.json` as a *filename string* to look up inside a config bucket. If you add `--inline-file-suffix=_FILE`, the parser opens `./myapp-dev.json` (which may not exist or may be unrelated bytes) and pushes its contents under `APP_FIREBASE_SERVICE_ACCOUNT`. The app then reads bytes where it expected a filename and silently breaks.

Audit every `*_FILE` variable in your env file before adding the `_FILE` suffix. Most teams pick `_PATH` as the inline-suffix convention specifically to avoid this collision.

## Target-specific naming constraints

### Azure Key Vault — no underscores

`az keyvault secret set` rejects secret names containing `_`. vsync surfaces the `az` error rather than silently translating `_` → `-` (per the v0.7 no-magic policy). Operator options:

1. Rename keys in `.env.<env>` to use `-` instead of `_`
2. `--exclude-property=` each offending key
3. Maintain an Azure-shaped overlay env file

A future `--key-translate=<from>:<to>` flag could solve this; out of scope for v0.8 / v0.9.

### AWS Secrets Manager — `/_+=.@-` + alphanumeric

Standard `SCREAMING_SNAKE_CASE` keys work as-is. Use `--aws-secret-prefix=<prefix>/` to namespace one bucket across multiple apps (e.g. `--aws-secret-prefix=myapp/dev/` produces secrets named `myapp/dev/DB_URL`).

### HashiCorp Vault KV v2 — bulk atomic write

The `vault` target is the only one that does a single bulk write (KV v2 is atomic at the secret path). All KVs are passed as positional args to `vault kv put`. Hard limit is `ARG_MAX` (~2 MiB on Linux). If ever hit, a future patch switches to `@file.json` mode; v0.8 lets the `E2BIG` surface loudly.

KV v1, Transit/PKI engines, and Vault namespaces are out of scope.

## Policy header — what every `vsync sync` prints

Before sealing any bytes, vsync prints the active parser policy:

```
sync policy:
  target           : gh
  routing          : muthuishere/vsync           (from config)
  inline-file-suffix: _PATH
  exclude-property  : GITHUB_TOKEN, GOOGLE_APPLICATION_CREDENTIALS
```

This is intentional. The header is auditable — paste it into a PR or incident note when investigating what bytes left the laptop.
