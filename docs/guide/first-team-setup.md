# First team setup

You're a 5–10-person team and someone just decided everyone should stop emailing `.env` files around. This page walks through the decisions and the per-person setup. Read end-to-end before starting.

## The one-time choices

Three decisions to make, in order. Each affects later steps.

### 1. Choose an S3-compatible backend

Anything that speaks the S3 API works:

| Backend | Cost ballpark | Notes |
|---|---|---|
| **AWS S3** | $0.023/GB/mo + egress | Most popular. Bucket-prefix IAM scoping is mature. |
| **Hetzner Object Storage** | €5/mo + €1/TB egress | Inexpensive EU storage. Bucket-prefix IAM via "Sub-Users". The author's daily driver. |
| **Cloudflare R2** | $0.015/GB/mo + **zero egress** | Free egress is great for teams. Account-level IAM. |
| **Backblaze B2** | $0.006/GB/mo + free egress to Cloudflare | Cheapest at rest. Application keys can scope by bucket. |
| **MinIO (self-hosted)** | server cost | Good for air-gapped / regulated environments. |
| **DigitalOcean Spaces** | $5/mo for 250GB | Simple. Limited IAM scoping. |

Picks that work poorly:

- Anything **without** server-side `If-Match` / `If-None-Match` conditional headers — the audit append protocol depends on them ([audit protocol](/architecture/audit-protocol)). All major S3-compatible vendors support these; only some niche self-hosted impls don't.
- Anything **without** per-bucket-prefix IAM scoping — you really want the production read-only IAM key to only see `myapp/prod/`, not your entire account.

### 2. Choose your vault location

By default vsync uses `infra/vault/<env>/` at the repo root. Override at `vsync init` with `--vault-folder=…` if your project conventions differ. Recommendations:

- **`infra/vault/<env>/`** (default) — clean, env-scoped, easy to gitignore.
- **`secrets/<env>/`** — also fine, slightly more discoverable for newcomers.
- **`.vault/<env>/`** — works but is hidden by default in many editors; not recommended.

Make sure the path is **gitignored**. `vsync init` adds the rule automatically; check `.gitignore` after running it.

### 3. Choose your S3 prefix shape

The S3 key prefix for an env is what shows up in `VSYNC_CONFIG` as the `prefix` field. Two patterns:

| Pattern | Example | When |
|---|---|---|
| **One bucket per env**, prefix is the repo | `s3://acme-prod-secrets/myapp/manifest` | Strong IAM isolation between envs |
| **One bucket per repo**, prefix is the env | `s3://myapp-secrets/prod/manifest` | Single bucket to manage; rely on IAM key scoping for env isolation |
| **One bucket account-wide**, prefix is repo+env | `s3://acme-secrets/myapp/prod/manifest` | Many small projects; rely on IAM heavily |

There's no wrong answer; the pattern is enforced by the **profile** you create. See [Profiles](/guide/profiles).

## The provisioning steps (cloud-admin, once)

This is what the cloud-admin / DevOps person does once for the whole team.

### A. Create the bucket

```bash
# AWS example — adapt to your provider
aws s3 mb s3://acme-secrets --region eu-central-1
aws s3api put-bucket-versioning --bucket acme-secrets \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket acme-secrets \
  --server-side-encryption-configuration '{
    "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm":"AES256"}}]
  }'
```

- **Versioning** is your safety net against accidental deletes. Keep it on.
- **SSE-S3 encryption** is belt-and-braces — vsync ships ciphertext, so server-side is redundant on the contents, but it's still the right default for the bucket.
- **Block all public access** at the bucket level — vsync's threat model assumes the bucket is *not* world-readable. (vsync would still encrypt, but defense in depth.)
- **No bucket policy that allows broad access** — IAM keys are the perimeter.

### B. Issue IAM keys

Two key shapes:

