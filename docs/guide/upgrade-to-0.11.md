# Upgrade to 0.11

The 0.10 → 0.11 unified release rolls several big pieces into one version bump:

- **Profiles** replaced the single `~/.config/vsync/defaults` file. `vsync init` now requires `--profile=<name>`.
- **`vsync status`** command for a one-line summary of "what's configured on this machine, and is any of it broken".
- **`vsync runtime-token`** + **`vsync rotate-passphrase`** CLI verbs for the new runtime-libs story.
- **Four runtime libraries** (Python, TypeScript, Go, Java) shipped at `0.11.0` with byte-identical wire format.
- **Library API renames:** `get`/`has`/`source`/`asset_bytes` → `getEnv`/`hasEnv`/`envSource`/`getAsContent`. `asset_path` is **removed**.
- **`open_with()`** first-class factory in every library — accepts strings directly, complement to `open()` which reads env vars.
- **Unified version 0.11.0** across CLI + all 4 libs.

The S3 wire format (bundles, manifest, audit log, `.share` files) is **unchanged**. Pull/push between 0.9.x and 0.11 are byte-compatible — you don't need to re-push existing envs.

What's not back-compat: the CLI's `init` flag set (S3 flags removed), the library API surface (method renames), and the `~/.config/vsync/defaults` file (auto-renamed to `.bak`).

## At a glance — what to do

| If you... | Then... |
|---|---|
| ...just use the CLI to push/pull (no runtime libs) | Update one shell command and an env file. ~5 min per machine. |
| ...have apps using the old runtime libs | Update method calls in your app code. ~30 min per app. |
| ...have automation that calls `vsync init` non-interactively in CI | Create a profile first, then pass `--profile=<name>` to `vsync init`. ~10 min. |
| ...want to use the new `open_with()` flow | Optional — `open()` still works. Adopt as needed. |

## Step-by-step migration

### 1. Update the CLI

```bash
bun install -g @muthuishere/vsync@0.11
# or:  npm install -g @muthuishere/vsync@0.11
vsync --version
# → 0.11.0
```

### 2. First run — defaults file is renamed

The first invocation of any vsync subcommand after upgrade does a one-shot migration:

```text
$ vsync --help
Note: the single-default mechanism was removed in v0.11. Your previous
defaults are at ~/.config/vsync/defaults.bak. Run `vsync profile add <name>`
to recreate them as a named profile, then `vsync init <env> --profile=<name>`.

vsync — encrypted vault sync for small teams
... (rest of help text)
```

The notice prints once per machine. The migration is just a `mv defaults defaults.bak` — your existing per-(repo, env) configs at `~/.config/vsync/<repo>/env_<env>` are **untouched**. Push/pull keep working.

### 3. Create a profile from the `.bak`

```bash
cat ~/.config/vsync/defaults.bak
# Read the existing values — bucket, endpoint, region, access-key, secret-key

vsync profile add acme-prod
# Interactive prompts — paste the values from the .bak
```

Pick a profile name that describes the backend, not the env:

- ✓ `acme-prod`, `hetzner-personal`, `r2-client-a` (one per backend)
- ✗ `dev-defaults`, `staging-defaults` (these are env names, not backend names)

Profiles get reused across multiple envs (`dev`, `staging`, `prod` can all use the same `acme-prod` profile if they hit the same bucket).

Once the profile is created, delete the `.bak`:

```bash
shred -u ~/.config/vsync/defaults.bak
```

### 4. `vsync init` now requires `--profile=<name>`

The S3 flags from 0.9.x (`--bucket`, `--endpoint`, `--region`, `--access-key`, `--secret-key`, `--use-ssl`) are **removed**. All creds come from the profile.

Old:

```bash
vsync init dev \
  --bucket=acme-secrets \
  --endpoint=https://s3.eu-central-1.amazonaws.com \
  --region=eu-central-1 \
  --access-key=AKIA... \
  --secret-key=...
```

New:

```bash
vsync init dev --profile=acme-prod
```

Re-init existing envs **isn't required** for the upgrade — your `~/.config/vsync/<repo>/env_<env>` files still work. The profile system only kicks in when you `init` a **new** env, or `--interactive` an existing one.

### 5. Try `vsync status`

New command — answers "what's wired up on this machine and is any of it broken":

```bash
$ vsync status
Repo: my-app (resolved from package.json)

env       profile             prefix              gen   last push       status
prod      acme-prod           my-app/prod/        3     2026-04-28      ok
dev       acme-prod           my-app/dev/         1     2026-05-12      ok

Profiles on this machine (1):
  acme-prod              s3.eu-central-1.amazonaws.com
```

Add `--check-remote` to compare local `gen` against the actual S3 manifest (one HEAD per env):

