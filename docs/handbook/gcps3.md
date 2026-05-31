# Bucket on Google Cloud Storage

GCS speaks S3 through its **XML API / interoperability** mode. You create a normal GCS bucket, mint an **HMAC key** for a service account, and hand vsync the HMAC pair as if it were an AWS access key. Replace `acme-vault`, the project, and the location with yours.

Prereqs: the [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) authenticated as an admin **for the bucket-creation steps only**. vsync never calls `gcloud` — it talks the S3 XML endpoint directly with the HMAC key.

## 1. Create the bucket

```bash
gcloud storage buckets create gs://acme-vault \
  --project=acme-prod \
  --location=US \
  --uniform-bucket-level-access \
  --public-access-prevention
```

`--uniform-bucket-level-access` + `--public-access-prevention` keep the (encrypted) secrets off the public internet.

## 2. Make a service account for the bot

```bash
gcloud iam service-accounts create acme-vault-bot \
  --project=acme-prod \
  --display-name="vsync vault bot"
```

Grant it object read/write on **just this bucket** (not project-wide):

```bash
gcloud storage buckets add-iam-policy-binding gs://acme-vault \
  --member="serviceAccount:acme-vault-bot@acme-prod.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

`roles/storage.objectAdmin` covers get/put/list/delete on objects — what `push`, `pull`, `versions`, and `audit` need.

## 3. Mint the HMAC key (the S3-compatible credential)

```bash
gcloud storage hmac create \
  acme-vault-bot@acme-prod.iam.gserviceaccount.com \
  --project=acme-prod
```

The output gives you:

- `accessId` — starts with `GOOG...`. This is your **access key ID**.
- `secret` — a base64 string, **shown once**. This is your **secret access key**.

> Console alternative: **Cloud Storage → Settings → Interoperability → Create key for a service account.**

## 4. Save it as a vsync profile

```bash
vsync profile add acme-gcp
```

Answer the prompts:

| Prompt | Value for GCS |
|---|---|
| S3 endpoint URL | `https://storage.googleapis.com` |
| S3 region | `auto` (or the bucket location, e.g. `us`) |
| S3 bucket name | `acme-vault` |
| S3 access key ID | the `GOOG...` `accessId` from step 3 |
| S3 secret access key | the `secret` from step 3 |
| Optional prefix | leave empty, or `acme/` to share the bucket across repos |

Verify:

```bash
vsync profile list
vsync profile show acme-gcp        # secret stays masked
```

**Reuse the profile.** Create it once, bind as many repos/envs as you like — the creds are copied into each env's config at `init` time:

```bash
vsync init dev  --profile=acme-gcp
vsync init prod --profile=acme-gcp
cd ../other-project && vsync init prod --profile=acme-gcp
```

## 5. Bind an env and push

```bash
cd my-project
vsync init prod --profile=acme-gcp

cat > infra/vault/prod/.env.prod <<'EOF'
DATABASE_URL=postgres://user:pass@host/db
API_KEY=sk-...
EOF

vsync push prod
vsync versions prod
vsync audit prod
```

That writes `gs://acme-vault/<repo>/prod/versions/<ts>.enc` and the `…/prod/latest` pointer, reachable through the S3 endpoint.

## 6. Daily loop

The bucket is never mentioned again:

```bash
vsync pull prod                 # get the latest vault before you start
# … edit infra/vault/prod/ …
vsync push prod                 # ship your changes (encrypted, versioned, audited)
vsync use prod                  # ./.env → infra/vault/prod/.env.prod

vsync versions prod
vsync audit prod
```

## 7. Fan out to GitHub Actions — `sync gh`

Push the vault's key/values into GitHub Actions secrets. `--gh-repo` is saved on first run, so later runs are just `vsync sync prod gh`:

```bash
vsync sync prod gh --gh-repo=acme/web

vsync sync prod gh --gh-repo=acme/web \
  --exclude-property=LOCAL_ONLY \
  --inline-file-suffix=_FILE        # FOO_FILE=path → uploads the file's contents as secret FOO
```

Requires the [`gh` CLI](https://cli.github.com) authenticated. Other targets — `gcp`, `aws`, `azure`, `vault` — work the same; see [Fanout to where prod runs](/guide/sync).

## 8. Onboard a new dev

They never get the bucket creds — hand them one encrypted `.share` file:

```bash
# You:
vsync export prod                          # → ./<repo>-prod.share  + a one-time passphrase
```

Send the file and passphrase on **two different channels**.

```bash
# New dev, in the cloned repo:
vsync import prod ./<repo>-prod.share      # paste the passphrase
vsync pull prod
vsync use prod
```

Full teammate flow: [Onboarding teammates](/guide/share).

## Rotating the HMAC key

`gcloud storage hmac create` a new key for the same service account, update the profile, then deactivate + delete the old one (`gcloud storage hmac update … --deactivate`, then `… delete`). Walkthrough: [IAM rotation runbook](/guide/iam-rotation-runbook).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `403` / `AccessDenied` on push | The service account lacks `roles/storage.objectAdmin` on the bucket, or you bound it project-wide but with a weaker role. |
| `SignatureDoesNotMatch` | The HMAC `secret` was truncated on copy — it's base64 and easy to clip. Re-mint. |
| `InvalidAccessKeyId` | You pasted the service-account *email* instead of the `GOOG...` `accessId`. |
| `NoSuchBucket` | `region`/`endpoint` mismatch — keep endpoint `https://storage.googleapis.com` and region `auto`. |
