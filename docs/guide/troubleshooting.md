# Troubleshooting

## `no config file for <repo>/<env>`

The per-(repo, env) file isn't on disk.

- **You own this env:** `vsync init <env>` creates one.
- **A teammate already set it up:** ask them to `vsync export <env>` and send you the `.share` + passphrase, then `vsync import <env> <file>`.

## `encryption key for <repo>/<env> not found in keychain`

The disk file exists but the keychain entry is gone (someone wiped Keychain Access, or you imported the config without the key).

- **Re-`import`** the `.share` (carries both halves — config + key).
- **OR `vsync init <env>`** — generates a fresh key. Any prior S3 bundle for this (repo, env) becomes inaccessible to you. Re-`push` from local to seed the new key. **Coordinate with the team** before doing this — it invalidates everyone else's pulls until they re-import.

## `failed to decrypt share file — passphrase wrong or file corrupt`

Double-check the passphrase. Whitespace and case matter. If still failing, ask the sender to re-`export` — the file may have been truncated in transit.

## `pointer claims X but bundle was sealed as Y` during pull

Defensive anti-rollback check failed. Someone with bucket-write access pointed `latest` at a renamed older bundle, but the embedded manifest timestamp doesn't match. Refuse + report to ops.

This is the manifest pointer-seal (`RQEM0001`) doing its job. See [Crypto envelopes](/architecture/crypto).

## `failed to decrypt s3://… — the keychain key for <repo>/<env> doesn't match the bundle's seal`

The key in your keychain wasn't the one used to seal the bundle. Most likely cause: someone re-`init`-ed the (repo, env), pushed a new bundle, and forgot to re-`export` for you. Get a fresh `.share` from them.

## My `GITHUB_TOKEN` got pushed to GitHub Actions

As of **v0.7**, vsync has no implicit excludes. A bare `vsync sync dev gh` will push every KV in `.env.<env>` — including `GITHUB_TOKEN` and `GOOGLE_APPLICATION_CREDENTIALS`. Pre-0.6 silently skipped both; that magic is gone.

To restore the old behavior, name the exclusions explicitly:

```bash
vsync sync dev gh \
  --exclude-property=GITHUB_TOKEN \
  --exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

`--exclude-property` is repeatable — one occurrence per key. Drop the flag set into your Taskfile / CI so the policy is visible at the call site. See [v0.7 migration](/specs/v0.7-explicit-sync-parser#_5-migration-0-6-x-→-0-7-0).

## My `FOO_PATH` arrived as a path string instead of file contents

Same story: as of **v0.7** the `_PATH` / `_FILE` suffix-to-file rule is no longer applied automatically. A bare `vsync sync` pushes `FOO_PATH=keys/foo` as the literal string `keys/foo`.

Opt in explicitly:

```bash
vsync sync dev gh \
  --inline-file-suffix=_PATH \
  --inline-file-suffix=_FILE
