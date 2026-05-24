# Go HTTP service + AWS ECS

A Go HTTP service deployed to AWS ECS (Fargate) with `vsync-s3-client-go` reading secrets from S3 at boot. The two env vars come from AWS Secrets Manager via the ECS task definition's `secrets` field.

## Stack

- **App:** Go 1.22 stdlib `net/http`
- **Platform:** AWS ECS on Fargate
- **Secret store:** AWS Secrets Manager (injects `VSYNC_CONFIG` + `VSYNC_PASSPHRASE`)
- **Vault:** AWS S3 (any S3-compatible works, but staying in-AWS keeps latency + egress low)
- **Lib:** `github.com/muthuishere/vsync/libraries/go@v0.11.0`

## Working directory tree

```
my-go-service/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── handlers/
│   │   ├── health.go
│   │   └── api.go
│   └── vsync/
│       └── singleton.go
├── infra/
│   └── vault/                       (gitignored)
│       └── prod/
│           └── .env.prod
├── infra/aws/
│   ├── task-definition.json
│   └── secrets.tf
├── Dockerfile
├── go.mod
├── go.sum
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

### 2. Upload to AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name myapp/prod/vsync-config \
  --secret-string "file:///tmp/vsync-config-blob"

aws secretsmanager create-secret \
  --name myapp/prod/vsync-passphrase \
  --secret-string 'correct-horse-battery-staple'

shred -u /tmp/vsync-config-blob
```

### 3. IAM — task execution role + task role

The **task execution role** (`ecsTaskExecutionRole`) needs `secretsmanager:GetSecretValue` to inject the secrets. The **task role** (the role the app runs as) typically doesn't need vsync-specific permissions — vsync uses the IAM key embedded in `VSYNC_CONFIG`, not the task role's AWS identity.

```bash
# Attach a policy to the task execution role allowing it to read the secrets
aws iam put-role-policy --role-name ecsTaskExecutionRole \
  --policy-name VsyncSecretRead \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:eu-central-1:123456789012:secret:myapp/prod/vsync-config-*",
        "arn:aws:secretsmanager:eu-central-1:123456789012:secret:myapp/prod/vsync-passphrase-*"
      ]
    }]
  }'
```

## Code

### `go.mod`

```go
module github.com/example/my-go-service

go 1.22

require (
    github.com/muthuishere/vsync/libraries/go v0.11.0
)
```

### `internal/vsync/singleton.go`

```go
package vsync

import (
    "context"
    "sync"

    vsync "github.com/muthuishere/vsync/libraries/go"
)

var (
    handle *vsync.Vsync
    once   sync.Once
    bootErr error
)

func Boot(ctx context.Context) (*vsync.Vsync, error) {
    once.Do(func() {
        handle, bootErr = vsync.Open(ctx, vsync.WithDefaults(map[string]string{
            "PORT": "8080",
        }))
    })
    return handle, bootErr
}

func Get() *vsync.Vsync {
    return handle
}

func Close() error {
    if handle != nil {
        return handle.Close()
    }
    return nil
}
```

### `cmd/server/main.go`

```go
package main

import (
    "context"
    "encoding/json"
    "errors"
    "log/slog"
    "net/http"
    "os/signal"
    "syscall"
    "time"

    appvsync "github.com/example/my-go-service/internal/vsync"
    "github.com/example/my-go-service/internal/handlers"
    vsync "github.com/muthuishere/vsync/libraries/go"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    v, err := appvsync.Boot(ctx)
    if err != nil {
        slog.Error("vsync boot failed", "err", err)
        switch {
        case errors.Is(err, vsync.ErrConfigMissing):
            slog.Error("VSYNC_CONFIG / VSYNC_PASSPHRASE not set or invalid")
        case errors.Is(err, vsync.ErrWrongPassphrase):
            slog.Error("passphrase rejected — rotation race?")
        case errors.Is(err, vsync.ErrS3Unreachable):
            slog.Error("S3 unreachable — IAM / network / DNS / TLS")
        }
        return
    }
    defer appvsync.Close()

    slog.Info("vsync ready",
        "gen", v.Generation(),
        "db_source", v.EnvSource("DATABASE_URL").String(),
    )

    mux := http.NewServeMux()
    mux.HandleFunc("/healthz", handlers.Health)
    mux.HandleFunc("/api/", handlers.API)

    port, _ := v.GetEnv("PORT")
    srv := &http.Server{
        Addr:              ":" + port,
        Handler:           mux,
        ReadHeaderTimeout: 5 * time.Second,
    }

    go func() {
        slog.Info("listening", "port", port)
        if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            slog.Error("server error", "err", err)
        }
    }()

    <-ctx.Done()
    slog.Info("shutting down")
    shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    _ = srv.Shutdown(shutCtx)
}

// Helper for handlers below (could also live in its own file)
func writeJSON(w http.ResponseWriter, status int, body any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    _ = json.NewEncoder(w).Encode(body)
}
```

