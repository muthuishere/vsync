// Per-provider onboarding runbooks emitted by `vsync docs <topic>`.
//
// These mirror docs/handbook/*.md but are link-free, terminal-friendly,
// and shipped as string exports so the full setup walkthrough is available
// offline straight from the binary:
//
//   vsync docs aws      # bucket on AWS S3
//   vsync docs gcp      # bucket on Google Cloud Storage (HMAC interop)
//   vsync docs custom   # self-hosted MinIO / any S3-compatible (VPS, R2, B2, …)
//
// Keep these in sync with docs/handbook/ when the CLI surface changes.

export type HandbookTopic = {
  /** Canonical key, used as the displayed command (`vsync docs <key>`). */
  key: string;
  /** Extra names that resolve to this topic. */
  aliases: string[];
  /** One-line summary for the topic list. */
  summary: string;
  /** Full runbook body (Markdown, link-free). */
  body: string;
};

export const HANDBOOK_AWS = `# vsync — bucket on AWS S3

Create an S3 bucket + a scoped IAM key, save it as a vsync profile, then run
the daily loop. Replace acme-vault / the region / the account with yours.
The 'aws' CLI is only needed to create the bucket — vsync talks S3 directly
with the key you generate.

## 1. Create the bucket

  # us-east-1 rejects a LocationConstraint:
  aws s3api create-bucket --bucket acme-vault --region us-east-1

  # any other region needs it:
  aws s3api create-bucket --bucket acme-vault --region eu-central-1 \\
    --create-bucket-configuration LocationConstraint=eu-central-1

  # lock it down (it holds encrypted secrets):
  aws s3api put-public-access-block --bucket acme-vault \\
    --public-access-block-configuration \\
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

## 2. Create a scoped IAM user + access key

  aws iam create-user --user-name acme-vault-bot

Save this as acme-vault-policy.json (ListBucket powers 'vsync versions';
Get/Put power pull/push/audit):

  {
    "Version": "2012-10-17",
    "Statement": [
      { "Effect": "Allow", "Action": ["s3:ListBucket"],
        "Resource": "arn:aws:s3:::acme-vault" },
      { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"],
        "Resource": "arn:aws:s3:::acme-vault/*" }
    ]
  }

  aws iam put-user-policy --user-name acme-vault-bot \\
    --policy-name acme-vault-rw --policy-document file://acme-vault-policy.json
  aws iam create-access-key --user-name acme-vault-bot   # AccessKeyId + SecretAccessKey (shown once)

## 3. Save it as a vsync profile

  vsync profile add acme-aws
    S3 endpoint URL      https://s3.eu-central-1.amazonaws.com   (your region)
    S3 region            eu-central-1   (the real region — NOT 'auto')
    S3 bucket name       acme-vault
    S3 access key ID     <AccessKeyId from step 2>
    S3 secret access key <SecretAccessKey from step 2>
    Optional prefix      (empty, or acme/ to share the bucket across repos)

  vsync profile list
  vsync profile show acme-aws            # secret stays masked

## 4. Reuse the profile (create once, bind many)

  vsync init dev  --profile=acme-aws
  vsync init prod --profile=acme-aws
  cd ../other-project && vsync init prod --profile=acme-aws   # same bucket, use a prefix

## 5. Bind an env and push

  cd my-project
  vsync init prod --profile=acme-aws     # generates the AES key + config + .vsync pin
  # put secrets in infra/vault/prod/.env.prod (and any JSON keys/certs)
  vsync push prod                        # → s3://acme-vault/<repo>/prod/versions/<ts>.enc
  vsync versions prod
  vsync audit prod

## 6. Daily loop

  vsync pull prod      # get the latest before you start
  # … edit infra/vault/prod/ …
  vsync push prod      # ship (encrypted, versioned, audited)
  vsync use prod       # ./.env → infra/vault/prod/.env.prod  (dotenv.config() just works)

## 7. Fan out to GitHub Actions (sync gh)

  vsync sync prod gh --gh-repo=acme/web                 # --gh-repo saved on first run
  vsync sync prod gh --gh-repo=acme/web \\
    --exclude-property=LOCAL_ONLY \\
    --inline-file-suffix=_FILE                          # FOO_FILE=path → file contents as secret FOO
  # needs the gh CLI authenticated. Other targets: gcp | aws | azure | vault.

## 8. Onboard a new dev (they never get the bucket creds)

  # you:
  vsync export prod                         # → ./<repo>-prod.share + a one-time passphrase
  # send the .share file and passphrase on TWO different channels
  # new dev, in the cloned repo:
  vsync import prod ./<repo>-prod.share     # paste the passphrase
  vsync pull prod
  vsync use prod

## Troubleshooting

  AccessDenied on push          policy missing s3:PutObject on arn:…/*
  AccessDenied on versions      missing the s3:ListBucket statement (bucket ARN, no /*)
  PermanentRedirect/region      profile 'region' ≠ the bucket's actual region
`;