```

Repeatable — one suffix per occurrence. Add any custom suffixes your project uses (`_KEY`, `_CERT`, etc.) the same way. See [Fanout — file references](/guide/sync#file-references-in-env-env-explicit-opt-in).

## AWS: `aws secretsmanager` errors with `ResourceNotFoundException`

Expected on the first push to a brand-new key — vsync probes with `describe-secret` and switches to `create-secret` when the secret doesn't exist yet. The line shows up only because the AWS CLI prints to stderr before exiting non-zero; vsync swallows the exit code and continues with `create-secret`. If the message keeps appearing on subsequent runs of the *same* key, the real cause is a **region mismatch** — `--aws-region` is missing, wrong, or pointing at a region where the secret was never created.

```bash
# Check what's persisted in the per-(repo, env) config:
gunzip -c ~/.config/vsync/<repo>/env_<env> | jq .sync.aws
```

Set the right region with `--aws-region=<region>` (saved on first use) and re-run.

## Azure: `az keyvault secret set` rejects my key with "name does not match"

Azure Key Vault accepts only `0-9 A-Z a-z -` in secret names. An underscore in your `.env.<env>` (e.g. `DATABASE_URL`) fails at push time with a name-validation error from `az`.

**vsync deliberately does not translate `_` → `-`** — that's the v0.7 no-magic theme. Operator options:

- Rename the key in `.env.<env>` to use a dash (`DATABASE-URL=…`).
- Skip the offending keys with `--exclude-property=DATABASE_URL` (repeatable).
- Maintain an Azure-shaped env file alongside the shared one.

See [Fanout — `vsync sync <env> azure`](/guide/sync#vsync-sync-env-azure) for the full constraint discussion.

## Vault: `vault kv put` fails with "permission denied" or "no handler for route"

Two distinct causes, same surface:

- **`no handler for route`** — `--vault-mount` points at something that isn't a KV v2 mount. vsync only supports KV v2 (KV v1, Transit, PKI, namespaces are out of scope). Check with `vault secrets list` and pass the right mount.
- **`permission denied`** — the token from `vault login` (in `~/.vault-token`) lacks `create` / `update` capability on `<mount>/data/<secretPath>`. Talk to whoever manages your Vault policies; vsync doesn't elevate or refresh tokens.

vsync writes the whole KV map in **one atomic `vault kv put`** — either everything lands or nothing does. There's no partial-success state to recover from.

## `gh` / `gcloud` / `aws` / `az` / `vault` not found on PATH

Install and authenticate them locally. vsync shells out for all five sync targets; it doesn't manage external CLI auth for any of them.

- GitHub CLI: [cli.github.com](https://cli.github.com)
- gcloud CLI: [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)
- AWS CLI: [aws.amazon.com/cli](https://aws.amazon.com/cli/)
- Azure CLI: [learn.microsoft.com/cli/azure/install-azure-cli](https://learn.microsoft.com/cli/azure/install-azure-cli)
- HashiCorp Vault CLI: [developer.hashicorp.com/vault/install](https://developer.hashicorp.com/vault/install)

After install: `gh auth login` / `gcloud auth login` / `aws configure` (or `aws sso login`) / `az login` / `vault login`.

## `warning: failed to record audit entry: …` after a successful push/pull

The parent command succeeded; only the audit-append failed. Possible causes:

- **403 AccessDenied** — your IAM key can't write to `audit.csv` (read-only setup). Silently skipped; nothing to do.
- **5xx / network error** — transient bucket failure. Pull/push still succeeded.
- **412 Precondition Failed × 3** — three concurrent writers raced for the audit log. Your row was dropped after the third retry; the others probably landed. Re-running the command with `--no-audit` (then a manual `vsync audit` to confirm) is fine.

See [Audit append protocol](/architecture/audit-protocol) for the retry logic.

## `./.env exists as a regular file — refusing to touch it`

`vsync use` won't clobber a real `.env`. Move or delete it first:

```bash
mv .env .env.local.bak
vsync use dev
```

There is no `--force` flag — by design. See [Switching envs — safety](/guide/use#safety-never-clobber-a-real-file).

## Windows: `EPERM` when running `vsync use`

Windows symlinks require either:

- **Developer Mode** — Settings → Privacy & security → For developers
- OR **elevated terminal** — Run as administrator

vsync catches `EPERM` and prints this hint.

## Tests failing on Linux

`bun test test/keychain.test.ts` requires libsecret (`gnome-keyring`, `keepassxc-secret-service`, etc.). Headless Linux without one of these will fail keychain tests.

## "It worked yesterday and now nothing pushes"

Check `vsync versions <env>` — does the bucket still have your bundles?

Check S3 credentials in the disk config:

```bash
gunzip -c ~/.config/vsync/<repo>/env_<env> | jq .s3
```

Then try a direct `aws s3 ls s3://<bucket>/<repo>/<env>/` with those creds. If that fails, the issue is bucket-side (creds rotated, bucket permissions changed) — not vsync.

---

Still stuck? [Open an issue](https://github.com/muthuishere/vsync/issues) with the command you ran + the full error message.
