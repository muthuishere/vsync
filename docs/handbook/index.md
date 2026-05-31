# Onboarding handbook

Pick where your encrypted vault bucket lives, create it once, then point `vsync` at it. The bucket is just S3-compatible object storage — `vsync` does all the crypto, versioning, and audit on top. Everything after "create the bucket" is identical no matter which provider you chose.

| If your bucket lives on… | Use this page |
|---|---|
| **AWS S3** | [AWS S3](/handbook/awss3) |
| **Google Cloud Storage** (S3 interop / HMAC) | [GCP S3](/handbook/gcps3) |
| **Anywhere else** — self-hosted MinIO/Garage on a VPS, Cloudflare R2, Backblaze B2, Wasabi, Hetzner, DigitalOcean Spaces | [Custom S3](/handbook/customs3) |

> Azure Blob Storage has no S3-compatible endpoint, so it can't host a vsync bucket. (Azure *Key Vault* is a `vsync sync` fanout **target** — that's a separate thing from where the vault bucket lives. See [Fanout](/guide/sync).)

## The shape of every setup

Two layers, always the same:

1. **Provider layer (once per bucket):** create an S3 bucket and a machine credential (access key ID + secret) scoped to it. This is the only part that differs per provider.
2. **vsync layer (once per machine, then daily):** save those creds as a named **profile**, bind an env to it with `init`, then `push` / `pull` / `use` / `sync`.

```
provider bucket  ──►  vsync profile  ──►  vsync init <env>  ──►  push / pull / use / sync
   (per page)         (one command)       (per repo+env)         (daily)
```

## What a profile needs

A profile is a named bag of S3 creds at `~/.config/vsync/profiles/<name>.json` (`0600`). Every provider page tells you how to fill these six fields:

| Field | What it is | Notes |
|---|---|---|
| `endpoint` | S3 endpoint URL | `https://…` for TLS, `http://…` for plaintext. The scheme controls TLS — if you type a bare host, vsync assumes `https://`. |
| `region` | S3 region | Real region for AWS (`us-east-1`); `auto` is fine for most S3-compatibles. |
| `bucket` | Bucket name | Must already exist. |
| `accessKeyId` | Access key ID | Machine credential, **not** your console login. |
| `secretAccessKey` | Secret access key | Stored `0600`; entered hidden. |
| `prefix` *(optional)* | Key prefix, e.g. `acme/` | Lets several repos share one bucket. Trailing slash auto-added. |

## The daily flow (provider-independent)

Once the profile exists and `vsync init <env> --profile=<name>` has run, this is the whole loop — it never references the provider again:

```bash
vsync pull <env>      # get the latest vault before you start
# … edit infra/vault/<env>/ …
vsync push <env>      # ship your changes (encrypted, versioned, audited)
vsync use <env>       # ./.env → infra/vault/<env>/.env.<env>  (so dotenv.config() just works)

vsync versions <env>  # list every encrypted version on the bucket
vsync audit <env>     # who pushed/pulled/exported, when
vsync sync <env> gh   # optional: fan the KVs out to GH / GCP / AWS / Azure / Vault secret stores
```

`push` / `pull` carry a lost-update guard (v0.17) and an anti-rollback manifest seal — see [Push / pull / versions](/guide/daily) and [Crypto envelopes](/architecture/crypto) for the why.

## Onboarding a teammate (any provider)

The teammate never touches the bucket creds directly — you hand them an encrypted `.share` file:

```bash
# You (already set up):
vsync export <env>                       # → ./<repo>-<env>.share  + a one-time passphrase

# Teammate:
vsync import <env> ./<repo>-<env>.share  # paste the passphrase
vsync pull <env>
vsync use <env>
```

Send the `.share` file and the passphrase on **two different channels**. Full flow: [Onboarding teammates](/guide/share).

---

Ready? Jump to your bucket's provider: [AWS S3](/handbook/awss3) · [GCP S3](/handbook/gcps3) · [Custom S3](/handbook/customs3).
