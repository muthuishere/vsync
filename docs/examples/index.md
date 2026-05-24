# Examples gallery

Real-world deployment recipes. Each example is a complete project skeleton — env config, runtime-library import, deployment manifest. Copy-paste, swap names, ship.

## By language

| Language | Example | Platform |
|---|---|---|
| **Python** | [Django + Vercel](/examples/django-vercel) | Vercel Sensitive Variables |
| Python | [FastAPI + Cloud Run](/examples/fastapi-cloud-run) | GCP Cloud Run + Secret Manager |
| **TypeScript** | [Next.js + Vercel](/examples/nextjs-vercel) | Vercel Sensitive Variables |
| TypeScript | [Express + Fly.io](/examples/express-fly) | Fly.io secrets |
| **Go** | [Go HTTP service + AWS ECS](/examples/go-service-ecs) | ECS task definition + Secrets Manager |
| **Java** | [Spring Boot + AWS EKS](/examples/spring-boot-eks) | EKS deployment + Secrets Manager CSI driver |
| **Any** | [VPS + docker-compose](/examples/vps-docker-compose) | bare-metal Linux + `_FILE` bootstrap |

## Common patterns across all examples

### The two env vars

Every runtime example needs the same two inputs:

```
VSYNC_CONFIG=vsync-cfg-v1:H4sIAAAA...        # from `vsync runtime-token --env=<env>`
VSYNC_PASSPHRASE=correct-horse-battery-staple # the passphrase from `vsync init`
```

Cloud platforms inject them directly. VPS / bare-metal mount them as files via the `_FILE` variant.

### The IAM key shape

The IAM key inside `VSYNC_CONFIG` is **read-only**, scoped to the bucket-prefix the env lives at. The minimum AWS IAM policy looks like:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::your-bucket",
      "arn:aws:s3:::your-bucket/<repo>/<env>/*"
    ]
  }]
}
```

Translate to the IAM model of your S3-compatible provider (Hetzner sub-users, R2 API tokens, B2 application keys). Same scoping discipline.

### The boot sequence

```
1. Platform injects VSYNC_CONFIG + VSYNC_PASSPHRASE into the process environment.
2. Application code calls vsync.open() (or openWith for non-env-var bootstrap).
3. Library does one S3 round trip: fetch manifest → fetch bundle → decrypt.
4. Application reads getEnv("KEY") values from the in-memory handle.
5. Application boots. No further S3 traffic until process restart.
```

If you want a live-reload story, do it **one layer up** — a sidecar that polls and signals the orchestrator to restart. The library deliberately does not refresh in place.

## What to look for in each example

Every example covers:

- **Working directory tree** — what files exist in your repo.
- **Env vars / `VSYNC_CONFIG` setup** — how to mint and inject.
- **Code snippet** — where the lib boot lives (Django settings, FastAPI lifespan, Express boot, Spring `@Bean`, Go `main`).
- **Deployment manifest** — Dockerfile, `vercel.json`, ECS task definition, k8s `deployment.yaml`, `docker-compose.yml`.
- **Health endpoint** — wired to `has_new_version()` so the orchestrator can roll on rotation.
- **What to watch out for** — platform-specific gotchas (cold starts, build-time vs. runtime, secret propagation lag).

## Choosing your platform

Quick decision tree:

- **You're already on Vercel** → [Django + Vercel](/examples/django-vercel) or [Next.js + Vercel](/examples/nextjs-vercel).
- **You want serverless containers** → [FastAPI + Cloud Run](/examples/fastapi-cloud-run).
- **You're in the AWS ecosystem** → [Go + ECS](/examples/go-service-ecs), [Spring Boot + EKS](/examples/spring-boot-eks).
- **You're indie / startup with bare-metal Hetzner/DO/Linode** → [VPS + docker-compose](/examples/vps-docker-compose).
- **You're already on Fly.io** → [Express + Fly.io](/examples/express-fly).

The vsync library and bootstrap contract are the same everywhere. The deployment manifest is what differs.

## Where to go next

- **First-time team setup:** [First team setup](/guide/first-team-setup)
- **Mint the bootstrap token:** [Runtime tokens](/guide/runtime-token)
- **Pick a runtime library:** [Libraries](/libraries/)
- **Things that break:** [Troubleshooting](/guide/troubleshooting)
