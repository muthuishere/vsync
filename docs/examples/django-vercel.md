# Django + Vercel

A full Django app deployed to Vercel with `vsync-s3-client` reading secrets from S3 at boot. The two env vars (`VSYNC_CONFIG`, `VSYNC_PASSPHRASE`) live in Vercel's Environment Variables UI as **Sensitive Variables**.

## Stack

- **App:** Django 5.x + Gunicorn
- **Platform:** Vercel (Python runtime)
- **Vault:** S3-compatible bucket (this example uses AWS S3 `eu-central-1`; any provider works)
- **Lib:** `vsync-s3-client` 0.11.0

## Working directory tree

```
my-django-app/
├── infra/
│   └── vault/                       (gitignored)
│       └── prod/
│           ├── .env.prod            (real prod secrets — never committed)
│           └── gcp-sa.json          (any binary file you need at runtime)
├── myproject/
│   ├── settings.py                  (reads from vsync at module import)
│   ├── urls.py
│   ├── wsgi.py
│   └── __init__.py
├── app/                             (Django app folders)
├── manage.py
├── requirements.txt
├── vercel.json
├── .env                             (symlink → infra/vault/<env>/.env.<env>, gitignored)
└── .gitignore
```

## One-time setup

### 1. Init the env on a teammate's laptop

```bash
cd my-django-app
vsync profile add acme-prod                  # if you don't have a profile yet
vsync init prod --profile=acme-prod
# infra/vault/prod/ is created. Drop your secrets in:

cat > infra/vault/prod/.env.prod <<'EOF'
DJANGO_SECRET_KEY=...
DATABASE_URL=postgres://...
SENTRY_DSN=https://...@sentry.io/...
DEBUG=False
ALLOWED_HOSTS=myapp.com,www.myapp.com
EOF

vsync push prod --note="initial prod setup"
```

### 2. Mint the runtime token

