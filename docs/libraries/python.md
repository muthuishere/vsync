# Python — `vsync-s3-client`

The reference implementation of the runtime library. Reads an encrypted vault bundle from S3 at process boot, exposes scalar and binary accessors with a deterministic fallback chain, and stays out of your way for the rest of the process lifetime.

```bash
pip install vsync-s3-client
```

Requires Python ≥ 3.10. Zero non-stdlib runtime dependencies beyond `boto3` (and optionally `requests`-style HTTP if you ship one — boto3 ships its own).

## Hello world

```python
import vsync_s3_client

with vsync_s3_client.open() as v:
    db_url = v.get_env("DATABASE_URL")
    print(db_url)
```

Set `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` in the process environment first — see [Runtime tokens](/guide/runtime-token) for how to mint them.

## The two open paths — `open()` vs `open_with()`

### `vsync_s3_client.open(defaults=None)`

Reads `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` from `os.environ`. The right default when your platform's secret store injects directly into the process environment (Vercel Sensitive Variables, AWS ECS task secrets, GCP Cloud Run `--set-secrets`, Azure App Service Key Vault references).

```python
import vsync_s3_client

# Context manager — cleanest for short-lived scripts and serverless handlers
with vsync_s3_client.open() as v:
    db_url = v.get_env("DATABASE_URL")
    work(db_url)

# Explicit handle — for long-running apps (Django, FastAPI)
v = vsync_s3_client.open(defaults={"PORT": "8080"})
try:
    work(v)
finally:
    v.close()
```

`defaults` is a `dict[str, str]` of last-resort values applied when the key is absent from both the vault and the process env. Optional.

### `vsync_s3_client.open_with(config, passphrase, defaults=None)`

Accepts the two bootstrap strings directly — no environment-variable reads. Use this when your secrets layer is something other than env vars (KMS, Hashicorp Vault, fetched from AWS Secrets Manager at boot) or when you're testing.

```python
import vsync_s3_client

blob = fetch_from_kms("/myapp/vsync-config")
pw   = fetch_from_kms("/myapp/vsync-passphrase")

with vsync_s3_client.open_with(config=blob, passphrase=pw) as v:
    db_url = v.get_env("DATABASE_URL")
```

Both `open()` and `open_with()` return the same `Vsync` handle. From then on, behavioral parity — same accessors, same fallback chain, same errors.

### Module-level singleton — for scripts

```python
import vsync_s3_client

# First call opens (and caches) a default instance
db_url = vsync_s3_client.get_env("DATABASE_URL")

# Subsequent calls reuse it
api_key = vsync_s3_client.get_env("STRIPE_KEY")
```

Convenience for one-shot scripts. Long-running apps should hold the handle explicitly so they control `close()` timing.

## Full API

```python
import vsync_s3_client

v = vsync_s3_client.open()

# Scalar (string-typed) accessors — pure-memory after open() returns
v.get_env("DATABASE_URL")        # → str | None
v.has_env("STRIPE_KEY")          # → bool
v.env_source("DATABASE_URL")     # → "vault" | "env" | "default" | "missing"

# Binary content — pure-memory after open() returns
v.get_as_content("gcp-sa.json")  # → bytes

# Generation & explicit poll
v.generation()                   # → int — captured at open() time, never mutated by polling
v.remote_generation()            # → int — one HEAD on the manifest; raises on network failure
v.has_new_version()              # → bool — convenience: remote > local

# Lifecycle
v.close()                        # idempotent; zeros plaintext buffers, drops references
```

| Method | Returns | I/O? |
|---|---|---|
| `get_env(key)` | `str \| None` | no |
| `has_env(key)` | `bool` | no |
| `env_source(key)` | `Literal["vault", "env", "default", "missing"]` | no |
| `get_as_content(name)` | `bytes` | no |
| `generation()` | `int` | no |
| `remote_generation()` | `int` | yes — one HEAD |
| `has_new_version()` | `bool` | yes — one HEAD |
| `close()` | `None` | no |

## Materialization recipe — `get_as_content` → tempfile

Some SDKs demand a filesystem path (GCP `GOOGLE_APPLICATION_CREDENTIALS`, OpenSSL cert file, JVM truststores). The library deliberately doesn't ship an `asset_path()` accessor — operators control tmpdir choice, perms, and cleanup locally. Three lines:

