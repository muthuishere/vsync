# What lives in the vault

Whatever your app needs at runtime that you'd otherwise scatter across Slack DMs, a password manager, or `~/Downloads/`:

```
infra/vault/
  dev/
    .env.dev                  # KV secrets — vsync sync ships these to gh/gcp
    gcp-sa.json               # JSON service account key
    regression-fixture.json   # test data that mirrors prod shape
    tls/cert.pem
    tls/key.pem
  production/
    .env.production
    gcp-sa.json
```

vsync doesn't care what's in there — it zips and seals the whole folder. The `.env.<env>` file is special only in that `vsync sync` reads it for KV fanout to GitHub / GCP. Everything else (JSON keys, certs, regression fixtures, anything binary) just rides along in the encrypted bundle and lands back on every teammate's disk after `pull`.

So regression tests, scripts, or any tool that needs real-shape inputs read directly from `infra/vault/<env>/whatever.json` — no separate test-data dance.

## The default layout

`infra/vault/<env>/` is the default vault folder per (repo, env). For `env=dev`, expect:

- `infra/vault/dev/.env.dev` — the KV file
- `infra/vault/dev/...` — anything else you put there

`vsync push dev` zips this whole folder and uploads to `s3://<bucket>/<repo>/dev/versions/<ts>.enc`. `vsync pull dev` unpacks into the same path.

## Custom vault path (monorepos)

```bash
vsync init dev --vault-folder=apps/web/infra/vault/dev
```

The path is stored in the per-(repo, env) config and carried in the `.share` file so teammates inherit it automatically — they don't need to remember the flag.

## What NOT to put in the vault

- **Generated build output.** Vault contents get encrypted + bundled on every push. Big binaries make pushes slow and bundles huge.
- **Application code.** vsync isn't a code distribution mechanism. Use git.
- **Anything that shouldn't be shared with every teammate who can pull this env.** vsync has no per-user access — anyone with the (repo, env) keychain key sees everything in that env.

## Gitignore the vault folder

vsync warns at `init` time if `infra/vault/` isn't in your `.gitignore`. The vault contents are **plaintext** on disk after a successful `pull` — never commit them.

Add to `.gitignore`:

```
infra/vault/
.env
```

`.env` is for the `vsync use` symlink — see [Switching envs](/guide/use).

---

[Next: Switching envs — `vsync use` →](/guide/use)
