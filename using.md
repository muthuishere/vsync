# Using — joining an existing project

A teammate sent you a `.share` file (and a passphrase, on a different channel). Here's how to install it.

## Prerequisites

- [Bun](https://bun.sh) 1.2.21+ (for `Bun.secrets`).
- The repo cloned locally.
- The `.share` file your teammate sent.
- The passphrase your teammate sent (separately).

## 1. Install the share file

```bash
cd <repo>
bunx @muthuishere/secret-lib import dev ./reqsume-dev.share
# Passphrase: xK4p-pNm9-Qr2t
```

Done. The CLI:

1. Reads the file
2. Decrypts with the passphrase
3. Writes the config to `~/.config/deemwar/config/<repo>/env_dev` (chmod 0600)
4. Writes the encryption key to your OS keychain (`com.deemwar.secret-lib` / `<repo>/dev`)

You can delete the `.share` file now — its contents are installed.

For non-interactive scripting:

```bash
bunx @muthuishere/secret-lib import dev ./reqsume-dev.share --passphrase=xK4p-pNm9-Qr2t
```

## 2. Pull the encrypted bundle

```bash
bunx @muthuishere/secret-lib pull dev
```

Downloads `s3://<bucket>/dev/latest` → decrypts → unzips into the repo root, replacing `.env.dev` + `infra/vault/dev/`.

Existing local files are automatically backed up to `~/.config/localdevconfig/dev-<ts>.zip.enc` before being overwritten. Two-deep rolling buffer.

## 3. Daily flow

```bash
# Get the latest from S3:
task -t infra/setup/Taskfile.yml dev:pull

# Push your local edits:
task -t infra/setup/Taskfile.yml dev:push
```

## Inspecting your local state

```bash
bunx @muthuishere/secret-lib show-key dev --yes   # print the key (confirm intent)
ls -la ~/.config/deemwar/config/<repo>/          # see config files on disk
```

## Removing local state

```bash
bunx @muthuishere/secret-lib delete-key dev --yes # remove key from OS keychain
rm ~/.config/deemwar/config/<repo>/env_dev       # remove config file
```

Re-install at any time with another `import`.

## Troubleshooting

**"no config file for <repo>/<env>"** — you haven't imported (or initialised) this env yet. Get a `.share` from a teammate and run `import`.

**"encryption key for <repo>/<env> not found in OS keychain"** — the file exists but the key isn't in your keychain. Either:
- Re-run `import` with the `.share` (it carries both).
- If you only have the key (not the file), run `secret-lib link <env> --key=<key>`.

**"failed to decrypt share file — passphrase wrong or file corrupt"** — double-check the passphrase. If it still fails, ask the sender to re-export and re-share both.

**"pointer claims X but bundle was sealed as Y"** during `pull` — defensive check failed. Someone with bucket write access pointed `latest` at a renamed older bundle, but the embedded manifest timestamp doesn't match. Refuse + report to ops.
