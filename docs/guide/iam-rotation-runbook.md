# Rotating the IAM key — runbook

`vsync` deliberately has no IAM admin permissions. IAM key rotation is owned by your cloud-admin team (or by AWS Secrets Manager / Hetzner / R2 auto-rotation, where supported). vsync's job is to **re-mint the bootstrap blob** once the new key exists and update wherever `VSYNC_CONFIG` is stored.

This page is the step-by-step procedure. For the design rationale, see [Runtime token guide §IAM rotation](/guide/runtime-token#iam-key-rotation-done-externally-then-re-mint) and [spec v0.10 §5](/specs/v0.10-runtime-token-cli).

## What's different from passphrase rotation

| | Passphrase rotation | IAM key rotation |
|---|---|---|
| What's being rotated | The string used as PBKDF2 input to decrypt the bundle | The IAM access key embedded in `VSYNC_CONFIG` that authorises the S3 read |
| Who runs the rotation | A teammate with the env initialized (any laptop) | Cloud-admin team (or auto-rotation tooling) |
| vsync verb | `vsync rotate-passphrase` (re-encrypts the bundle in-place) | None — vsync doesn't touch IAM. You re-mint with `vsync runtime-token --access-key=... --secret-key=...` |
| Bundle changes? | **Yes** — new ciphertext, new salt, `gen` bumps | **No** — the bundle on S3 is byte-identical before and after |
| Race window? | Yes — new bundle live, but apps still have old passphrase | Yes — apps still have old IAM key until restart |
| Audit log row | `action=rotate` — vsync logs it | None from vsync side — cloud provider's IAM audit log is the record |

## When to rotate IAM

| Trigger | Urgency |
|---|---|
| `VSYNC_CONFIG` blob leaks (contains the IAM key + bucket location) | rotate **now** |
| Routine schedule (90-day key max-age policy is common) | scheduled |
| Cloud-admin policy mandates rotation after a team member offboards | scheduled with the offboarding |
| Bucket-side IAM audit shows access from an unexpected source | rotate **now**, audit further |

You do **not** need IAM rotation when:

- The passphrase leaks ([passphrase runbook](/guide/rotate-passphrase-runbook)).
- A bundle leaks (ciphertext; IAM access doesn't change that).
- An app instance's `/proc/<pid>/environ` was dumped — at that point the attacker has both `VSYNC_CONFIG` and `VSYNC_PASSPHRASE`. Rotate **both**, then assume vault compromise.

## Prerequisites

You need:

- Cloud-admin (or IAM auto-rotation) to issue a **new IAM key** with the same read-only bucket-scoped policy as the old one. (Don't reuse keys across envs; one key per `(env, bucket-prefix)`.)
- The ability to keep both keys active briefly (overlap window), then deactivate the old one.
- A machine with `vsync` initialized for this `(repo, env)` — your laptop.
- Write access to the platform secret store.

## The procedure

### 0. Pre-flight

```bash
vsync status --check-remote
# Confirm env is in `ok` state, no drift, no orphans.
```

```bash
# Check what's currently in VSYNC_CONFIG by decoding it locally
vsync runtime-token --env=prod --no-validate \
  | sed 's/^vsync-cfg-v1://' \
  | base64 --decode 2>/dev/null \
  | gunzip 2>/dev/null \
  | jq '{endpoint, region, bucket, prefix, accessKeyId}'
# (note the secretAccessKey field is intentionally omitted)
```

You want to confirm the bucket / endpoint / prefix is what you expect before generating a new blob.

### 1. Cloud-admin issues the new IAM key

This step happens outside vsync.

**AWS example** (read-only, scoped to one bucket prefix):

```bash
aws iam create-access-key --user-name vsync-prod-reader
# → returns AccessKeyId + SecretAccessKey — save these
```

The IAM policy on the user should be:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::your-bucket",
      "arn:aws:s3:::your-bucket/myapp/prod/*"
    ]
  }]
}
```

Bucket-scoped, prefix-scoped, read-only. No `PutObject`. The runtime libraries never write to S3 — IAM enforces that perimeter.

**Hetzner / Backblaze / R2** — generate via the provider's UI. Same scoping discipline applies.

### 2. Re-mint the bootstrap blob

```bash
vsync runtime-token --env=prod \
  --access-key=AKIA_NEW \
  --secret-key=NEW_SECRET