```bash
$ vsync status --check-remote
Repo: my-app
env       profile             prefix              gen   last push       status
prod      acme-prod           my-app/prod/        3     2026-04-28      ok
dev       acme-prod           my-app/dev/         1     2026-05-12      ✘ LOCAL IS BEHIND (local gen=1, remote gen=2)
```

CI-friendly: `vsync status --quiet --check-remote` exits 0 if everything's clean, non-zero otherwise. Wire it into a daily check if you want.

### 6. (If you have apps using runtime libs) — upgrade library versions

Update your dependency manifest:

```bash
# Python
pip install --upgrade vsync-s3-client==0.11.*

# TypeScript / Node
npm install @muthuishere/vsync-s3-client@^0.11.0

# Go
go get github.com/muthuishere/vsync/libraries/go@v0.11.0

# Java — pom.xml or build.gradle
# <version>0.11.0</version>
```

### 7. (If you have apps using runtime libs) — rename API calls

The methods are renamed for clarity. Find-and-replace in your codebase:

| Old | New | Languages |
|---|---|---|
| `.get(key)` | `.get_env(key)` / `.getEnv(key)` / `.GetEnv(key)` | All four |
| `.has(key)` | `.has_env(key)` / `.hasEnv(key)` / `.HasEnv(key)` | All four |
| `.source(key)` | `.env_source(key)` / `.envSource(key)` / `.EnvSource(key)` | All four |
| `.asset_bytes(name)` / `.assetBytes(name)` / `.AssetBytes(name)` | `.get_as_content(name)` / `.getAsContent(name)` / `.GetAsContent(name)` | All four |
| `.asset_path(name)` / `.assetPath(name)` / `.AssetPath(name)` | **Removed** — materialize a tempfile yourself | All four |

The rest of the surface (`open()`, `generation()`, `remote_generation()`, `has_new_version()`, `close()`) is **unchanged**.

#### Python diff

```python
# Before
import vsync_s3_client
with vsync_s3_client.open() as v:
    db = v.get("DATABASE_URL")
    has = v.has("STRIPE_KEY")
    src = v.source("DATABASE_URL")
    bytes_ = v.asset_bytes("gcp-sa.json")
    path = v.asset_path("gcp-sa.json")

# After
import vsync_s3_client
with vsync_s3_client.open() as v:
    db = v.get_env("DATABASE_URL")
    has = v.has_env("STRIPE_KEY")
    src = v.env_source("DATABASE_URL")
    bytes_ = v.get_as_content("gcp-sa.json")
    # asset_path replaced — write tempfile yourself:
    import tempfile, os
    tf = tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="wb")
    tf.write(bytes_); tf.close()
    os.chmod(tf.name, 0o600)
    path = tf.name
```

#### TypeScript diff

```typescript
// Before
import { open } from "@muthuishere/vsync-s3-client";
const v = await open();
const db = v.get("DATABASE_URL");
const has = v.has("STRIPE_KEY");
const src = v.source("DATABASE_URL");
const bytes = v.assetBytes("gcp-sa.json");
const path = await v.assetPath("gcp-sa.json");

// After
import { open } from "@muthuishere/vsync-s3-client";
const v = await open();
const db = v.getEnv("DATABASE_URL");
const has = v.hasEnv("STRIPE_KEY");
const src = v.envSource("DATABASE_URL");
const bytes = v.getAsContent("gcp-sa.json");
// assetPath replaced — write tempfile yourself:
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "vsync-"));
const path = join(dir, "gcp-sa.json");
writeFileSync(path, bytes, { mode: 0o600 });
```

#### Go diff

```go
// Before
v, _ := vsync.Open(ctx)
db, ok := v.Get("DATABASE_URL")
has := v.Has("STRIPE_KEY")
src := v.Source("DATABASE_URL")
bytes, _ := v.AssetBytes("gcp-sa.json")
path, _ := v.AssetPath("gcp-sa.json")

// After
v, _ := vsync.Open(ctx)
db, ok := v.GetEnv("DATABASE_URL")
has := v.HasEnv("STRIPE_KEY")
src := v.EnvSource("DATABASE_URL")
bytes, _ := v.GetAsContent("gcp-sa.json")
// AssetPath replaced — write tempfile yourself:
dir, _ := os.MkdirTemp("", "vsync-")
path := filepath.Join(dir, "gcp-sa.json")
_ = os.WriteFile(path, bytes, 0o600)
```

#### Java diff

