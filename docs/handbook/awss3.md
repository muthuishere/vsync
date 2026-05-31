# Bucket on AWS S3

End-to-end: create an S3 bucket and a scoped IAM key, save it as a vsync profile, then run the daily loop. Everything here is copy-paste; replace `acme-vault`, the region, and the account ID with yours.

Prereqs: the [`aws` CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) authenticated as an admin **for the bucket-creation steps only**. vsync itself never calls the `aws` CLI — it talks S3 directly with the access key you generate below.

## 1. Create the bucket

```bash
# us-east-1 is special — it rejects a LocationConstraint:
aws s3api create-bucket --bucket acme-vault --region us-east-1

# Any other region needs the constraint:
aws s3api create-bucket --bucket acme-vault --region eu-central-1 \
  --create-bucket-configuration LocationConstraint=eu-central-1
```

Lock it down — this bucket holds (encrypted) secrets:

```bash
aws s3api put-public-access-block --bucket acme-vault \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Optional belt-and-suspenders — bucket-level versioning on top of vsync's own:
aws s3api put-bucket-versioning --bucket acme-vault \
  --versioning-configuration Status=Enabled
```

## 2. Create a scoped IAM user + access key

Don't reuse your personal keys. Make a dedicated machine user whose only power is this one bucket.

```bash
aws iam create-user --user-name acme-vault-bot
```

Save this policy as `acme-vault-policy.json` (the `ListBucket` statement powers `vsync versions`; `Get`/`Put` power pull/push/audit):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListTheBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::acme-vault"
    },
    {
      "Sid": "ReadWriteObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::acme-vault/*"
    }
  ]
}
```

Attach it inline and mint an access key:

```bash
aws iam put-user-policy --user-name acme-vault-bot \
  --policy-name acme-vault-rw \
  --policy-document file://acme-vault-policy.json

aws iam create-access-key --user-name acme-vault-bot
```

The output's `AccessKeyId` and `SecretAccessKey` are what you'll paste into the profile. **The secret is shown once** — copy it now.

## 3. Save it as a vsync profile

```bash
vsync profile add acme-aws
```

Answer the prompts:

| Prompt | Value for AWS S3 |
|---|---|
| S3 endpoint URL | `https://s3.eu-central-1.amazonaws.com` (your region) |
| S3 region | `eu-central-1` (the real region — **not** `auto`) |
| S3 bucket name | `acme-vault` |
| S3 access key ID | the `AccessKeyId` from step 2 |
| S3 secret access key | the `SecretAccessKey` from step 2 |
| Optional prefix | leave empty, or `acme/` to share the bucket across repos |

Verify:

```bash
vsync profile list
vsync profile show acme-aws        # secret stays masked
```

**Reuse the profile.** You create it once per machine and bind as many repos/envs to it as you like — the creds get copied into each env's config at `init` time:

```bash
# different envs of the same repo:
vsync init dev  --profile=acme-aws
vsync init prod --profile=acme-aws

# a totally different repo, same bucket (a prefix keeps them apart):
cd ../other-project
vsync init prod --profile=acme-aws
```

## 4. Bind an env and push

```bash
cd my-project
vsync init prod --profile=acme-aws    # generates the AES key, writes config + .vsync pin
```

Put secrets in the vault folder, then push:

```bash
cat > infra/vault/prod/.env.prod <<'EOF'
DATABASE_URL=postgres://user:pass@host/db
API_KEY=sk-...
EOF

vsync push prod
```

That uploads `s3://acme-vault/<repo>/prod/versions/<ts>.enc` and flips `…/prod/latest` to it. Confirm:

```bash
vsync versions prod
vsync audit prod
```

## 5. Daily loop

Identical to every other provider — the bucket is never mentioned again:

```bash
vsync pull prod                 # get the latest vault before you start
# … edit infra/vault/prod/ …
vsync push prod                 # ship your changes (encrypted, versioned, audited)
vsync use prod                  # ./.env → infra/vault/prod/.env.prod  (dotenv.config() just works)

vsync versions prod             # list every encrypted version on the bucket
vsync audit prod                # who pushed/pulled/exported, when
```

## 6. Fan out to GitHub Actions — `sync gh`

Push the vault's key/values into your repo's GitHub Actions secrets so CI has them. Routing (`--gh-repo`) is saved to the env config on first run, so later runs are just `vsync sync prod gh`:

```bash
vsync sync prod gh --gh-repo=acme/web

# refine which keys go up (both flags repeatable; omit for "send everything as-is"):
vsync sync prod gh --gh-repo=acme/web \
  --exclude-property=LOCAL_ONLY \
  --inline-file-suffix=_FILE        # FOO_FILE=path  →  uploads the file's contents as secret FOO
```

Requires the [`gh` CLI](https://cli.github.com) authenticated (`gh auth login`). Other targets — `gcp`, `aws`, `azure`, `vault` — work the same way; see [Fanout to where prod runs](/guide/sync).

## 7. Onboard a new dev

The new dev never gets the bucket creds — you hand them one encrypted `.share` file:

```bash
# You (already set up):
vsync export prod                          # → ./<repo>-prod.share  + a one-time passphrase (printed once)
```

Send the `.share` file and the passphrase on **two different channels** (file via Slack, passphrase via SMS/password manager).

```bash
# New dev, in the cloned repo:
vsync import prod ./<repo>-prod.share      # paste the passphrase when prompted
vsync pull prod                            # decrypt + unpack into infra/vault/prod/
vsync use prod                             # ./.env → infra/vault/prod/.env.prod
```

Done — their `dotenv.config()` reads `./.env`. Full teammate flow: [Onboarding teammates](/guide/share).

## Rotating the key

When you rotate the IAM access key, update the profile and every env keeps working. See the [IAM rotation runbook](/guide/iam-rotation-runbook).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `AccessDenied` on `push` | Policy missing `s3:PutObject` on `arn:…/*`, or wrong bucket ARN. |
| `AccessDenied` on `vsync versions` | Missing the `s3:ListBucket` statement (it's on the bucket ARN, no `/*`). |
| `PermanentRedirect` / region errors | `region` in the profile doesn't match the bucket's actual region. |
| Works for you, fails for a teammate | They imported the `.share` (config + key) but their profile/creds are irrelevant — the config carries its own creds. Re-`export`/`import` if the bucket moved. |