```

By default, `runtime-token` validates the new creds against S3 (`HEAD <prefix>manifest`) before emitting the blob — wrong creds fail loud at issue time. If you see `exit 2` ("credentials accepted by S3 but cannot read `<prefix>manifest`"), the new key's IAM policy is wrong; fix the policy and re-run.

Output is the new blob, single line on stdout:

```
vsync-cfg-v1:H4sIAAAA...new...
```

Pipe-friendly: `vsync runtime-token --env=prod --access-key=… --secret-key=… | pbcopy` on macOS.

### 3. Stage the new blob in the secret store

Update `VSYNC_CONFIG` everywhere the env runs:

- **AWS Secrets Manager:** `aws secretsmanager update-secret --secret-id <id> --secret-string '<new-blob>'`.
- **Vercel:** UI → Environment Variables → `VSYNC_CONFIG` → edit value → Save. Mark **Sensitive** if it isn't already.
- **GCP Secret Manager:** `gcloud secrets versions add vsync-prod-config --data-file=-` then paste.
- **Azure Key Vault:** `az keyvault secret set --vault-name <v> --name vsync-prod-config --value '<new-blob>'`.
- **`VSYNC_CONFIG_FILE` on a VPS:** stage at `/etc/vsync/config.new`, then `mv /etc/vsync/config.new /etc/vsync/config` (atomic).

### 4. Roll-restart

```bash
# Kubernetes
kubectl rollout restart deployment/<your-app> -n <ns>

# AWS ECS
aws ecs update-service --cluster <c> --service <s> --force-new-deployment

# GCP Cloud Run / Vercel — secret update typically triggers new revisions automatically;
# if not, force one.

# VPS / systemd
sudo systemctl restart myapp@*.service
```

Apps already running keep working — they're using a connection that was authenticated with the old key on the original `open()`. But that connection is gone after restart, and the runtime lib doesn't re-fetch ([pull-once semantics](/libraries/#pull-once-semantics-no-refresh-no-daemon)). So restart is the mechanism.

### 5. Verify

```bash
# The new key reads OK
vsync runtime-token --env=prod --access-key=AKIA_NEW --secret-key=NEW_SECRET
# Should exit 0 with the validation HEAD succeeding.

# Apps are running on the new revision
kubectl get pods -n <ns> -l app=<your-app>
# Confirm rollout is complete.

# Healthcheck still reports fresh
curl https://yourapp.com/healthz
# → {"status":"fresh","gen":<same gen — IAM rotation doesn't bump gen>}
```

### 6. Deactivate the old IAM key

Only after step 5 verifies — apps must be on the new key first.

```bash
# AWS
aws iam update-access-key --access-key-id AKIA_OLD --status Inactive
# Then, after a hygiene window (24h is typical):
aws iam delete-access-key --access-key-id AKIA_OLD
```

The `Inactive` step is the safety net — if you missed an instance still using the old key, it starts failing instead of silently working with a soon-to-be-deleted credential. Watch your cloud's IAM audit log for any 403 spikes during the inactive window. If clean, delete.

## Failure modes

| Failure | Symptom | Recovery |
|---|---|---|
| `vsync runtime-token` exit 2 | "credentials accepted by S3 but cannot read `<prefix>manifest`" | New IAM key's policy is wrong. Fix the policy, re-run runtime-token. |
| `vsync runtime-token` exit 3 | "could not reach `<endpoint>`" | Network/DNS/TLS issue from your laptop. The new key is fine; try again from a different network. |
| Old blob still in some pods after step 4 | Healthcheck reports `S3UnreachableError` after step 6 | Stragglers on the old key. Force-restart them. |
| Validation HEAD returned 404 | "manifest does not exist yet" warning on runtime-token | Env was never pushed. Run `vsync push <env>` from a laptop first. Not fatal — the blob is still minted. |

## Where to go next

- **Passphrase rotation** (different concern, same urgency model): [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook)
- **Full leak response checklist:** [Incident response](/guide/incident-response)
- **Runtime token guide:** [Runtime tokens](/guide/runtime-token)
- **Spec:** [`v0.10 §5 — IAM rotation`](/specs/v0.10-runtime-token-cli)
