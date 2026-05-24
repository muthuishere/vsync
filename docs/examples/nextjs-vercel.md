# Next.js + Vercel

A Next.js 14 app (App Router) deployed to Vercel with `@muthuishere/vsync-s3-client` reading secrets from S3 on server-side rendering and API routes. Two env vars in Vercel's Sensitive Variables.

## Stack

- **App:** Next.js 14 (App Router) + React 18
- **Platform:** Vercel
- **Vault:** S3-compatible bucket
- **Lib:** `@muthuishere/vsync-s3-client` 0.11.0

## Working directory tree

```
my-next-app/
├── app/
│   ├── page.tsx                     (server component — uses vsync directly)
│   ├── api/
│   │   ├── health/route.ts          (health endpoint with has_new_version)
│   │   └── data/route.ts            (your API)
│   └── layout.tsx
├── lib/
│   └── vsync.ts                     (the lazy singleton wrapper)
├── infra/
│   └── vault/                       (gitignored)
│       └── prod/
│           └── .env.prod
├── package.json
├── tsconfig.json
├── next.config.mjs
└── .gitignore
```

## One-time setup

### 1. Init env + push

```bash
cd my-next-app
vsync profile add acme-prod                  # if not already
vsync init prod --profile=acme-prod

cat > infra/vault/prod/.env.prod <<'EOF'
DATABASE_URL=postgres://...
STRIPE_KEY=sk_live_...
NEXT_PUBLIC_BASE_URL=https://app.myapp.com
SENTRY_DSN=https://...@sentry.io/...
EOF

vsync push prod --note="initial prod setup"
```

Note about `NEXT_PUBLIC_*` keys: Next.js inlines these into the **client bundle at build time**. Putting them in vsync means they're available at server boot but **not** in the browser unless you read them server-side and pass through props. See [things to watch out for](#things-to-watch-out-for).

### 2. Mint the runtime token

```bash
vsync runtime-token --env=prod \
  --access-key=AKIA_PROD_READONLY \
  --secret-key=PROD_READONLY_SECRET
# → vsync-cfg-v1:H4sIAAAA...
```

### 3. Paste into Vercel

Settings → Environment Variables:

- `VSYNC_CONFIG` — paste the blob, mark **Sensitive**, scope **Production**.
- `VSYNC_PASSPHRASE` — paste the passphrase, mark **Sensitive**, scope **Production**.

For preview deployments, repeat with the preview-env values (or omit, and let preview fall through to defaults).

## Code

### `package.json` (excerpt)

```json
{
  "dependencies": {
    "next": "^14.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@muthuishere/vsync-s3-client": "^0.11.0"
  }
}
```

### `lib/vsync.ts` — the singleton wrapper

```typescript
import { open, type Vsync } from "@muthuishere/vsync-s3-client";

let _handle: Vsync | null = null;
let _pending: Promise<Vsync> | null = null;

export async function vsync(): Promise<Vsync> {
  if (_handle) return _handle;
  if (_pending) return _pending;

  _pending = open({
    defaults: {
      NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
    },
  }).then((v) => {
    _handle = v;
    return v;
  });

  return _pending;
}
```

Why the `_pending` promise: in a Vercel serverless function, multiple concurrent requests on the same warm instance shouldn't race to call `open()` four times. The first request kicks off the promise; subsequent ones await the same promise; once resolved, `_handle` is cached for all future calls.

### `app/page.tsx` — server component

```tsx
import { vsync } from "@/lib/vsync";

export default async function Page() {
  const v = await vsync();
  // env_source is safe to render — never the value
  return (
    <main>
      <h1>Hello</h1>
      <p>DB source: {v.envSource("DATABASE_URL")}</p>
      <p>Gen: {v.generation()}</p>
    </main>
  );
}
```

Never render `v.getEnv("DATABASE_URL")` directly — that would inline the secret into the HTML you ship to the browser.

### `app/api/health/route.ts`

```typescript
import { vsync } from "@/lib/vsync";
import { S3UnreachableError, ManifestNotFoundError } from "@muthuishere/vsync-s3-client";

export async function GET() {
  const v = await vsync();
  try {
    if (await v.hasNewVersion()) {
      return Response.json({
        status: "stale",
        localGen: v.generation(),
        remoteGen: await v.remoteGeneration(),
      });
    }
    return Response.json({ status: "fresh", gen: v.generation() });
  } catch (err) {
    if (err instanceof S3UnreachableError || err instanceof ManifestNotFoundError) {
      return Response.json({ status: "unknown", gen: v.generation() });
    }
    throw err;
  }
}
```

### `app/api/data/route.ts`

