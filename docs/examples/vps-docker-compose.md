# VPS + docker-compose

Bare-metal Linux VPS (Hetzner, DigitalOcean, Linode, Contabo, …) running your app under `docker-compose`. The two vsync inputs live in **host files**, mounted into the container as `VSYNC_CONFIG_FILE` + `VSYNC_PASSPHRASE_FILE`. Works for any language — the example below is generic with code snippets for the four supported langs.

## Stack

- **App:** any language; example shows Python (others differ only in the `Dockerfile` and import code)
- **Platform:** Linux VPS with Docker + docker-compose
- **Vault:** S3-compatible bucket
- **Lib:** any of `vsync-s3-client` (PyPI / npm / Maven Central / pkg.go.dev)

## Working directory tree (on the VPS)

```
/srv/myapp/
├── docker-compose.yml
├── app/                                 (your application code, baked into the image)
└── /etc/vsync/                          (root-owned, 0700)
    ├── config                           (host file, 0600, contains the vsync-cfg-v1: blob)
    └── passphrase                       (host file, 0600, contains the passphrase)
```

On your laptop:

```
my-app/
├── app/                                 (the same source code shipped to the VPS)
├── Dockerfile
├── docker-compose.yml                   (deployed via rsync / git pull / your tool)
└── .gitignore
```

## One-time setup

### 1. On your laptop — mint the runtime token

```bash
vsync runtime-token --env=prod \
  --access-key=AKIA_PROD_READONLY \
  --secret-key=PROD_READONLY_SECRET \
  > /tmp/vsync-config-blob
# → /tmp/vsync-config-blob now contains "vsync-cfg-v1:H4sIAAAA..."
```

### 2. Copy to the VPS

```bash
# Scp the blob and the passphrase separately. They live on the host filesystem,
# not in any image, not in any compose file, not in git.
scp /tmp/vsync-config-blob root@my-vps:/etc/vsync/config

ssh root@my-vps -- bash <<'EOF'
mkdir -p /etc/vsync
chmod 0700 /etc/vsync
chmod 0600 /etc/vsync/config
# Write the passphrase via a heredoc so it doesn't appear in shell history
read -p "Passphrase: " -s PW
echo "$PW" > /etc/vsync/passphrase
chmod 0600 /etc/vsync/passphrase
chown -R root:root /etc/vsync
EOF

shred -u /tmp/vsync-config-blob
```

### 3. (Recommended) — restrict the file owner to the service user

If your app runs as a non-root user inside the container (recommended), bind-mount the files into a known path and chown them on the host:

```bash
# Suppose your container runs as uid 1000 (a common convention):
chown 1000:1000 /etc/vsync/config /etc/vsync/passphrase
# These need to be readable by the service user inside the container.
# The 0600 mode means: owner-only read. The container user must match the host owner.
```

Alternative: use Docker secrets via swarm mode, which handles UID mapping. The plain bind-mount approach works for non-swarm compose.

## Code

The vsync library accepts `_FILE`-suffixed env vars that point at host paths. **`_FILE` wins over the non-`_FILE` form** if both are set (matches PostgreSQL / Docker secrets convention — operator who mounted a file means it). Trailing whitespace is stripped from file values.

### Python — `app/main.py`

```python
import vsync_s3_client

# Reads from VSYNC_CONFIG_FILE / VSYNC_PASSPHRASE_FILE since they're set
# in the container environment (see docker-compose.yml).
with vsync_s3_client.open() as v:
    db_url = v.get_env("DATABASE_URL")
    print(f"db={db_url}")
```

### TypeScript — `app/index.ts`

```typescript
import { open } from "@muthuishere/vsync-s3-client";

const v = await open();
const dbUrl = v.getEnv("DATABASE_URL");
console.log(`db=${dbUrl}`);
await v.close();
```

### Go — `cmd/server/main.go`

```go
package main

import (
    "context"
    "fmt"
    "log"

    vsync "github.com/muthuishere/vsync/libraries/go"
)

func main() {
    v, err := vsync.Open(context.Background())
    if err != nil {
        log.Fatal(err)
    }
    defer v.Close()

    if dbURL, ok := v.GetEnv("DATABASE_URL"); ok {
        fmt.Println("db=" + dbURL)
    }
}
```