```python
import os
import tempfile
import vsync_s3_client

with vsync_s3_client.open() as v:
    sa_bytes = v.get_as_content("gcp-sa.json")

    tf = tempfile.NamedTemporaryFile(prefix="vsync-", suffix=".json", delete=False, mode="wb")
    tf.write(sa_bytes)
    tf.close()
    os.chmod(tf.name, 0o600)
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = tf.name

    # ... initialise Google client here so it reads the path before exit ...
```

Notes:

- `delete=False` keeps the tempfile alive past the `NamedTemporaryFile` context — clean up explicitly at process exit if you care (`atexit.register(os.unlink, tf.name)`).
- For SIGKILL safety on Linux, set the dir to `/dev/shm`: `tempfile.NamedTemporaryFile(dir="/dev/shm", ...)`. On a normal-exit path, an `atexit` handler removes it; on SIGKILL the tmpfs entry survives until reboot.
- Most cloud SDKs read the path **eagerly** during client construction. Initialise the client inside the `with` block.

## Error taxonomy

All exceptions inherit from `VSyncError`. Catch the root for "any vsync boot failure"; catch specifics when the recovery action differs.

```python
import vsync_s3_client
from vsync_s3_client.errors import (
    VSyncError,
    ConfigMissingError,
    ConfigUnsupportedVersionError,
    S3UnreachableError,
    ManifestNotFoundError,
    WrongPassphraseError,
    BundleCorruptError,
    UnsupportedSpecVersionError,
)

try:
    v = vsync_s3_client.open()
except ConfigMissingError:
    # VSYNC_CONFIG / VSYNC_PASSPHRASE unset; or magic prefix wrong.
    # In dev: tell the developer to source their .env.
    # In prod: this is a deployment misconfiguration — fail the healthcheck.
    raise
except WrongPassphraseError:
    # Bundle pulled OK, passphrase rejected.
    # If you just rotated and the secret store hasn't propagated yet,
    # the orchestrator will restart you in 30s and the next boot will succeed.
    raise
except S3UnreachableError:
    # Network / DNS / TLS / IAM 403.
    # Don't degrade silently to "env vars only" — fail the healthcheck.
    raise
except (ManifestNotFoundError, BundleCorruptError):
    # Bucket reachable but bundle missing/torn.
    # Operator needs to run `vsync push <env>` from a teammate's laptop.
    raise
except (ConfigUnsupportedVersionError, UnsupportedSpecVersionError):
    # The lib is older than the bundle it's trying to read.
    # Bump `vsync-s3-client` in your requirements and redeploy.
    raise
```

The fallback chain (§5 of the spec) covers **per-key misses inside an already-open vault.** Bootstrap failure is never silent.

## Common deployment patterns

### Django

`settings.py`:

```python
import vsync_s3_client

_vsync = vsync_s3_client.open(defaults={
    "DEBUG": "False",
    "ALLOWED_HOSTS": "localhost",
})

SECRET_KEY    = _vsync.get_env("DJANGO_SECRET_KEY")
DATABASE_URL  = _vsync.get_env("DATABASE_URL")
DEBUG         = _vsync.get_env("DEBUG") == "True"
ALLOWED_HOSTS = _vsync.get_env("ALLOWED_HOSTS").split(",")

import dj_database_url
DATABASES = {"default": dj_database_url.parse(DATABASE_URL)}
```

Open once at module import; the handle is held for the lifetime of the worker process. Don't `close()` in `settings.py` — Django re-imports settings in odd places and you'll get `closed handle` errors.

### FastAPI

`main.py`:

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
import vsync_s3_client

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.vsync = vsync_s3_client.open(defaults={"PORT": "8080"})
    yield
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
    except (vsync_s3_client.S3UnreachableError, vsync_s3_client.ManifestNotFoundError):
        # Don't trigger a restart on transient network failure
        return {"status": "unknown", "gen": v.generation()}

@app.get("/")
def root():
    return {"db": app.state.vsync.get_env("DATABASE_URL")}
```

`lifespan` handles boot-and-shutdown, exactly the right place for `open()` / `close()`.

### Celery workers

```python
import vsync_s3_client
from celery import Celery, signals

vsync = None