```typescript
import { vsync } from "@/lib/vsync";

export async function GET() {
  const v = await vsync();
  const dbUrl = v.getEnv("DATABASE_URL");
  if (!dbUrl) {
    return Response.json({ error: "DATABASE_URL not configured" }, { status: 500 });
  }
  // ... fetch from your DB ...
  return Response.json({ ok: true });
}
```

## Deployment

```bash
vercel --prod
```

Vercel reads `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` from the dashboard's Sensitive Variables and injects them at function invocation. No deployment manifest changes needed.

For local dev:

```bash
# Pull the dev vault locally
vsync pull dev
vsync use dev
# Then:
npm run dev
# Reads from ./.env (symlinked) via Next.js's built-in dotenv support — no vsync at all
```

## After rotation — Vercel specifics

```bash
# 1. Rotate the passphrase
vsync rotate-passphrase --env=prod

# 2. Update VSYNC_PASSPHRASE in Vercel dashboard

# 3. Trigger a redeploy (env-var change alone doesn't auto-redeploy Sensitive Variables)
vercel --prod
```

Or for IAM rotation:

```bash
vsync runtime-token --env=prod --access-key=AKIA_NEW --secret-key=NEW_SECRET
# Copy the output, paste into Vercel's VSYNC_CONFIG Sensitive Variable, redeploy.
```

Vercel's deploy model favours rolling cutovers — the old deployment stays alive serving traffic until the new one is healthy. Race window is small.

## Things to watch out for

- **`NEXT_PUBLIC_*` keys in the vault.** Next.js inlines `process.env.NEXT_PUBLIC_*` into client bundles **at build time**. If your build doesn't have `NEXT_PUBLIC_*` set in the build environment, the client bundle will have `undefined` baked in.

  **Fix:** for client-exposed config, set the value as a **regular** Vercel env var (not Sensitive) so it's available at build time. Use vsync only for **server-side** secrets. Or: in your server components, read from `v.getEnv("NEXT_PUBLIC_BASE_URL")` and pass through props to client components.

- **Edge runtime doesn't support `@muthuishere/vsync-s3-client`.** The library uses Node APIs (`node:crypto`, `node:fs` for `_FILE` paths). Edge runtime is a stripped-down V8. Stick to Node runtime for routes that use vsync:

  ```typescript
  // In your route file:
  export const runtime = "nodejs";  // not "edge"
  ```

- **Multiple Vercel deployments running in parallel** (e.g. during a rollout) may have different vsync gens for a brief window. Healthcheck reports `stale` until everything converges. Add jitter / retries on the orchestrator side if you alert on `stale` status.

- **Sentry's `process.env` capture** will pick up `VSYNC_CONFIG` and `VSYNC_PASSPHRASE`. Configure the SDK to redact:

  ```typescript
  Sentry.init({
    beforeSend(event) {
      if (event.extra) {
        delete event.extra.VSYNC_CONFIG;
        delete event.extra.VSYNC_PASSPHRASE;
      }
      return event;
    },
  });
  ```

- **Build-time vs. runtime.** `next build` runs on Vercel's build machines, not your runtime container. The vsync env vars aren't available at build time unless you also configure them for the build environment. For most apps this is fine — vault values are read at request time, not build time. But if you do anything in `getStaticProps` or `generateStaticParams` that needs a secret, you'll need a different bootstrap.

- **App Router caching.** Server components are cached aggressively. If a route renders `v.envSource(...)` (or, dangerously, `v.getEnv(...)`) into HTML, that HTML may be cached and served across requests. Use `export const dynamic = "force-dynamic"` on routes that depend on per-request vsync state.

## Local development

The simplest path is `vsync use dev` + Next.js's built-in dotenv. Next.js reads `./.env`, `./.env.local`, etc. automatically:

```bash
vsync pull dev
vsync use dev   # ./.env → infra/vault/dev/.env.dev
npm run dev
```

If you want to use the vsync runtime lib in local dev (e.g. to test the boot path), use the `_FILE` variant:

```bash
# In your shell:
export VSYNC_CONFIG_FILE=/tmp/vsync-dev-config
export VSYNC_PASSPHRASE_FILE=/tmp/vsync-dev-passphrase
echo "$DEV_CONFIG_BLOB" > $VSYNC_CONFIG_FILE
echo "$DEV_PASSPHRASE" > $VSYNC_PASSPHRASE_FILE
chmod 0600 $VSYNC_CONFIG_FILE $VSYNC_PASSPHRASE_FILE

npm run dev
```

Most teams don't bother — Next.js's `./.env` flow is fine for dev. Vsync is for **deployed** envs.

## Where to go next

- **TypeScript lib reference:** [TypeScript](/libraries/typescript)
- **Other TS recipe:** [Express + Fly.io](/examples/express-fly)
- **Mint a token:** [Runtime tokens](/guide/runtime-token)
- **Rotate the passphrase:** [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook)