```java
// Before
try (Vsync v = VsyncClient.open()) {
    String db    = v.get("DATABASE_URL");
    boolean has  = v.has("STRIPE_KEY");
    var src      = v.source("DATABASE_URL");
    byte[] bytes = v.assetBytes("gcp-sa.json");
    String path  = v.assetPath("gcp-sa.json");
}

// After
try (Vsync v = VsyncClient.open()) {
    String db    = v.getEnv("DATABASE_URL");
    boolean has  = v.hasEnv("STRIPE_KEY");
    var src      = v.envSource("DATABASE_URL");
    byte[] bytes = v.getAsContent("gcp-sa.json");
    // assetPath replaced — write tempfile yourself:
    Path dir = Files.createTempDirectory("vsync-");
    Path path = dir.resolve("gcp-sa.json");
    Files.write(path, bytes);
    Files.setPosixFilePermissions(path,
        PosixFilePermissions.fromString("rw-------"));
}
```

### 8. (Optional) — try the new `open_with()` factory

Every library now has `open_with()` / `openWith()` / `OpenWith()` for accepting bootstrap strings directly. Useful when:

- Your secrets layer is not env vars (KMS, AWS Secrets Manager fetched at boot, custom config provider).
- You want to test without mutating `os.environ`.
- You're decoding multiple envs in one process.

```python
# Python
v = vsync_s3_client.open_with(config=blob_string, passphrase=pw_string)
```

```typescript
// TypeScript
const v = await openWith({ config: blob, passphrase: pw });
```

```go
// Go
v, err := vsync.OpenWith(ctx, blob, passphrase)
```

```java
// Java
try (Vsync v = VsyncClient.openWith(blob, passphrase)) { ... }
```

`open()` still works exactly as before — pick whichever fits.

### 9. (Optional) — adopt `vsync runtime-token` for new runtime deployments

If you're newly deploying an app that uses one of the runtime libs:

```bash
vsync runtime-token --env=prod \
  --access-key=AKIA_PROD_READONLY \
  --secret-key=PROD_READONLY_SECRET
# → vsync-cfg-v1:H4sIAAAA...
```

Paste into your platform's secret store as `VSYNC_CONFIG`. The passphrase from `vsync init` becomes `VSYNC_PASSPHRASE`. See [Runtime tokens](/guide/runtime-token) and the [Examples gallery](/examples/) for per-platform recipes.

### 10. (Optional) — adopt `vsync rotate-passphrase` for routine rotations

If you're doing periodic passphrase rotations (quarterly hygiene, post-incident), use the new verb instead of the old "re-init + re-push" dance:

```bash
vsync rotate-passphrase --env=prod
```

Atomic re-encrypt + manifest swap + audit row. See [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook).

## What stays the same

- **`vsync push`, `pull`, `export`, `import`, `audit`, `use`, `versions`, `sync`, `docs`** — same behaviour as 0.9.x.
- **Wire formats** — `RQE1`, `RQEM0001`, `SLS1` bundles all unchanged. Bundles pushed by 0.9.x are read by 0.11. Bundles pushed by 0.11 are read by 0.9.x (as long as the 0.9.x client can find them).
- **`.share` files** — backward compatible. A 0.9.x-exported `.share` imports fine into 0.11; a 0.11-exported `.share` imports fine into 0.9.x.
- **Disk config format** — same gzipped JSON layout. New optional fields (`initProfile`, `prefix`, `lastPush`) are ignored by 0.9.x readers.
- **Keychain entries** — same service (`tools.vsync`) and account (`<repo>/<env>`) format.

## Mixed-version teams

You can run 0.11 on some teammates' machines and 0.9.x on others during the transition. Caveats:

- Teammates on 0.9.x can't read the new `vsync status` / `vsync runtime-token` / `vsync rotate-passphrase` verbs.
- A teammate on 0.11 who runs `rotate-passphrase` invalidates the bundle for everyone else until they update `VSYNC_PASSPHRASE` (runtime libs) or coordinate via re-`export` (CLI use).
- Profile files (`~/.config/vsync/profiles/`) are local to the 0.11 user's machine; not shared.

## What's broken if you skip the upgrade

You can stay on 0.9.x indefinitely — vsync isn't auto-updating. But you'll miss:

- The runtime libs entirely (you'd have to mint `VSYNC_CONFIG` manually with a one-liner, which is a footgun).
- `vsync status` for visibility.
- First-class passphrase rotation.
- The four runtime libs' conformance corpus (cross-language interop guarantees).

## Where to go next

- **Spec changelog:** [`v0.13-profiles-init-status`](/specs/v0.13-profiles-init-status), [`v0.10-runtime-token-cli`](/specs/v0.10-runtime-token-cli), [`v0.12-vsync-s3-client`](/specs/v0.12-vsync-s3-client)
- **First runtime-token mint:** [Runtime tokens](/guide/runtime-token)
- **First runtime-lib integration:** [Libraries](/libraries/) + [Examples](/examples/)
- **Things that go wrong during upgrade:** [Troubleshooting](/guide/troubleshooting)
