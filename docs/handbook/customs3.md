# Bucket on your own S3 (VPS / S3-compatible)

Any S3-compatible endpoint works as a vsync bucket. This page walks through **self-hosting [MinIO](https://min.io) on a VPS** end-to-end, then lists the drop-in settings for the common managed S3-compatibles (R2, B2, Wasabi, Hetzner, Spaces) — they're all the same six profile fields, only the endpoint changes.

vsync never calls a provider CLI here; it talks raw S3 to whatever endpoint you give it.

## Option A — Self-host MinIO on a VPS

### 1. Run MinIO

On a VPS with Docker (put it behind your reverse proxy / TLS for production):

```bash
docker run -d --name minio \
  -p 9000:9000 -p 9001:9001 \
  -v /srv/minio/data:/data \
  -e MINIO_ROOT_USER=admin \
  -e MINIO_ROOT_PASSWORD='change-me-long-random' \
  quay.io/minio/minio server /data --console-address ":9001"
```

- `:9000` — the S3 API endpoint (what vsync talks to).
- `:9001` — the web console.

For a real deployment, terminate TLS in front (Caddy/nginx/Traefik) so the endpoint is `https://s3.example.com`, not a bare IP. vsync decides TLS from the URL scheme: `https://` = TLS, `http://` = plaintext.

### 2. Create the bucket and a scoped key

Using the [`mc` client](https://min.io/docs/minio/linux/reference/minio-mc.html) (point it at your server first with `mc alias set`):

```bash
mc alias set acme https://s3.example.com admin 'change-me-long-random'
mc mb acme/acme-vault

# A dedicated access key (don't reuse the root creds):
mc admin user svcacct add acme admin
# → prints an Access Key and Secret Key — copy both.
```

That service-account pair is what goes into the profile. (You can scope it to the bucket with `--policy` if you want least-privilege; the default inherits the parent user's permissions.)

### 3. Save it as a vsync profile

```bash
vsync profile add acme-minio
```

| Prompt | Value for self-hosted MinIO |
|---|---|
| S3 endpoint URL | `https://s3.example.com` (or `http://1.2.3.4:9000` for a bare, untls'd box) |
| S3 region | `us-east-1` (MinIO's default; `auto` also works) |
| S3 bucket name | `acme-vault` |
| S3 access key ID | the `mc admin user svcacct` Access Key |
| S3 secret access key | the matching Secret Key |
| Optional prefix | leave empty, or `acme/` to share the bucket across repos |

### 4. Bind an env and push

```bash
cd my-project
vsync init prod --profile=acme-minio

cat > infra/vault/prod/.env.prod <<'EOF'
DATABASE_URL=postgres://user:pass@host/db
API_KEY=sk-...
EOF

vsync push prod
vsync versions prod
vsync audit prod
```

## Option B — Managed S3-compatibles

Same `vsync profile add` flow — only `endpoint` (and sometimes `region`) changes:

| Provider | `endpoint` | `region` | Where to get the key |
|---|---|---|---|
| **Cloudflare R2** | `https://<accountid>.r2.cloudflarestorage.com` | `auto` | R2 dashboard → Manage R2 API Tokens |
| **Backblaze B2** | `https://s3.<region>.backblazeb2.com` | e.g. `us-west-004` | B2 → App Keys (use the S3-compatible key) |
| **Wasabi** | `https://s3.<region>.wasabisys.com` | e.g. `us-east-1` | Wasabi console → Access Keys |
| **Hetzner Object Storage** | `https://<region>.your-objectstorage.com` | e.g. `fsn1` | Hetzner Cloud → Object Storage → credentials |
| **DigitalOcean Spaces** | `https://<region>.digitaloceanspaces.com` | e.g. `nyc3` | API → Spaces Keys |

Create a bucket in that provider's console (or its CLI), generate an S3 access key/secret, then:

```bash
vsync profile add acme-r2          # or whichever
# endpoint = the row above, region = the row above, then bucket + keys
vsync init prod --profile=acme-r2
vsync push prod
```

## Reuse the profile

Create it once, bind as many repos/envs as you like — the creds are copied into each env's config at `init` time:

```bash
vsync init dev  --profile=acme-minio
vsync init prod --profile=acme-minio
cd ../other-project && vsync init prod --profile=acme-minio
```

## Daily loop

Provider-independent from here on — the bucket is never mentioned again:

```bash
vsync pull prod                 # get the latest vault before you start
# … edit infra/vault/prod/ …
vsync push prod                 # ship your changes (encrypted, versioned, audited)
vsync use prod                  # ./.env → infra/vault/prod/.env.prod

vsync versions prod
vsync audit prod
```

## Fan out to GitHub Actions — `sync gh`

Push the vault's key/values into GitHub Actions secrets. `--gh-repo` is saved on first run, so later runs are just `vsync sync prod gh`:

```bash
vsync sync prod gh --gh-repo=acme/web

vsync sync prod gh --gh-repo=acme/web \
  --exclude-property=LOCAL_ONLY \
  --inline-file-suffix=_FILE        # FOO_FILE=path → uploads the file's contents as secret FOO
```

Requires the [`gh` CLI](https://cli.github.com) authenticated. Other targets — `gcp`, `aws`, `azure`, `vault` — work the same; see [Fanout to where prod runs](/guide/sync).

## Onboard a new dev

They never get the bucket creds — hand them one encrypted `.share` file:

```bash
# You:
vsync export prod                          # → ./<repo>-prod.share  + a one-time passphrase

# New dev, in the cloned repo (send file + passphrase on two channels):
vsync import prod ./<repo>-prod.share      # paste the passphrase
vsync pull prod
vsync use prod
```

Full teammate flow: [Onboarding teammates](/guide/share).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Connection refused / TLS error | Endpoint scheme wrong — use `http://` for a plain box, `https://` only if TLS is actually terminated. Check the port (`:9000` for raw MinIO). |
| `SignatureDoesNotMatch` | Wrong secret, or the provider needs a specific `region` string (B2/Wasabi/Spaces are region-sensitive). |
| `NoSuchBucket` | Bucket not created yet, or a typo — create it in the console/`mc` first; vsync never auto-creates buckets. |
| Works locally, not from prod box | The VPS firewall blocks egress to the endpoint, or the endpoint isn't resolvable from there. |
