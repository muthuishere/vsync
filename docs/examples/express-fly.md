# Express + Fly.io

An Express app deployed to Fly.io with `@muthuishere/vsync-s3-client` reading secrets from S3 at boot. Two env vars come from `fly secrets`.

## Stack

- **App:** Express 4 + Node 20
- **Platform:** Fly.io (Machines)
- **Secrets:** Fly secrets (injects env vars)
- **Vault:** S3-compatible bucket
- **Lib:** `@muthuishere/vsync-s3-client` 0.11.0

## Working directory tree

```
my-express-app/
├── src/
│   ├── index.ts                     (boot + Express setup)
│   ├── routes/
│   │   ├── health.ts
│   │   └── api.ts
│   └── vsync.ts                     (singleton wrapper)
├── infra/
│   └── vault/                       (gitignored)
│       └── prod/
│           └── .env.prod
├── Dockerfile
├── fly.toml
├── package.json
├── tsconfig.json
└── .gitignore
```

## One-time setup

### 1. Push vault, mint token

```bash
vsync runtime-token --env=prod \
  --access-key=AKIA_PROD_READONLY \
  --secret-key=PROD_READONLY_SECRET \
  > /tmp/vsync-config-blob
```

### 2. Push to Fly secrets

```bash
fly secrets set \
  VSYNC_CONFIG="$(cat /tmp/vsync-config-blob)" \
  VSYNC_PASSPHRASE="correct-horse-battery-staple"

shred -u /tmp/vsync-config-blob
```

`fly secrets set` automatically restarts running machines to pick up the new values. For the initial setup, this isn't running yet — the secrets are stored and ready for the first deploy.

## Code

### `package.json`

```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "express": "^4.19.0",
    "@muthuishere/vsync-s3-client": "^0.11.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0"
  }
}
```

### `src/vsync.ts`

```typescript
import { open, type Vsync } from "@muthuishere/vsync-s3-client";

let _handle: Vsync | null = null;

export async function bootVsync(): Promise<Vsync> {
  if (!_handle) {
    _handle = await open({
      defaults: { PORT: "8080" },
    });
  }
  return _handle;
}

export function getVsync(): Vsync {
  if (!_handle) throw new Error("vsync not booted");
  return _handle;
}

export async function shutdownVsync(): Promise<void> {
  if (_handle) {
    await _handle.close();
    _handle = null;
  }
}
```

### `src/index.ts`

```typescript
import express from "express";
import { bootVsync, getVsync, shutdownVsync } from "./vsync.js";
import { healthRouter } from "./routes/health.js";
import { apiRouter } from "./routes/api.js";

async function main() {
  const v = await bootVsync();
  console.log(`vsync gen=${v.generation()}, db source=${v.envSource("DATABASE_URL")}`);

  const app = express();
  app.use(express.json());
  app.use("/healthz", healthRouter);
  app.use("/api", apiRouter);

  const port = Number(v.getEnv("PORT") ?? "8080");
  const server = app.listen(port, () => {
    console.log(`Listening on ${port}`);
  });

  // Graceful shutdown for Fly's deploy-rolling
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    server.close();
    await shutdownVsync();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Boot failed:", err);
  process.exit(1);
});
```

### `src/routes/health.ts`

```typescript
import { Router } from "express";
import { getVsync } from "../vsync.js";
import { S3UnreachableError, ManifestNotFoundError } from "@muthuishere/vsync-s3-client";

export const healthRouter = Router();

healthRouter.get("/", async (req, res) => {
  const v = getVsync();
  try {
    const stale = await v.hasNewVersion();
    if (stale) {
      return res.json({
        status: "stale",
        localGen: v.generation(),
        remoteGen: await v.remoteGeneration(),
      });
    }
    res.json({ status: "fresh", gen: v.generation() });
  } catch (err) {
    if (err instanceof S3UnreachableError || err instanceof ManifestNotFoundError) {
      return res.json({ status: "unknown", gen: v.generation() });
    }
    throw err;
  }
});
```

### `src/routes/api.ts`

```typescript
import { Router } from "express";
import { getVsync } from "../vsync.js";

export const apiRouter = Router();

apiRouter.get("/items", async (req, res) => {
  const v = getVsync();
  const dbUrl = v.getEnv("DATABASE_URL");
  if (!dbUrl) {
    return res.status(500).json({ error: "DATABASE_URL not configured" });
  }
  // ... your handler ...
  res.json({ ok: true });
});
```