### `internal/handlers/health.go`

```go
package handlers

import (
    "errors"
    "net/http"

    appvsync "github.com/example/my-go-service/internal/vsync"
    vsync "github.com/muthuishere/vsync/libraries/go"
)

func Health(w http.ResponseWriter, r *http.Request) {
    v := appvsync.Get()
    if v == nil {
        writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "booting"})
        return
    }

    stale, err := v.HasNewVersion(r.Context())
    switch {
    case errors.Is(err, vsync.ErrS3Unreachable),
         errors.Is(err, vsync.ErrManifestNotFound):
        writeJSON(w, http.StatusOK, map[string]any{
            "status": "unknown",
            "gen":    v.Generation(),
        })
    case err != nil:
        writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
    case stale:
        remote, _ := v.RemoteGeneration(r.Context())
        writeJSON(w, http.StatusOK, map[string]any{
            "status":     "stale",
            "local_gen":  v.Generation(),
            "remote_gen": remote,
        })
    default:
        writeJSON(w, http.StatusOK, map[string]any{
            "status": "fresh",
            "gen":    v.Generation(),
        })
    }
}
```

### `internal/handlers/api.go`

```go
package handlers

import (
    "net/http"

    appvsync "github.com/example/my-go-service/internal/vsync"
)

func API(w http.ResponseWriter, r *http.Request) {
    v := appvsync.Get()
    dbURL, ok := v.GetEnv("DATABASE_URL")
    if !ok || dbURL == "" {
        writeJSON(w, http.StatusInternalServerError, map[string]string{
            "error": "DATABASE_URL not configured",
        })
        return
    }
    // ... your DB query ...
    writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
```

## Deployment

### `Dockerfile`

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static:nonroot

COPY --from=builder /out/server /server
EXPOSE 8080
USER nonroot:nonroot

ENTRYPOINT ["/server"]
```

Tiny binary, no shell, runs as nonroot. The vsync handle is in-memory only; no filesystem state needs persistence.

### `infra/aws/task-definition.json`

```json
{
  "family": "my-go-service",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::123456789012:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::123456789012:role/myapp-task-role",
  "containerDefinitions": [{
    "name": "server",
    "image": "123456789012.dkr.ecr.eu-central-1.amazonaws.com/my-go-service:latest",
    "essential": true,
    "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
    "secrets": [
      {
        "name": "VSYNC_CONFIG",
        "valueFrom": "arn:aws:secretsmanager:eu-central-1:123456789012:secret:myapp/prod/vsync-config"
      },
      {
        "name": "VSYNC_PASSPHRASE",
        "valueFrom": "arn:aws:secretsmanager:eu-central-1:123456789012:secret:myapp/prod/vsync-passphrase"
      }
    ],
    "healthCheck": {
      "command": ["CMD-SHELL", "wget -q -O- http://localhost:8080/healthz || exit 1"],
      "interval": 30,
      "timeout": 5,
      "retries": 3,
      "startPeriod": 10
    },
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/my-go-service",
        "awslogs-region": "eu-central-1",
        "awslogs-stream-prefix": "ecs"
      }
    }
  }]
}
```

The `secrets` array is how ECS injects Secrets Manager values as env vars. `valueFrom` points at the secret ARN; ECS resolves it at task start and sets the env var.

### Deploy

```bash
aws ecs register-task-definition --cli-input-json file://infra/aws/task-definition.json
aws ecs update-service --cluster prod --service my-go-service \
  --task-definition my-go-service \
  --force-new-deployment
