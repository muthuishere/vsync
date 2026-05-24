# FastAPI + Google Cloud Run

A FastAPI app deployed to Cloud Run with `vsync-s3-client` reading secrets from S3 at boot. The two env vars come from **GCP Secret Manager** via `--set-secrets`.

## Stack

- **App:** FastAPI + Uvicorn (Python 3.12)
- **Platform:** Google Cloud Run (managed)
- **Secret store:** GCP Secret Manager (injects `VSYNC_CONFIG` + `VSYNC_PASSPHRASE`)
- **Vault:** S3-compatible bucket (any provider — this example uses AWS S3, but Cloud Run reaching out to S3 is fine)
- **Lib:** `vsync-s3-client` 0.11.0

## Working directory tree

```
my-fastapi-app/
├── infra/
│   └── vault/                                (gitignored)
│       └── prod/
│           ├── .env.prod
│           └── tls/server.crt
├── app/
│   ├── main.py
│   ├── deps.py
│   └── __init__.py
├── Dockerfile
├── requirements.txt
└── .gitignore
```

## One-time setup

### 1. Create the GCP Secret Manager entries

```bash
# On your laptop, after `vsync init prod` and `vsync push prod`:
vsync runtime-token --env=prod \
  --access-key=AKIA_PROD_READONLY \
  --secret-key=PROD_READONLY_SECRET \
  > /tmp/vsync-config-blob

# Upload to GCP Secret Manager
gcloud secrets create vsync-prod-config --replication-policy=automatic
gcloud secrets versions add vsync-prod-config --data-file=/tmp/vsync-config-blob

gcloud secrets create vsync-prod-passphrase --replication-policy=automatic
echo -n 'correct-horse-battery-staple' \
  | gcloud secrets versions add vsync-prod-passphrase --data-file=-

# Cleanup
shred -u /tmp/vsync-config-blob
```

### 2. Grant the Cloud Run service account access

```bash
PROJECT=my-gcp-project
SA="myapp-prod@${PROJECT}.iam.gserviceaccount.com"

for SECRET in vsync-prod-config vsync-prod-passphrase; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:$SA" \
    --role="roles/secretmanager.secretAccessor"
done
```

## Code

### `requirements.txt`

```
fastapi>=0.110,<1
uvicorn[standard]>=0.27,<1
vsync-s3-client>=0.11.0,<0.12
```

### `app/main.py`

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI
import vsync_s3_client
from vsync_s3_client import S3UnreachableError, ManifestNotFoundError


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Open at startup — one S3 round trip, then in-memory forever
    app.state.vsync = vsync_s3_client.open(defaults={"PORT": "8080"})
    yield
    # Close at shutdown — best-effort buffer zeroing
    app.state.vsync.close()


app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
def healthz():
    v = app.state.vsync
    try:
        if v.has_new_version():
            return {
                "status": "stale",
                "local_gen": v.generation(),
                "remote_gen": v.remote_generation(),
            }
        return {"status": "fresh", "gen": v.generation()}
    except (S3UnreachableError, ManifestNotFoundError):
        # Don't trigger a Cloud Run revision rollback on transient network failure
        return {"status": "unknown", "gen": v.generation()}


@app.get("/")
def root():
    v = app.state.vsync
    # env_source is safe to surface — never the value itself
    return {"db": v.env_source("DATABASE_URL"), "gen": v.generation()}
```

### `app/deps.py` — using vault values across routes

```python
from fastapi import Request, Depends
import vsync_s3_client


def get_db_url(request: Request) -> str:
    v: vsync_s3_client.Vsync = request.app.state.vsync
    url = v.get_env("DATABASE_URL")
    if url is None:
        raise RuntimeError("DATABASE_URL not set in vault")
    return url


# In a route:
# @app.get("/items")
# def list_items(db_url: str = Depends(get_db_url)):
#     conn = psycopg.connect(db_url)
#     ...
```

## Deployment

### `Dockerfile`

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Cloud Run sends SIGTERM, expects graceful shutdown in 10s
CMD exec uvicorn app.main:app \
    --host 0.0.0.0 \
    --port $PORT \
    --workers 1 \
    --timeout-graceful-shutdown 5
```

Note: Cloud Run injects `PORT` itself. The `vsync_s3_client.open(defaults={"PORT": "8080"})` is a local-dev safety net; production reads from the injected env var via the fallback chain (env beats defaults).

### Deploy with `gcloud run deploy`