## Deployment

### `Dockerfile`

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/index.js"]
```

### `fly.toml`

```toml
app = "my-express-app"
primary_region = "fra"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 1

  [http_service.checks.healthz]
    type = "http"
    path = "/healthz"
    interval = "10s"
    timeout = "5s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

Notes:

- **No vsync env vars in `fly.toml`** — they live in `fly secrets`, not committed config. Fly merges them into the runtime env automatically.
- **`min_machines_running = 1`** keeps one instance warm. Cold-start S3 round trips would otherwise add latency to the first request after idle.
- **`auto_start_machines = true`** brings up extra machines on demand.

### Deploy

```bash
fly deploy
```

Or with a specific image tag:

```bash
fly deploy --image-label v0.12.3
```

## After rotation — Fly specifics

### Rotate passphrase

```bash
# 1. On a laptop
vsync rotate-passphrase --env=prod

# 2. Update Fly secret — automatically rolls running machines
fly secrets set VSYNC_PASSPHRASE="new-passphrase"

# 3. Verify
fly logs                              # watch the boot messages
curl https://my-express-app.fly.dev/healthz
# → {"status":"fresh","gen":<new>}
```

`fly secrets set` triggers a rolling deploy automatically — Fly stops one machine, brings up a replacement with the new secret, waits for healthcheck, then moves to the next. The race window is contained per-machine, and the healthcheck failure on the old machine never lets traffic land there.

### Rotate IAM key

```bash
vsync runtime-token --env=prod --access-key=AKIA_NEW --secret-key=NEW_SECRET \
  > /tmp/blob
fly secrets set VSYNC_CONFIG="$(cat /tmp/blob)"
shred -u /tmp/blob
```

Same rolling-deploy behaviour.

## Things to watch out for

- **Fly autoscaling cold starts.** With `auto_stop_machines = true`, idle machines stop. The next request triggers a cold start: container boot (~1-2s on small VMs) + vsync `open()` (~200-500ms) + Express bind (~50ms). For latency-critical APIs, keep `min_machines_running >= 1`.
- **Fly's healthcheck timing matters.** The `interval = "10s"` and `timeout = "5s"` defaults are fine for `vsync` boot. If your healthcheck endpoint is slower than 5s (because of the S3 HEAD in `has_new_version()` over a slow link), Fly will mark you unhealthy and not promote you. Profile your healthcheck under realistic conditions.
- **Multi-region.** If you deploy to multiple regions (`primary_region = "fra"`, with `[[regions]]` blocks for others), each region's machines pull the bundle from the same S3 bucket. Place the bucket near your primary region; secondary regions pay one S3 round trip per cold start.
- **Volumes** — if you mount a persistent volume for some reason, the vsync vault contents are **not** there. The bundle is in memory only; nothing on disk persists across machine recreates. Restart = fresh `open()` = new S3 round trip.
- **Egress cost.** Fly egress is generous, but every S3 round trip is also paid at the S3 side. With autoscaling and `min_machines_running = 1`, you do one round trip per machine restart — typically a few per day per region, negligible. With aggressive autoscale-from-zero, that ramp-up can spike — consider a cheaper-egress S3 (R2, Backblaze) if cold-start frequency is high.

## Local development

```bash
# Pull dev vault
vsync pull dev
vsync use dev

# Run with the vault visible at ./.env
npm run dev
```

If you want to exercise the full vsync runtime in dev, mount the `_FILE` variant:

```bash
export VSYNC_CONFIG_FILE=$(mktemp)
export VSYNC_PASSPHRASE_FILE=$(mktemp)
chmod 0600 $VSYNC_CONFIG_FILE $VSYNC_PASSPHRASE_FILE
echo "$DEV_BLOB" > $VSYNC_CONFIG_FILE
echo "$DEV_PASSPHRASE" > $VSYNC_PASSPHRASE_FILE

npm run dev
```

## Where to go next

- **TypeScript lib reference:** [TypeScript](/libraries/typescript)
- **Other TS recipe:** [Next.js + Vercel](/examples/nextjs-vercel)
- **Mint a token:** [Runtime tokens](/guide/runtime-token)
- **Rotate the passphrase:** [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook)