| Use case | Permissions | Created for |
|---|---|---|
| **Teammate (read-write within prefix)** | `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on `<prefix>/*` | Each teammate who pushes/pulls |
| **Runtime (read-only within prefix)** | `s3:GetObject`, `s3:ListBucket` on `<prefix>/*` | Each `(env, repo)` runtime |

Recommendation: **one IAM key per teammate** (so the audit log can attribute bucket-side activity), **one read-only IAM key per `(env, repo)` runtime** (so a leak only exposes one env's reads).

Avoid: a single shared IAM key everyone uses. The vsync audit log sees `git_email` so app-side attribution is OK, but bucket-side audit is just "the team key did X" which is much less useful in an incident.

### C. Save the IAM keys somewhere safe

Each teammate gets their own access-key pair. Hand them out via your usual secret-sharing channel (a shared password manager, Bitwarden Send, encrypted email, etc.). Do **not** put them in a Slack message that lives forever.

## Per-teammate setup (5–10 minutes each)

This is what each teammate does on their own machine.

### 1. Install vsync

```bash
bun install -g @muthuishere/vsync
# or:  npm install -g @muthuishere/vsync
vsync --help
```

Requires Bun ≥ 1.2.21 on PATH. See [Install](/guide/install).

### 2. Create a profile with the team's bucket info

```bash
vsync profile add acme-prod
S3 endpoint URL: https://s3.eu-central-1.amazonaws.com
S3 region: eu-central-1
S3 bucket name: acme-secrets
Default prefix (optional): myapp/
Access key ID: AKIA...
Secret access key: ****************
```

The IAM key here is **the teammate's own pair**, not the runtime read-only one (that one gets used later by `vsync runtime-token`).

The profile is stored at `~/.config/vsync/profiles/acme-prod.json` (mode `0600`). It's per-machine; teammates don't share profile files.

See [Profiles](/guide/profiles) for the full verb set.

## Setting up the first env (one person, once per env)

One teammate — let's call them the **owner** — runs the first init. After this, everyone else `import`s a `.share` file.

### Owner's first push

```bash
cd my-project

# 1. Init the env using the profile
vsync init prod --profile=acme-prod
# This generates a per-(repo, env) AES key in the OS keychain,
# writes a per-(repo, env) config file at ~/.config/vsync/<repo>/env_prod,
# and creates infra/vault/prod/.

# 2. Drop your secrets into the vault folder
cat > infra/vault/prod/.env.prod <<'EOF'
DATABASE_URL=postgres://...
STRIPE_KEY=sk_live_...
EOF
cp ~/Downloads/gcp-sa.json infra/vault/prod/

# 3. Push the encrypted bundle
vsync push prod
# → S3: bucket/myapp/prod/manifest + bucket/myapp/prod/v=<ts>
# → audit.csv: one `push` row

# 4. Mint a .share file for the team
vsync export prod
# → ./<repo>-prod.share + a 4-word passphrase printed to terminal
```

### Send the `.share` + passphrase on **different** channels

**Critical:** the `.share` file is passphrase-encrypted; the passphrase is the only thing standing between an interceptor and the vault key. Send them on different channels so a single channel leak doesn't yield both.

| File channel | Passphrase channel |
|---|---|
| Slack DM | SMS / Signal |
| Email attachment | Phone call |
| AirDrop in person | Verbal at the desk |
| Shared password-manager item | The team chat |

Mix and match. The important rule: **never both on the same channel**.

Once each teammate confirms successful import, the owner can delete the `.share` file locally (or keep it in a password manager as a recovery artifact). Vsync doesn't auto-delete it — that's an operator choice.

## Teammate onboarding (each teammate)

```bash
cd my-project   # cloned repo

# 1. Import the share — you'll be prompted for the passphrase
vsync import prod ./myapp-prod.share

# 2. Pull the current vault
vsync pull prod
# → decrypts and unpacks into infra/vault/prod/

# 3. Wire ./.env to the vault file (apps then just `dotenv.config()`)
vsync use prod
# → ./.env symlinks to infra/vault/prod/.env.prod

# 4. (Optional) confirm
vsync status --check-remote
```

That's it. The teammate now has `(disk config, keychain key)` matching the owner's. They can `pull` (to refresh) and `push` (to ship local edits) like everyone else.

## `.share` file etiquette

| | |
|---|---|
| When to create | First teammate onboarding; recovery after a teammate loses their disk + keychain |
| Where to keep | Owner deletes after distribution, or stores in a password manager as recovery |
| When to **not** create | Routine — once teammates are imported, they don't need new `.share` files |
| When to regenerate the passphrase | When you regenerate the file. Passphrase is per-`.share`-file, not per-env. |

**Don't email `.share` files around indefinitely.** Each one is a passphrase-encrypted vault key. Once the team is onboarded, the file's lifecycle is over. The vault key itself doesn't expire — only the passphrase + file pair are time-bound.

## Audit log conventions

The audit log records every `push`, `pull`, `import`, `export`, and `rotate`. Useful conventions:

### Annotate with `--note`

```bash
vsync push prod --note="fix(billing): correct STRIPE_WEBHOOK_SECRET"
vsync pull staging --note="prep for QA cycle"
vsync export dev --note="onboarding new-hire $name"
```

Notes show up in `vsync audit <env>` as their own column. Future-you (or your security auditor) will thank you.

### CI flags via env vars

```bash
# In your CI:
export VSYNC_AUDIT_META='{"run_id":"'"$CI_RUN_ID"'","commit":"'"$GIT_SHA"'"}'
export VSYNC_AUDIT_NOTE="prod deploy"
vsync pull prod
```

Every CI pull now carries the run ID + commit SHA in the `meta` cell.

### Periodic review

Once a quarter:

```bash
vsync audit prod --all > /tmp/audit-prod-$(date +%Y%m%d).csv
```

Open in your spreadsheet tool. Look for:

- `pull` rows from unexpected hostnames or git emails.
- Cadence patterns — a teammate who used to pull daily and now pulls hourly might be running a leaky script.
- `export` rows that don't tie to an onboarding ticket.

The audit log is **not tamper-evident**; bad actors with bucket-write could rewrite it. Treat it as a transparency aid that helps you ask better questions, not a court exhibit.

## Production / runtime setup

This is the runtime-libs side, not the operator side. One-time per env per app:

```bash
# Mint the runtime token (read-only)
vsync runtime-token --env=prod \
  --access-key=$RUNTIME_AKIA \
  --secret-key=$RUNTIME_SECRET
# → vsync-cfg-v1:H4sI...
```

Paste into your platform's secret store as `VSYNC_CONFIG`. The passphrase from `vsync init` (the one that's also baked into every `.share` file) goes in as `VSYNC_PASSPHRASE`.

See [Runtime tokens](/guide/runtime-token) for the per-platform recipes and [Examples](/examples/) for full deploy gallery.

## Offboarding a teammate

When someone leaves:

1. **Revoke their bucket access** at the cloud provider (delete their IAM access key).
2. **Rotate the passphrase** for envs they had access to — [runbook](/guide/rotate-passphrase-runbook). This invalidates the bundle they may have cached in their `~/.config/vsync/` for future fetches (though anything they `pull`-ed before is already plaintext on their disk; that ship sailed).
3. **Re-share** — owner runs `vsync export <env>` again and distributes the new `.share` to surviving teammates. The old `.share` files no longer match the new passphrase.
4. **Rotate upstream secrets** that were in the vault — anyone who already pulled has plaintext copies. Treat their last `pull` like a leak ([incident response case 3](/guide/incident-response#case-3-both-halves-leaked)).

There is no per-user revoke inside vsync. The (repo, env) AES key is shared by everyone with access; offboarding requires re-keying.

## Where to go next

- **Apply a profile to a new env:** [Profiles](/guide/profiles)
- **Daily flow:** [Push / pull / versions](/guide/daily)
- **First app integration:** [Runtime tokens](/guide/runtime-token) + [Examples](/examples/)
- **Audit log:** [Audit log](/guide/audit)
- **Things that go wrong:** [Troubleshooting](/guide/troubleshooting)
- **When things really go wrong:** [Incident response](/guide/incident-response)