@signals.worker_process_init.connect
def init_vsync(**_):
    global vsync
    vsync = vsync_s3_client.open()

@signals.worker_process_shutdown.connect
def close_vsync(**_):
    if vsync:
        vsync.close()

app = Celery("tasks")
```

`worker_process_init` fires once per forked worker — exactly when each worker needs its own handle. Don't open in module scope; `fork()` after `open()` shares the S3 client and the keychain-derived AES key across workers in ways that surprise you on shutdown.

## Async — there isn't one, and you don't need one

`open()` does a single S3 round trip and blocks for ~100–500ms on a cold cache. Every subsequent `get_env` / `has_env` / `get_as_content` is pure-memory — no I/O, no event loop blocking.

If you really want to keep the event loop spinning during boot, wrap with `asyncio.to_thread`:

```python
import asyncio
import vsync_s3_client

async def boot():
    v = await asyncio.to_thread(vsync_s3_client.open)
    return v
```

This is rarely worth it — boot is one-time per process, and the event loop isn't doing useful work yet anyway.

## Testing — injecting a synthetic vault

The library reads two strings (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`) and one S3 bundle. For tests, mint a fixture once and reuse:

```python
# tests/conftest.py
import pytest
import vsync_s3_client

FIXTURE_CONFIG = "vsync-cfg-v1:H4sIAAAA..."  # from `vsync runtime-token --env=test --no-validate`
FIXTURE_PASSPHRASE = "test-test-test-test"

@pytest.fixture
def vsync_handle(monkeypatch):
    monkeypatch.setenv("VSYNC_CONFIG", FIXTURE_CONFIG)
    monkeypatch.setenv("VSYNC_PASSPHRASE", FIXTURE_PASSPHRASE)
    with vsync_s3_client.open() as v:
        yield v
```

For unit tests that don't want a real S3 round trip, monkeypatch the fetcher:

```python
from vsync_s3_client._internal import _fetch_bundle

def _fake_fetch(cfg):
    return (b"...rqe1-bundle-bytes...", 7)  # bytes, gen

monkeypatch.setattr("vsync_s3_client._internal._fetch_bundle", _fake_fetch)
```

For full integration, use `moto` (mock AWS) — see the conformance suite in `libraries/python/tests/conformance/` for a worked example.

### Conformance suite

```bash
cd libraries/python
pytest tests/conformance/
```

The corpus at `docs/specs/test-vectors/` is shared with the TypeScript / Go / Java libs. If you write a new test vector, all four libs pick it up automatically.

## Generation & live-reload

`generation()` is the integer captured at `open()`. It increments every time someone runs `vsync rotate-passphrase`. Use it to answer "is my in-process vault stale?".

```python
import vsync_s3_client

v = vsync_s3_client.open()
print(f"Booted at gen {v.generation()}")

# Later, in a healthcheck or sidecar cron:
try:
    if v.has_new_version():
        # Tell the orchestrator (or a human) to restart us
        notify_orchestrator(reason="vault rotated", remote=v.remote_generation())
except vsync_s3_client.S3UnreachableError:
    # Transient — don't trigger a restart
    pass
```

The library never restarts itself. `has_new_version()` answers a question; the orchestrator (k8s rollout, systemd, your platform) acts on the answer.

## Redaction & logging hygiene

The handle's `repr`/`str` is intentionally opaque:

```python
>>> repr(v)
'<vsync:redacted gen=3 env=prod>'
```

Safe to log: `env_source(k)`, `has_env(k)`, `generation()`. **Never log `get_env(k)` or `get_as_content(name)` results** — those are the values you went to all this trouble to protect.

The library does not install a global `logging` filter, doesn't monkeypatch `print`, doesn't touch Sentry breadcrumbs. Application-level observability hygiene is your job. The handle just doesn't betray itself.

## Where to go next

- **Mint a runtime-token:** [Runtime tokens](/guide/runtime-token)
- **Real-world deploy recipes:** [Django + Vercel](/examples/django-vercel) · [FastAPI + Cloud Run](/examples/fastapi-cloud-run)
- **Spec:** [`v0.12-vsync-s3-client`](/specs/v0.12-vsync-s3-client)
- **Conformance vectors:** [`v0.11-conformance-test-vectors`](/specs/v0.11-conformance-test-vectors)
- **Compare languages:** [Overview](/libraries/)