### Java — `MyApp.java`

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.VsyncClient;

public class MyApp {
    public static void main(String[] args) {
        try (Vsync v = VsyncClient.open()) {
            System.out.println("db=" + v.getEnv("DATABASE_URL"));
        }
    }
}
```

In all four languages, `open()` (no args) checks the env vars first and follows the `_FILE` precedence rules — no code change is needed between env-direct (Vercel/ECS/Cloud Run) and file-mounted (VPS).

## Deployment manifest

### `Dockerfile` (Python example)

```dockerfile
FROM python:3.12-slim

WORKDIR /app

# Run as non-root user (uid 1000)
RUN useradd -u 1000 -m -s /bin/bash app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=app:app app/ ./app/

USER app

CMD ["python", "-u", "app/main.py"]
```

(For TypeScript, Go, or Java, use the appropriate base image — `node:20-alpine`, a multi-stage `golang:1.22-alpine` → `distroless/static`, or `eclipse-temurin:21-jre-alpine`.)

### `docker-compose.yml`

```yaml
services:
  app:
    image: ghcr.io/example/my-app:0.11.0
    environment:
      VSYNC_CONFIG_FILE: /run/secrets/vsync-config
      VSYNC_PASSPHRASE_FILE: /run/secrets/vsync-passphrase
      PORT: "8080"
    volumes:
      - /etc/vsync/config:/run/secrets/vsync-config:ro
      - /etc/vsync/passphrase:/run/secrets/vsync-passphrase:ro
    ports:
      - "127.0.0.1:8080:8080"   # behind a host nginx / Caddy / Traefik
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "5"
```

Notes:

- **`volumes: ... :ro`** — read-only bind mount. The container can read the secret files but cannot modify them.
- **`/run/secrets/`** is a conventional path matching how Docker Swarm + Kubernetes mount secrets; using it makes the code portable across orchestrators.
- **No `VSYNC_CONFIG` or `VSYNC_PASSPHRASE` in the compose file**, only the `_FILE` variants. Anyone who can read `docker-compose.yml` (e.g. `git log`) learns the path, not the value.
- **`PORT: "8080"`** is a regular env var; the app falls through the vsync fallback chain (`vault > env > defaults > missing`) and reads `PORT` from the env.

### Deploy

```bash
# On your laptop
rsync -a --delete app/ docker-compose.yml root@my-vps:/srv/myapp/

# On the VPS
ssh root@my-vps "cd /srv/myapp && docker-compose pull && docker-compose up -d"
```

Or use `Watchtower` for auto-image-update, or `Coolify` / `Dokku` / `Caprover` if you want a Heroku-like layer over Docker. The vsync bootstrap is the same regardless.

## After rotation — VPS specifics

### Rotate the passphrase

```bash
# 1. On a laptop
vsync rotate-passphrase --env=prod

# 2. Stage the new passphrase on the VPS (atomic via rename)
ssh root@my-vps -- bash <<'EOF'
read -p "New passphrase: " -s PW
echo "$PW" > /etc/vsync/passphrase.new
chmod 0600 /etc/vsync/passphrase.new
mv /etc/vsync/passphrase.new /etc/vsync/passphrase  # atomic on POSIX
EOF

# 3. Restart the app to pick up the new passphrase
ssh root@my-vps "cd /srv/myapp && docker-compose restart app"

# 4. Verify
ssh root@my-vps "curl -s localhost:8080/healthz"
# → {"status":"fresh","gen":<new>}
```

The `mv` is **atomic** on POSIX filesystems — readers see either the old contents in full or the new contents in full, never a torn read. This is why we don't write directly to the destination path. Important for containers that may re-read the file (though by default vsync reads once at boot, so the rename matters mostly for restart timing).

### Rotate the IAM key

```bash
# 1. On laptop
vsync runtime-token --env=prod --access-key=AKIA_NEW --secret-key=NEW_SECRET \
  > /tmp/vsync-config.new