```bash
gcloud run deploy myapp \
  --source=. \
  --region=europe-west1 \
  --platform=managed \
  --service-account=myapp-prod@my-gcp-project.iam.gserviceaccount.com \
  --set-secrets="VSYNC_CONFIG=vsync-prod-config:latest,VSYNC_PASSPHRASE=vsync-prod-passphrase:latest" \
  --memory=512Mi \
  --min-instances=1 \
  --max-instances=10 \
  --concurrency=80
```

`--set-secrets` is the key flag — it tells Cloud Run to inject the named Secret Manager secrets as env vars at container start.

`--min-instances=1` keeps at least one instance warm, which avoids cold-start S3 round trips on the first request after idle. Cost vs. latency tradeoff — drop to 0 if you can tolerate the cold start.

## After rotation — Cloud Run specifics

### Rotate the passphrase

```bash
# 1. Run the rotation on a laptop
vsync rotate-passphrase --env=prod
# (interactive prompts; or --new-passphrase=...)

# 2. Push the new passphrase to Secret Manager
echo -n 'new-correct-horse-battery-staple' \
  | gcloud secrets versions add vsync-prod-passphrase --data-file=-

# 3. Force a new Cloud Run revision (picks up the new :latest)
gcloud run services update myapp --region=europe-west1
# No actual change; the update triggers a new revision that re-injects the secret.

# 4. Verify
curl https://myapp-xxx.run.app/healthz
# → {"status": "fresh", "gen": <new gen>}
```

Cloud Run pulls Secret Manager values **at revision-creation time**, not on every request. The `:latest` reference is resolved once per deploy. To pick up a new value, you must trigger a new revision.

### Rotate the IAM key

Same flow, but for `vsync-prod-config`:

```bash
vsync runtime-token --env=prod \
  --access-key=AKIA_NEW \
  --secret-key=NEW_SECRET \
  | gcloud secrets versions add vsync-prod-config --data-file=-

gcloud run services update myapp --region=europe-west1
```

## Things to watch out for

- **Cold starts** add ~200-500ms of vsync `open()` time on top of Cloud Run's own cold start (~1-3s for Python). For latency-sensitive APIs, set `--min-instances=1`.
- **Secret Manager `:latest`** is resolved at revision-creation time. Adding a new version doesn't automatically restart instances. Always force a new revision after rotation.
- **`--concurrency=80`** means one container handles 80 simultaneous requests. The vsync handle is shared (it's on `app.state`); concurrent reads of `get_env` are thread-safe (pure memory, no mutation).
- **Cloud Run's startup probe** has a 4-minute timeout by default. vsync `open()` takes ~500ms — well within the budget. But if your bucket is far from `europe-west1` and TLS handshake adds latency, consider bringing the bucket regionally close (e.g. Hetzner Helsinki for europe-west1).
- **Egress to S3** from Cloud Run incurs egress cost on the cloud-provider side. If you're using AWS S3 from GCP Cloud Run, you're paying AWS egress for the bundle fetch on every cold start. Use a regionally-close bucket (R2 has zero egress; Hetzner is cheap) if cold-start frequency is high.
- **Logging hygiene** — Cloud Run captures stdout + stderr. Configure your `logging` setup to never log `v.get_env(k)` results. The handle's repr is already redacted.

## Worker concurrency

`uvicorn --workers 1` is the default in the Dockerfile above. For higher per-container concurrency, increase workers:

```dockerfile
CMD exec gunicorn app.main:app \
    -k uvicorn.workers.UvicornWorker \
    --workers 4 \
    --bind 0.0.0.0:$PORT
```

**Important:** call `vsync_s3_client.open()` **inside** the worker process (FastAPI's `lifespan` does this correctly), not at module load time before `fork()`. Each worker gets its own handle; they don't share state.

## Local development

Run with Docker Compose using a `_FILE`-style bootstrap:

```yaml
# docker-compose.dev.yml
services:
  app:
    build: .
    ports: ["8080:8080"]
    environment:
      VSYNC_CONFIG_FILE: /etc/vsync/config
      VSYNC_PASSPHRASE_FILE: /etc/vsync/passphrase
      PORT: "8080"
    volumes:
      - ./infra/vsync-dev/config:/etc/vsync/config:ro
      - ./infra/vsync-dev/passphrase:/etc/vsync/passphrase:ro
```

Where `infra/vsync-dev/` is **gitignored** and contains your dev runtime-token + passphrase. Or, simpler: don't use vsync in dev — use plain `vsync use dev` + `dotenv` ([Django example shows the split](/examples/django-vercel#local-development)).

## Where to go next

- **Python lib reference:** [Python](/libraries/python)
- **Other Python recipe:** [Django + Vercel](/examples/django-vercel)
- **Mint a token:** [Runtime tokens](/guide/runtime-token)
- **Rotate the passphrase:** [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook)