The IAM key in this blob should be **read-only**, scoped to the bucket-prefix `myproject/prod/*`. See the [IAM key shape](/examples/#the-iam-key-shape).

```bash
vsync runtime-token --env=prod \
  --access-key=AKIA_PROD_READONLY \
  --secret-key=PROD_READONLY_SECRET
# Output: vsync-cfg-v1:H4sIAAAA...
```

### 3. Paste into Vercel

In your Vercel project:

1. **Settings → Environment Variables**.
2. Add `VSYNC_CONFIG` — paste the blob — mark **Sensitive**.
3. Add `VSYNC_PASSPHRASE` — paste the passphrase from `vsync init` — mark **Sensitive**.
4. Scope: **Production** (or whichever Vercel env corresponds to your vsync env).

Sensitive Variables are write-only — you can't read them back from the UI, only update them. Good hygiene for both `VSYNC_CONFIG` (contains the IAM key) and `VSYNC_PASSPHRASE`.

## Code

### `requirements.txt`

```
Django>=5.0,<6
gunicorn>=22.0,<23
dj-database-url>=2.1,<3
psycopg[binary]>=3.1,<4
vsync-s3-client>=0.11.0,<0.12
sentry-sdk>=2.0,<3
```

### `myproject/settings.py`

```python
import os
from pathlib import Path

import dj_database_url
import sentry_sdk
import vsync_s3_client

BASE_DIR = Path(__file__).resolve().parent.parent

# Open vsync once at module import. Don't close — Django re-imports settings
# in odd places, and a closed handle here surfaces as a hard-to-debug error.
_v = vsync_s3_client.open(defaults={
    "DEBUG": "False",
    "ALLOWED_HOSTS": "localhost,127.0.0.1",
})

# Secrets from vault first, env second, defaults last, missing = None
SECRET_KEY = _v.get_env("DJANGO_SECRET_KEY")
if SECRET_KEY is None:
    raise RuntimeError("DJANGO_SECRET_KEY is not set in vault or env")

DEBUG = _v.get_env("DEBUG") == "True"
ALLOWED_HOSTS = _v.get_env("ALLOWED_HOSTS").split(",")

DATABASES = {
    "default": dj_database_url.parse(_v.get_env("DATABASE_URL"))
}

# Materialize the GCP service account JSON to a tempfile (3-line recipe per spec)
gcp_bytes = _v.get_as_content("gcp-sa.json")
if gcp_bytes:
    import tempfile
    tf = tempfile.NamedTemporaryFile(prefix="gcp-sa-", suffix=".json",
                                     delete=False, mode="wb")
    tf.write(gcp_bytes)
    tf.close()
    os.chmod(tf.name, 0o600)
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = tf.name

# Sentry
sentry_sdk.init(
    dsn=_v.get_env("SENTRY_DSN"),
    environment="production",
    send_default_pii=False,
)

# Log where each setting came from (safe — env_source never returns the value)
import logging
log = logging.getLogger(__name__)
log.info("vsync gen=%d, DATABASE_URL source=%s, SECRET_KEY source=%s",
         _v.generation(),
         _v.env_source("DATABASE_URL"),
         _v.env_source("DJANGO_SECRET_KEY"))

# ... rest of standard Django settings ...
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "app",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
]
ROOT_URLCONF = "myproject.urls"
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": []},
}]
WSGI_APPLICATION = "myproject.wsgi.application"
STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
```

### `app/views.py` — `/healthz` endpoint

```python
from django.conf import settings
from django.http import JsonResponse
from vsync_s3_client import S3UnreachableError, ManifestNotFoundError

def healthz(request):
    v = settings._v
    try:
        if v.has_new_version():
            return JsonResponse({
                "status": "stale",
                "local_gen": v.generation(),
                "remote_gen": v.remote_generation(),
            })
        return JsonResponse({"status": "fresh", "gen": v.generation()})
    except (S3UnreachableError, ManifestNotFoundError):
        # Transient — don't trigger a Vercel redeploy via healthcheck failure
        return JsonResponse({"status": "unknown", "gen": v.generation()})
```

### `myproject/urls.py`

```python
from django.urls import path
from app.views import healthz

urlpatterns = [
    path("healthz", healthz),
    # ... your routes ...
]
```

## Deployment manifest — `vercel.json`

```json
{
  "version": 2,
  "builds": [
    { "src": "myproject/wsgi.py", "use": "@vercel/python" }
  ],
  "routes": [
    { "src": "/(.*)", "dest": "myproject/wsgi.py" }
  ],
  "env": {
    "PYTHONUNBUFFERED": "1"
  }
}
```

`VSYNC_CONFIG` and `VSYNC_PASSPHRASE` come from the **dashboard** (Sensitive Variables), not from `vercel.json`. Keeping them out of the manifest means they're not in your repo's git history if anyone ever accidentally commits `vercel.json` with real values.

## After rotation — Vercel-specific

When you run `vsync rotate-passphrase --env=prod`:

1. Update `VSYNC_PASSPHRASE` in **Settings → Environment Variables** (Sensitive Variables flow).
2. Vercel does **not** automatically redeploy on env-var change for Sensitive Variables — trigger a redeploy yourself: `vercel --prod` from your laptop, or click **Redeploy** in the dashboard.
3. The new deployment reads the new passphrase. Old deployments staying alive (Vercel keeps the previous Production deployment serving until the new one is ready) still have the old passphrase in memory — they're fine until the new one is promoted.

Race window is tighter on Vercel than ECS because the platform manages the cutover atomically.

## Things to watch out for

- **Cold starts** add ~150-500ms of vsync `open()` time to the first request. On Vercel's Python runtime this is in addition to the cold-start hit Django itself imposes. If cold-start latency is critical, pre-warm via a scheduled health check or move to a service that supports always-warm instances.
- **Sentry will auto-capture `process.env` on crashes.** Configure Sentry's [`event_processor`](https://docs.sentry.io/platforms/python/configuration/filtering/) to redact `VSYNC_CONFIG` and `VSYNC_PASSPHRASE`. The `repr(v)` of the vsync handle is already opaque, but the env vars themselves are still in `process.env`.
- **`DEBUG=True` in vault accidentally leaks here.** If a teammate pushes `DEBUG=True` for testing and forgets to revert, your prod deployment will run in debug mode. Add an explicit `if ENV == "production" and DEBUG: raise RuntimeError(...)` guard.
- **Local dev** doesn't need the runtime token — set `VSYNC_CONFIG_FILE` / `VSYNC_PASSPHRASE_FILE` pointing at local files, or use `vsync use dev` and `dotenv.config()` the way you would without vsync.
- **`gcp-sa.json` materialization** happens at module import. If the GCP SDK reads the env var lazily (at first request), the tempfile is still there — Python doesn't auto-delete unless you `atexit.register(os.unlink, tf.name)`.

## Local development

Don't try to ship a runtime token for local dev. Use the regular vsync workflow:

```bash
# On the developer's laptop, with `vsync use dev` already run:
python manage.py runserver
```

In `settings.py`, fall back to plain `dotenv` reads when `VSYNC_CONFIG` is unset:

```python
import os
import vsync_s3_client

if os.getenv("VSYNC_CONFIG"):
    _v = vsync_s3_client.open(defaults={"DEBUG": "False"})
    SECRET_KEY = _v.get_env("DJANGO_SECRET_KEY")
    # ...
else:
    # Local dev — read from ./.env (symlinked by `vsync use dev`)
    from dotenv import load_dotenv
    load_dotenv()
    SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]
    # ...
```

This is the recommended split: vsync runtime libs for **deployed environments**, plain dotenv via `vsync use` for **local development**. Same vault, two access paths.

## Where to go next

- **Python lib reference:** [Python](/libraries/python)
- **Mint a token:** [Runtime tokens](/guide/runtime-token)
- **Rotate the passphrase:** [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook)
- **Other Python recipe:** [FastAPI + Cloud Run](/examples/fastapi-cloud-run)