# 2. Copy to VPS and stage
scp /tmp/vsync-config.new root@my-vps:/etc/vsync/config.new
ssh root@my-vps "chmod 0600 /etc/vsync/config.new && mv /etc/vsync/config.new /etc/vsync/config"

# 3. Restart
ssh root@my-vps "cd /srv/myapp && docker-compose restart app"

# 4. Cleanup
shred -u /tmp/vsync-config.new
```

## Things to watch out for

- **File ownership inside the container.** If the container runs as uid 1000 but the host file is owned by `root:root` with mode 0600, the container can't read it. Either run the container as root (not recommended), `chown 1000:1000` on the host, or use uid namespacing.
- **Permission warning at boot.** vsync logs a warning if the `_FILE` path is world/group-readable (mode `0644`+) and **refuses to read** if world-writable (`0666`+). See [v0.12 §13](/specs/v0.12-vsync-s3-client#_13-file-permissions-policy-on-_file). Always use `0600`.
- **`SELinux` / `AppArmor` on the VPS.** Distros with mandatory access control may block `/run/secrets/*` reads if the path isn't in the right context. Test in your distro before assuming it works.
- **Backups copying both files together** kill the separation. If `/etc/vsync/` is in a daily backup tarball, your `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` are in the same archive — defeating the separation-of-leak-channels design. Either exclude `/etc/vsync/` from backups, or accept that backup-tape security is the perimeter.
- **`docker-compose.override.yml`.** If a `docker-compose.override.yml` exists on the VPS and sets `VSYNC_CONFIG` directly (instead of `_FILE`), it'd override the file path. Audit overrides.
- **Multi-host VPS deployments.** If you scale out to N VPSes behind a load balancer, every host needs the files staged and synced consistently during rotation. Consider using `ansible` or a config-management tool to roll out updates atomically.
- **`docker-compose restart` vs `docker-compose up -d`.** `restart` keeps the same containers; `up -d` recreates them. Either works for picking up the new file contents (vsync reads at boot, not on file watch). Use `restart` for routine rotation, `up -d` for image upgrades.
- **No `:cached` / `:delegated` mount flags.** Those are macOS-only Docker Desktop flags; irrelevant on Linux VPSes.

## Local development

Same pattern works locally — write `_FILE`-pointed files anywhere in your dev box:

```bash
# In your shell
export VSYNC_CONFIG_FILE=$HOME/.config/myapp/vsync-config
export VSYNC_PASSPHRASE_FILE=$HOME/.config/myapp/vsync-passphrase
mkdir -p $(dirname $VSYNC_CONFIG_FILE)

# Stage the dev token
vsync runtime-token --env=dev > $VSYNC_CONFIG_FILE
echo "$DEV_PASSPHRASE" > $VSYNC_PASSPHRASE_FILE
chmod 0600 $VSYNC_CONFIG_FILE $VSYNC_PASSPHRASE_FILE

# Run your app
python app/main.py
```

Or, simpler: skip the runtime lib entirely in dev. Use `vsync use dev` + `dotenv.config()` (or the equivalent in your language). The vsync runtime is for **deployed environments**.

## When NOT to use this pattern

- **You have a managed platform with a real secret store** (Vercel, ECS, Cloud Run, EKS with CSI, etc.) → use that platform's pattern, not file-mounted. See the platform-specific examples in this gallery.
- **You're using Docker Swarm.** Swarm has first-class `docker secret create` / `secrets:` block in compose. Use it instead of bind-mounted host files — Swarm's secrets are RAM-only inside the container, gone on restart.
- **Multi-tenant VPS.** If other users on the VPS can sudo or share the docker group, the security envelope is broken. Use a dedicated VPS or move to a managed platform.

## Where to go next

- **Pick a runtime library:** [Libraries](/libraries/)
- **Mint a token:** [Runtime tokens](/guide/runtime-token)
- **Rotate the passphrase:** [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook)
- **Other examples:** [Django + Vercel](/examples/django-vercel) · [Go + ECS](/examples/go-service-ecs)