export const HANDBOOK_GCP = `# vsync — bucket on Google Cloud Storage

GCS speaks S3 via its XML API / interoperability mode. Create a GCS bucket,
mint an HMAC key for a service account, and hand vsync the HMAC pair as if it
were an AWS access key. The 'gcloud' CLI is only needed to create the bucket.

## 1. Create the bucket

  gcloud storage buckets create gs://acme-vault \\
    --project=acme-prod --location=US \\
    --uniform-bucket-level-access --public-access-prevention

## 2. Make a service account for the bot

  gcloud iam service-accounts create acme-vault-bot \\
    --project=acme-prod --display-name="vsync vault bot"

  gcloud storage buckets add-iam-policy-binding gs://acme-vault \\
    --member="serviceAccount:acme-vault-bot@acme-prod.iam.gserviceaccount.com" \\
    --role="roles/storage.objectAdmin"

## 3. Mint the HMAC key (the S3-compatible credential)

  gcloud storage hmac create \\
    acme-vault-bot@acme-prod.iam.gserviceaccount.com --project=acme-prod
    accessId → GOOG...   (your access key ID)
    secret   → base64    (your secret access key — shown once)
  # Console: Cloud Storage → Settings → Interoperability → Create key for a service account.

## 4. Save it as a vsync profile

  vsync profile add acme-gcp
    S3 endpoint URL      https://storage.googleapis.com
    S3 region            auto   (or the bucket location, e.g. us)
    S3 bucket name       acme-vault
    S3 access key ID     <GOOG... accessId>
    S3 secret access key <secret>
    Optional prefix      (empty, or acme/ to share the bucket across repos)

  vsync profile list
  vsync profile show acme-gcp            # secret stays masked

## 5. Reuse the profile (create once, bind many)

  vsync init dev  --profile=acme-gcp
  vsync init prod --profile=acme-gcp
  cd ../other-project && vsync init prod --profile=acme-gcp

## 6. Bind an env and push

  cd my-project
  vsync init prod --profile=acme-gcp
  # put secrets in infra/vault/prod/.env.prod
  vsync push prod                        # → gs://acme-vault/<repo>/prod/versions/<ts>.enc
  vsync versions prod
  vsync audit prod

## 7. Daily loop

  vsync pull prod
  # … edit infra/vault/prod/ …
  vsync push prod
  vsync use prod       # ./.env → infra/vault/prod/.env.prod

## 8. Fan out to GitHub Actions (sync gh)

  vsync sync prod gh --gh-repo=acme/web                 # --gh-repo saved on first run
  vsync sync prod gh --gh-repo=acme/web \\
    --exclude-property=LOCAL_ONLY --inline-file-suffix=_FILE
  # needs the gh CLI authenticated. Other targets: gcp | aws | azure | vault.

## 9. Onboard a new dev

  # you:
  vsync export prod                         # → ./<repo>-prod.share + a one-time passphrase
  # send file + passphrase on TWO channels
  # new dev:
  vsync import prod ./<repo>-prod.share
  vsync pull prod
  vsync use prod

## Troubleshooting

  403/AccessDenied on push      SA lacks roles/storage.objectAdmin on the bucket
  SignatureDoesNotMatch         HMAC secret truncated on copy (it's base64) — re-mint
  InvalidAccessKeyId            you pasted the SA email instead of the GOOG... accessId
`;

