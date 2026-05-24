# TypeScript / Node — `@muthuishere/vsync-s3-client`

Same wire format as the Python reference, idiomatic TypeScript surface: async on the boundaries, sync on the accessors, ESM-first, types shipped.

```bash
npm install @muthuishere/vsync-s3-client
# or:  pnpm add @muthuishere/vsync-s3-client
# or:  yarn add @muthuishere/vsync-s3-client
# or:  bun add @muthuishere/vsync-s3-client
```

Requires Node ≥ 20 (or Bun ≥ 1.2, or Deno with Node-compat). ESM only — no CommonJS build. `package.json` has `"type": "module"` and ships `.d.ts` types.

## Hello world

```typescript
import { open } from "@muthuishere/vsync-s3-client";

const v = await open();

const dbUrl = v.getEnv("DATABASE_URL");
console.log(dbUrl);

await v.close();
```

Set `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` in the process environment first — see [Runtime tokens](/guide/runtime-token).

## The two open paths — `open()` vs `openWith()`

### `open(options?)`

Reads `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` from `process.env`. The right default when your platform's secret store injects directly (Vercel Sensitive Variables, AWS ECS task secrets, Fly.io secrets, GCP Cloud Run `--set-secrets`).

```typescript
import { open } from "@muthuishere/vsync-s3-client";

// Minimum
const v = await open();

// With defaults
const v = await open({ defaults: { PORT: "8080" } });
```

`options` is optional. The full shape:

```typescript
interface OpenOptions {
  defaults?: Record<string, string>;
}
```

### `openWith(options)`

