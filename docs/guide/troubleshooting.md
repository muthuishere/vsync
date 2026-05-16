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

## `gh` / `gcloud` not found on PATH

Install and authenticate them locally. vsync shells out; it doesn't manage external CLI auth.

- GitHub CLI: [cli.github.com](https://cli.github.com)
- gcloud CLI: [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

After install: `gh auth login` / `gcloud auth login`.

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