export const HANDBOOK_CUSTOM = `# vsync — bucket on your own S3 (VPS / S3-compatible)

Any S3-compatible endpoint works. Below: self-host MinIO on a VPS end-to-end,
then a drop-in table for managed S3-compatibles (R2, B2, Wasabi, Hetzner,
Spaces) — same six profile fields, only the endpoint changes. vsync decides
TLS from the URL scheme: https:// = TLS, http:// = plaintext.

## Option A — self-host MinIO on a VPS

### 1. Run MinIO (Docker)

  docker run -d --name minio -p 9000:9000 -p 9001:9001 \\
    -v /srv/minio/data:/data \\
    -e MINIO_ROOT_USER=admin -e MINIO_ROOT_PASSWORD='change-me-long-random' \\
    quay.io/minio/minio server /data --console-address ":9001"
  # :9000 = S3 API (what vsync talks to); :9001 = web console.
  # In production, terminate TLS in front so the endpoint is https://s3.example.com.

### 2. Create the bucket + a scoped key (mc client)

  mc alias set acme https://s3.example.com admin 'change-me-long-random'
  mc mb acme/acme-vault
  mc admin user svcacct add acme admin     # prints an Access Key + Secret Key — copy both

### 3. Save it as a vsync profile

  vsync profile add acme-minio
    S3 endpoint URL      https://s3.example.com   (or http://1.2.3.4:9000 for a bare box)
    S3 region            us-east-1   (MinIO default; 'auto' also works)
    S3 bucket name       acme-vault
    S3 access key ID     <svcacct Access Key>
    S3 secret access key <svcacct Secret Key>
    Optional prefix      (empty, or acme/ to share the bucket across repos)

## Option B — managed S3-compatibles (only the endpoint changes)

  Cloudflare R2     https://<accountid>.r2.cloudflarestorage.com   region auto
  Backblaze B2      https://s3.<region>.backblazeb2.com            region e.g. us-west-004
  Wasabi            https://s3.<region>.wasabisys.com              region e.g. us-east-1
  Hetzner           https://<region>.your-objectstorage.com        region e.g. fsn1
  DO Spaces         https://<region>.digitaloceanspaces.com        region e.g. nyc3

  # create a bucket + S3 access key in the provider console, then:
  vsync profile add acme-r2     # endpoint/region from the row above, then bucket + keys

## Reuse the profile (create once, bind many)

  vsync init dev  --profile=acme-minio
  vsync init prod --profile=acme-minio
  cd ../other-project && vsync init prod --profile=acme-minio

## Bind an env and push

  cd my-project
  vsync init prod --profile=acme-minio
  # put secrets in infra/vault/prod/.env.prod
  vsync push prod
  vsync versions prod
  vsync audit prod

## Daily loop

  vsync pull prod
  # … edit infra/vault/prod/ …
  vsync push prod
  vsync use prod       # ./.env → infra/vault/prod/.env.prod

## Fan out to GitHub Actions (sync gh)

  vsync sync prod gh --gh-repo=acme/web                 # --gh-repo saved on first run
  vsync sync prod gh --gh-repo=acme/web \\
    --exclude-property=LOCAL_ONLY --inline-file-suffix=_FILE
  # needs the gh CLI authenticated. Other targets: gcp | aws | azure | vault.

## Onboard a new dev

  # you:
  vsync export prod                         # → ./<repo>-prod.share + a one-time passphrase
  # send file + passphrase on TWO channels
  # new dev:
  vsync import prod ./<repo>-prod.share
  vsync pull prod
  vsync use prod

## Troubleshooting

  Connection refused / TLS      wrong scheme — http:// for a plain box, https:// only if TLS terminated
  SignatureDoesNotMatch         wrong secret, or provider needs a specific region string
  NoSuchBucket                  bucket not created — vsync never auto-creates buckets
`;