```

`--force-new-deployment` rolls all tasks to the latest revision.

## After rotation — ECS specifics

### Rotate the passphrase

```bash
# 1. On a laptop
vsync rotate-passphrase --env=prod

# 2. Update Secrets Manager
aws secretsmanager update-secret \
  --secret-id myapp/prod/vsync-passphrase \
  --secret-string 'new-passphrase'

# 3. Force ECS to re-pull secrets — task definition stays the same, but new tasks see the new value
aws ecs update-service --cluster prod --service my-go-service --force-new-deployment

# 4. Watch
aws ecs describe-services --cluster prod --services my-go-service
curl https://my-go-service.elb.../healthz  # → {"status":"fresh","gen":<new>}
```

ECS pulls Secrets Manager **at task start**. Running tasks keep the old in-memory bundle until they're cycled. `--force-new-deployment` does a rolling cycle.

### Rotate the IAM key

```bash
vsync runtime-token --env=prod --access-key=AKIA_NEW --secret-key=NEW_SECRET \
  | aws secretsmanager update-secret --secret-id myapp/prod/vsync-config --secret-string file:///dev/stdin

aws ecs update-service --cluster prod --service my-go-service --force-new-deployment
```

Same rolling deploy.

## Things to watch out for

- **Fargate task start latency.** Cold task start is ~30-60s on Fargate (image pull + ENI attach + container boot). The vsync `open()` itself takes ~100-500ms but is dwarfed by ECS's own startup.
- **`secrets` vs `environment`.** The `environment` field is plain env vars committed in the task def — visible to anyone with `ecs:DescribeTaskDefinition`. The `secrets` field resolves at task start and isn't logged. **Always use `secrets` for `VSYNC_*`.**
- **Cross-account secret access.** If your S3 bucket is in account A and ECS runs in account B, the IAM key in `VSYNC_CONFIG` needs cross-account access. Verify at issue time with `vsync runtime-token` — the default validation HEAD will fail with a clear 403 if the policy isn't right.
- **Healthcheck timing.** `startPeriod: 10` gives the task 10s to first respond to `/healthz` before failures count. vsync `open()` typically completes in <1s in-region; bump `startPeriod` if you're cross-region (e.g. S3 in `us-east-1`, ECS in `eu-central-1`).
- **CloudWatch logs catch everything on stdout/stderr.** Make sure your slog/log calls never emit `v.GetEnv("...")` values. The `v.String()` method is `<vsync:redacted>`, but the structured-log fields are your responsibility.
- **Sidecar / X-Ray.** If you run an X-Ray daemon or similar as a sidecar, ensure it doesn't dump the container env on tracing.

## Local development

```bash
vsync pull dev
vsync use dev   # ./.env → infra/vault/dev/.env.dev

# Read directly from ./.env using godotenv, viper, or stdlib + os.Getenv
go run ./cmd/server
```

For exercising the runtime lib locally:

```bash
export VSYNC_CONFIG_FILE=/tmp/vsync-config
export VSYNC_PASSPHRASE_FILE=/tmp/vsync-passphrase
echo "$DEV_BLOB" > $VSYNC_CONFIG_FILE
echo "$DEV_PASSPHRASE" > $VSYNC_PASSPHRASE_FILE
chmod 0600 $VSYNC_CONFIG_FILE $VSYNC_PASSPHRASE_FILE

go run ./cmd/server
```

## Where to go next

- **Go lib reference:** [Go](/libraries/go)
- **Mint a token:** [Runtime tokens](/guide/runtime-token)
- **Rotate the passphrase:** [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook)
- **Other recipes:** [Spring Boot + EKS](/examples/spring-boot-eks) (also AWS-based)