Accepts the two bootstrap strings directly — no `process.env` reads. Use this when your secrets layer is something other than env vars (KMS, AWS Secrets Manager fetched at boot, Doppler, a CI variable that you'd rather not export).

```typescript
import { openWith } from "@muthuishere/vsync-s3-client";

const blob = await fetchFromKms("/myapp/vsync-config");
const pw   = await fetchFromKms("/myapp/vsync-passphrase");

const v = await openWith({
  config: blob,
  passphrase: pw,
  defaults: { PORT: "8080" },
});
```

Shape:

```typescript
interface OpenWithOptions {
  config: string;
  passphrase: string;
  defaults?: Record<string, string>;
}
```

Both `open()` and `openWith()` return the same `Vsync` handle. Behavioral parity from then on.

## Full API

```typescript
import { open, type Vsync, type EnvSource } from "@muthuishere/vsync-s3-client";

const v: Vsync = await open();

// Scalar accessors — sync, pure-memory after open()
v.getEnv("DATABASE_URL");                  // → string | null
v.hasEnv("STRIPE_KEY");                    // → boolean
v.envSource("DATABASE_URL");               // → EnvSource = "vault" | "env" | "default" | "missing"

// Binary content — sync, pure-memory
v.getAsContent("gcp-sa.json");             // → Uint8Array

// Generation & explicit poll
v.generation();                            // → number
await v.remoteGeneration();                // → Promise<number>  (one HEAD on the manifest)
await v.hasNewVersion();                   // → Promise<boolean>

// Lifecycle
await v.close();                           // best-effort buffer zeroing
```

| Method | Returns | Async? |
|---|---|---|
| `getEnv(key)` | `string \| null` | sync |
| `hasEnv(key)` | `boolean` | sync |
| `envSource(key)` | `"vault" \| "env" \| "default" \| "missing"` | sync |
| `getAsContent(name)` | `Uint8Array` | sync |
| `generation()` | `number` | sync |
| `remoteGeneration()` | `Promise<number>` | **async** — one HEAD |
| `hasNewVersion()` | `Promise<boolean>` | **async** — one HEAD |
| `close()` | `Promise<void>` | **async** |

The async/sync split mirrors the I/O boundary: anything that touches the network is `async`, anything pure-memory is `sync`. No `await` overhead in the hot path.

## Materialization recipe — `getAsContent` → tempfile

Some SDKs demand a filesystem path (GCP `GOOGLE_APPLICATION_CREDENTIALS`, OpenSSL cert, JVM truststores). The lib deliberately doesn't ship an `assetPath()` — operators control tmpdir choice, perms, and cleanup. Three lines:

```typescript
import { open } from "@muthuishere/vsync-s3-client";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const v = await open();

const dir  = mkdtempSync(join(tmpdir(), "vsync-"));
const path = join(dir, "gcp-sa.json");
writeFileSync(path, v.getAsContent("gcp-sa.json"), { mode: 0o600 });
process.env.GOOGLE_APPLICATION_CREDENTIALS = path;

// ... initialise Google client here so it reads the path eagerly ...
```

Notes:

- `mkdtempSync` returns a dir with mode `0700` automatically; the file ships at `0600` because of the explicit `mode`.
- On Linux, prefer `/dev/shm` over `tmpdir()` so the bytes never hit a persistent disk: `mkdtempSync("/dev/shm/vsync-")`.
- On `SIGKILL` the dir survives — `process.on('exit', () => rmSync(dir, { recursive: true }))` covers the normal-exit path. The lib does not install such a hook for you (out of scope).

## Error taxonomy

All errors extend `VSyncError`. Each carries a stable `code` string for code-based dispatch without instanceof gymnastics across module boundaries.

```typescript
import {
  open,
  VSyncError,
  ConfigMissingError,
  ConfigUnsupportedVersionError,
  S3UnreachableError,
  ManifestNotFoundError,
  WrongPassphraseError,
  BundleCorruptError,
  UnsupportedSpecVersionError,
} from "@muthuishere/vsync-s3-client";

try {
  const v = await open();
} catch (err) {
  if (err instanceof ConfigMissingError) {
    // VSYNC_CONFIG / VSYNC_PASSPHRASE unset, or magic prefix wrong.
    // In dev: source your .env.
    // In prod: deployment misconfiguration — fail the healthcheck.
    throw err;
  }
  if (err instanceof WrongPassphraseError) {
    // Bundle pulled, passphrase rejected.
    // Likely a rotation race; orchestrator will restart us.
    throw err;
  }
  if (err instanceof S3UnreachableError) {
    // Network / DNS / TLS / IAM 403. Don't degrade.
    throw err;
  }
  if (err instanceof ManifestNotFoundError || err instanceof BundleCorruptError) {
    // Operator needs to run `vsync push <env>`.
    throw err;
  }
  if (err instanceof ConfigUnsupportedVersionError || err instanceof UnsupportedSpecVersionError) {
    // Bump @muthuishere/vsync-s3-client and redeploy.
    throw err;
  }
  throw err;
}
```

The `code` string alternative (useful across worker-thread / vite-ssr module boundaries):

```typescript
catch (err) {
  if (err instanceof VSyncError) {
    switch (err.code) {
      case "VSYNC_CONFIG_MISSING":        ...;
      case "VSYNC_WRONG_PASSPHRASE":      ...;
      case "VSYNC_S3_UNREACHABLE":        ...;
      case "VSYNC_MANIFEST_NOT_FOUND":    ...;
      case "VSYNC_BUNDLE_CORRUPT":        ...;
      case "VSYNC_CONFIG_UNSUPPORTED":    ...;
      case "VSYNC_SPEC_UNSUPPORTED":      ...;
    }
  }
}
```

## Common deployment patterns

### Next.js (App Router)

`lib/vsync.ts`:

```typescript
import { open, type Vsync } from "@muthuishere/vsync-s3-client";

let _handle: Vsync | null = null;

export async function vsync(): Promise<Vsync> {
  if (!_handle) {
    _handle = await open({
      defaults: { NEXT_PUBLIC_BASE_URL: "http://localhost:3000" },
    });
  }
  return _handle;
}
```

`app/api/health/route.ts`:

```typescript
import { vsync } from "@/lib/vsync";
import { S3UnreachableError } from "@muthuishere/vsync-s3-client";

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
    if (err instanceof S3UnreachableError) {
      return Response.json({ status: "unknown", gen: v.generation() });
    }
    throw err;
  }
}
```

`app/page.tsx` (server component):

```typescript
import { vsync } from "@/lib/vsync";

export default async function Page() {
  const v = await vsync();
  return <div>DB: {v.envSource("DATABASE_URL")}</div>;
}
```

Note: only `envSource(key)` is safe to render — never `getEnv(key)` (you'd leak the value into HTML).

### Express

```typescript
import express from "express";
import { open, type Vsync } from "@muthuishere/vsync-s3-client";

const app = express();
let vsync: Vsync;

async function boot() {
  vsync = await open({ defaults: { PORT: "8080" } });

  app.get("/healthz", async (req, res) => {
    try {
      const stale = await vsync.hasNewVersion();
      res.json({ status: stale ? "stale" : "fresh", gen: vsync.generation() });
    } catch {
      res.json({ status: "unknown", gen: vsync.generation() });
    }
  });

  app.get("/", (req, res) => {
    res.json({ db: vsync.envSource("DATABASE_URL") });
  });

  const port = Number(vsync.getEnv("PORT"));
  app.listen(port, () => console.log(`Listening on ${port}`));
}

boot().catch((err) => {
  console.error("vsync boot failed:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await vsync?.close();
  process.exit(0);
});
```

### Bun / Hono

```typescript
import { Hono } from "hono";
import { open } from "@muthuishere/vsync-s3-client";

const v = await open();
const app = new Hono();

app.get("/", (c) => c.json({ db: v.envSource("DATABASE_URL") }));
app.get("/healthz", async (c) => {
  try {
    const stale = await v.hasNewVersion();
    return c.json({ status: stale ? "stale" : "fresh", gen: v.generation() });
  } catch {
    return c.json({ status: "unknown", gen: v.generation() });
  }
});

export default { fetch: app.fetch, port: Number(v.getEnv("PORT") ?? "8080") };
```

### Serverless (AWS Lambda / Vercel Edge)

Open at module scope so the warm-container path reuses the handle:

```typescript
import { open } from "@muthuishere/vsync-s3-client";

const vsyncReady = open();  // Promise resolves on first invocation; reused after

export async function handler(event: unknown) {
  const v = await vsyncReady;
  return { statusCode: 200, body: v.envSource("DATABASE_URL") };
}
```

Don't `close()` in the handler — the container reuses the handle across invocations until it's evicted.

## Testing — injecting a synthetic vault

```typescript
// test/setup.ts
import { beforeEach } from "vitest";

const FIXTURE_CONFIG = "vsync-cfg-v1:H4sIAAAA...";  // from `vsync runtime-token --env=test --no-validate`
const FIXTURE_PASSPHRASE = "test-test-test-test";

beforeEach(() => {
  process.env.VSYNC_CONFIG = FIXTURE_CONFIG;
  process.env.VSYNC_PASSPHRASE = FIXTURE_PASSPHRASE;
});
```

For unit tests that don't want a real S3 round trip, prefer `openWith` over monkeypatching env vars:

```typescript
import { openWith } from "@muthuishere/vsync-s3-client";

it("reads DATABASE_URL", async () => {
  const v = await openWith({ config: FIXTURE_CONFIG, passphrase: FIXTURE_PASSPHRASE });
  expect(v.getEnv("DATABASE_URL")).toBe("postgres://test");
  await v.close();
});
```

### Conformance suite

```bash
cd libraries/typescript
npx vitest run test/conformance.test.ts
```

The corpus at `docs/specs/test-vectors/` is shared with the Python / Go / Java libs.

## Redaction & logging hygiene

The handle's default `util.inspect` and `toJSON()` output is opaque:

```typescript
console.log(v);                          // → <vsync:redacted gen=3 env=prod>
JSON.stringify({ v });                   // → {"v":"<vsync:redacted>"}
```

Safe to log: `envSource(k)`, `hasEnv(k)`, `generation()`. **Never log `getEnv(k)` / `getAsContent(name)`** — those are the values you're protecting.

The library does not install a global `console.log` interceptor, doesn't filter Sentry breadcrumbs, doesn't touch your logger. Hygiene is your responsibility.

## Where to go next

- **Mint a runtime-token:** [Runtime tokens](/guide/runtime-token)
- **Real-world deploy recipes:** [Next.js + Vercel](/examples/nextjs-vercel) · [Express + Fly.io](/examples/express-fly)
- **Spec:** [`v0.12-vsync-s3-client`](/specs/v0.12-vsync-s3-client)
- **Compare languages:** [Overview](/libraries/)