export const HANDBOOK_AGENT = `# vsync — agent / LLM workflow map

You are an assistant helping a user with vsync. vsync is the ENGINE; you run
its canonical commands — you do not reimplement init/push/pull logic. Detect
the user's intent, pick ONE workflow below, show the command, confirm, run it.
Deeper detail: \`vsync <sub> --help\` and the provider runbooks (\`vsync docs aws|gcp|custom\`).

## Pick a workflow by intent

OWNER FIRST-TIME SETUP  ("share secrets with my team", "encrypt my .env")
  decision: which S3 backend?  →  vsync docs aws | gcp | custom  for bucket setup
  vsync profile add <name>              # one-time, per machine (S3 creds)
  vsync init <env> --profile=<name>     # per (repo, env): AES key + config + .vsync pin
  # user drops secrets into infra/vault/<env>/.env.<env>
  vsync push <env>                      # encrypt + upload + audit

TEAMMATE ONBOARDING  ("I got a .share file", "join the team's vault")
  decision: where did the .share file land locally?
  vsync import <env> <share-file>       # installs config + key (paste passphrase)
  vsync pull <env>                      # decrypt + unpack into infra/vault/<env>/
  vsync use <env>                       # ./.env → infra/vault/<env>/.env.<env>

DAILY PUSH / PULL  ("ship my changes", "get the latest")
  vsync pull <env>                      # before working
  vsync push <env>                      # after editing  (lost-update guarded)

FANOUT TO PROD SECRET STORES  ("push secrets to GitHub Actions / GCP / AWS / Azure / Vault")
  decision: which target?  gh | gcp | aws | azure | vault
  vsync sync <env> gh --gh-repo=<owner/name>            # routing saved after first run
  # optional policy flags (repeatable): --exclude-property=<key> --inline-file-suffix=<suf>

PRODUCTION RUNTIME  ("read the vault from my app at boot")
  decision: which platform? (Vercel / ECS / Cloud Run / Azure / VPS)
  vsync runtime-token --env=<env>       # mint the VSYNC_CONFIG blob → paste into the platform
  # the app reads it via the matching Python / TypeScript / Go / Java library

SOMETHING BROKE
  vsync status                          # local configs, profiles, orphans (offline)
  vsync audit <env>                     # who touched the remote, when
  # a (repo, env) needs BOTH halves: a config file AND a keychain key — find the missing half first

## Five rules (inviolable)

1. Don't auto-install. If 'vsync' isn't on PATH, surface the install command and stop.
2. The .share file and its passphrase travel on DIFFERENT channels. Say this at every export.
3. Never paste a passphrase or .share contents into the chat transcript. Operate on filenames; the user types secrets locally.
4. Two halves: a (repo, env) is a config file + a keychain key. On error, name the missing half before fixing.
5. No per-user revoke. vsync is small-team-shared-key. Offboarding = rotate + re-export.

## How to run

Greet with the workflow you picked → ask the one decision point → show the command, run it on confirm → repeat → end with a pointer to \`vsync <sub> --help\` or the docs site.
Don't lecture on the threat model before the first command. The user wanted to share secrets; the manual is the website.

Reference: full spec at docs/specs/v0.14-agent-skill.md · site https://muthuishere.github.io/vsync/
`;

export const HANDBOOK_TOPICS: HandbookTopic[] = [
  {
    key: "aws",
    aliases: ["awss3", "s3"],
    summary: "Bucket on AWS S3 (aws s3api + IAM key)",
    body: HANDBOOK_AWS,
  },
  {
    key: "gcp",
    aliases: ["gcps3", "gcs", "google"],
    summary: "Bucket on Google Cloud Storage (gcloud + HMAC interop key)",
    body: HANDBOOK_GCP,
  },
  {
    key: "custom",
    aliases: ["customs3", "vps", "minio", "r2", "selfhosted", "self-hosted"],
    summary: "Bucket on your own S3 / VPS (MinIO, R2, B2, Wasabi, Hetzner, Spaces)",
    body: HANDBOOK_CUSTOM,
  },
  {
    key: "agent",
    aliases: ["agents", "skill", "ai", "llm"],
    summary: "Agent / LLM workflow map — which command to run for each intent",
    body: HANDBOOK_AGENT,
  },
];

/** Keys that are provider bucket-setup runbooks (vs. the agent map). */
const PROVIDER_KEYS = new Set(["aws", "gcp", "custom"]);

/** Resolve a topic name (key or alias, case-insensitive). Undefined if unknown. */
export function resolveTopic(name: string): HandbookTopic | undefined {
  const n = name.trim().toLowerCase();
  return HANDBOOK_TOPICS.find((t) => t.key === n || t.aliases.includes(n));
}

/** Render the topic list shown by `vsync docs list` and on an unknown topic. */
export function renderTopicList(): string {
  const providers = HANDBOOK_TOPICS.filter((t) => PROVIDER_KEYS.has(t.key));
  const others = HANDBOOK_TOPICS.filter((t) => !PROVIDER_KEYS.has(t.key));
  const lines: string[] = ["Provider bucket-setup runbooks (vsync docs <topic>):", ""];
  for (const t of providers) {
    lines.push(`  ${t.key.padEnd(8)} ${t.summary}`);
  }
  if (others.length) {
    lines.push("");
    lines.push("For AI agents / assistants:");
    lines.push("");
    for (const t of others) {
      lines.push(`  ${t.key.padEnd(8)} ${t.summary}`);
    }
  }
  lines.push("");
  lines.push("Plain `vsync docs` prints the repo onboarding reference.");
  return lines.join("\n");
}
