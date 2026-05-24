# Go — `vsync-s3-client-go`

Same wire format as the Python reference, idiomatic Go surface: explicit `context.Context` on network calls, sentinel errors for `errors.Is`, functional options for configuration, no init-time panics.

```bash
go get github.com/muthuishere/vsync/libraries/go@v0.11.0
```

Requires Go ≥ 1.22.

```go
import vsync "github.com/muthuishere/vsync/libraries/go"
```

## Hello world

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
        log.Fatalf("vsync open: %v", err)
    }
    defer v.Close()

    if dbURL, ok := v.GetEnv("DATABASE_URL"); ok {
        fmt.Println("db:", dbURL)
    }
}
```

Set `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` in the process environment first — see [Runtime tokens](/guide/runtime-token).

## The two open paths — `Open` vs `OpenWith`

### `Open(ctx, opts...)`

Reads `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` from the process environment via `os.Getenv`. The right default when your platform's secret store injects directly (AWS ECS task secrets, GCP Cloud Run `--set-secrets`, Vercel sensitive env, plain `systemd EnvironmentFile=`).

```go
import (
    "context"
    vsync "github.com/muthuishere/vsync/libraries/go"
)

ctx := context.Background()

// Minimum
v, err := vsync.Open(ctx)

// With defaults
v, err := vsync.Open(ctx, vsync.WithDefaults(map[string]string{
    "PORT": "8080",
}))
```

### `OpenWith(ctx, config, passphrase, opts...)`

Accepts the two bootstrap strings directly. Use this when your secrets layer is something other than env vars (KMS, HashiCorp Vault fetched at boot, AWS Secrets Manager, an init container that hands secrets via gRPC).

```go
import (
    "context"
    vsync "github.com/muthuishere/vsync/libraries/go"
)

blob, err := fetchFromKMS(ctx, "/myapp/vsync-config")
if err != nil { return err }

pw, err := fetchFromKMS(ctx, "/myapp/vsync-passphrase")
if err != nil { return err }

v, err := vsync.OpenWith(ctx, blob, pw,
    vsync.WithDefaults(map[string]string{"PORT": "8080"}),
)
```

Both return `(*Vsync, error)`. Behavioral parity from then on.

### Functional options

```go
vsync.WithDefaults(map[string]string)   // last-resort fallback values
```

Extension point — additional options may land in minor versions (e.g. `WithHTTPClient` for proxy support). All options remain backward-compatible by construction.

## Full API

```go
import (
    "context"
    vsync "github.com/muthuishere/vsync/libraries/go"
)

v, _ := vsync.Open(context.Background())
defer v.Close()

// Scalar accessors — pure-memory after Open returns
dbURL, ok := v.GetEnv("DATABASE_URL")     // string, bool
hasIt     := v.HasEnv("STRIPE_KEY")       // bool
source    := v.EnvSource("DATABASE_URL")  // vsync.Source enum

// Binary content
saJSON, err := v.GetAsContent("gcp-sa.json")  // []byte, error
// err is non-nil only if `name` is missing from the bundle

// Generation & explicit poll
gen        := v.Generation()                 // int64
remote, err := v.RemoteGeneration(ctx)        // int64, error  (one HEAD on the manifest)
stale, err := v.HasNewVersion(ctx)            // bool, error

// Lifecycle (idempotent)
_ = v.Close()
```

`vsync.Source` is an exported enum:

```go
type Source int

const (
    SourceVault   Source = iota  // value came from the decrypted vault
    SourceEnv                     // value came from os.Getenv at lookup time
    SourceDefault                 // value came from WithDefaults
    SourceMissing                 // not found anywhere
)

func (s Source) String() string  // "vault" | "env" | "default" | "missing"
```

| Method | Returns | Takes ctx? |
|---|---|---|
| `GetEnv(key)` | `(string, bool)` | no |
| `HasEnv(key)` | `bool` | no |
| `EnvSource(key)` | `Source` | no |
| `GetAsContent(name)` | `([]byte, error)` | no |
| `Generation()` | `int64` | no |
| `RemoteGeneration(ctx)` | `(int64, error)` | **yes** |
| `HasNewVersion(ctx)` | `(bool, error)` | **yes** |
| `Close()` | `error` | no |

`Open` / `OpenWith` / `RemoteGeneration` / `HasNewVersion` take `ctx` because they hit the network. Everything else is pure-memory.

## Materialization recipe — `GetAsContent` → tempfile

Some SDKs demand a filesystem path (GCP `GOOGLE_APPLICATION_CREDENTIALS`, OpenSSL cert, JVM truststores). The lib deliberately doesn't ship an `AssetPath` accessor — operators control tmpdir, perms, and cleanup. Three lines:

```go
import (
    "os"
    "path/filepath"

    vsync "github.com/muthuishere/vsync/libraries/go"
)

bytes, err := v.GetAsContent("gcp-sa.json")
if err != nil { return err }

dir, err := os.MkdirTemp("", "vsync-")
if err != nil { return err }

path := filepath.Join(dir, "gcp-sa.json")
if err := os.WriteFile(path, bytes, 0o600); err != nil { return err }

os.Setenv("GOOGLE_APPLICATION_CREDENTIALS", path)
// ... initialise Google client here ...
```

Notes:

- `os.MkdirTemp` returns a dir with mode `0700`.
- For SIGKILL safety on Linux, pass `"/dev/shm"` as the dir argument.
- Clean up on normal exit:

```go
defer func() { _ = os.RemoveAll(dir) }()
```

## Error taxonomy

Sentinel errors — match with `errors.Is`. Each error wraps a contextual message.

```go
import (
    "errors"
    "fmt"

    vsync "github.com/muthuishere/vsync/libraries/go"
)

v, err := vsync.Open(ctx)
if err != nil {
    switch {
    case errors.Is(err, vsync.ErrConfigMissing):
        // VSYNC_CONFIG / VSYNC_PASSPHRASE unset, or magic prefix wrong.
        // In dev: source your .env.
        // In prod: deployment misconfiguration — fail the healthcheck.
        return fmt.Errorf("vsync misconfigured: %w", err)

    case errors.Is(err, vsync.ErrWrongPassphrase):
        // Bundle pulled, passphrase rejected. Rotation race?
        return fmt.Errorf("vsync passphrase rejected: %w", err)

    case errors.Is(err, vsync.ErrS3Unreachable):
        // Network / DNS / TLS / IAM 403.
        return fmt.Errorf("vsync cannot reach S3: %w", err)

    case errors.Is(err, vsync.ErrManifestNotFound),
         errors.Is(err, vsync.ErrBundleCorrupt):
        // Operator needs to run `vsync push <env>`.
        return fmt.Errorf("vsync bundle missing/torn: %w", err)

    case errors.Is(err, vsync.ErrConfigUnsupportedVersion),
         errors.Is(err, vsync.ErrUnsupportedSpecVersion):
        // Bump the lib version and redeploy.
        return fmt.Errorf("vsync version mismatch: %w", err)

    default:
        return fmt.Errorf("vsync open: %w", err)
    }
}
```

The full set:

```go
var (
    ErrConfigMissing            = errors.New("vsync: config missing")
    ErrConfigUnsupportedVersion = errors.New("vsync: config version unsupported")
    ErrS3Unreachable            = errors.New("vsync: s3 unreachable")
    ErrManifestNotFound         = errors.New("vsync: manifest not found")
    ErrWrongPassphrase          = errors.New("vsync: wrong passphrase")
    ErrBundleCorrupt            = errors.New("vsync: bundle corrupt")
    ErrUnsupportedSpecVersion   = errors.New("vsync: unsupported spec version")
)
```

No panics. Every error path returns; `Open` never `log.Fatal`s on your behalf.

## Common deployment patterns

### net/http

```go
package main

import (
    "context"
    "encoding/json"
    "errors"
    "log"
    "net/http"
    "os/signal"
    "syscall"
    "time"

    vsync "github.com/muthuishere/vsync/libraries/go"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    v, err := vsync.Open(ctx, vsync.WithDefaults(map[string]string{"PORT": "8080"}))
    if err != nil {
        log.Fatalf("vsync open: %v", err)
    }
    defer v.Close()

    mux := http.NewServeMux()

    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        stale, err := v.HasNewVersion(r.Context())
        status := "fresh"
        if err != nil {
            status = "unknown"
        } else if stale {
            status = "stale"
        }
        _ = json.NewEncoder(w).Encode(map[string]any{
            "status": status,
            "gen":    v.Generation(),
        })
    })

    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        _ = json.NewEncoder(w).Encode(map[string]string{
            "db": v.EnvSource("DATABASE_URL").String(),
        })
    })

    port, _ := v.GetEnv("PORT")
    srv := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 5 * time.Second}

    go func() {
        if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            log.Fatalf("serve: %v", err)
        }
    }()

    <-ctx.Done()
    shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    _ = srv.Shutdown(shutCtx)
}
```

### Gin

```go
package main

import (
    "context"
    "log"

    "github.com/gin-gonic/gin"
    vsync "github.com/muthuishere/vsync/libraries/go"
)

func main() {
    v, err := vsync.Open(context.Background())
    if err != nil { log.Fatal(err) }
    defer v.Close()

    r := gin.Default()

    r.GET("/healthz", func(c *gin.Context) {
        stale, err := v.HasNewVersion(c.Request.Context())
        switch {
        case err != nil:
            c.JSON(200, gin.H{"status": "unknown", "gen": v.Generation()})
        case stale:
            c.JSON(200, gin.H{"status": "stale", "gen": v.Generation()})
        default:
            c.JSON(200, gin.H{"status": "fresh", "gen": v.Generation()})
        }
    })

    port, _ := v.GetEnv("PORT")
    if port == "" { port = "8080" }
    _ = r.Run(":" + port)
}
```

### Cobra-style CLIs

```go
import (
    "context"
    "fmt"
    "os"

    "github.com/spf13/cobra"
    vsync "github.com/muthuishere/vsync/libraries/go"
)

var rootCmd = &cobra.Command{
    Use: "myapp",
    PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
        v, err := vsync.Open(cmd.Context())
        if err != nil { return err }
        cmd.SetContext(context.WithValue(cmd.Context(), "vsync", v))
        return nil
    },
    Run: func(cmd *cobra.Command, args []string) {
        v := cmd.Context().Value("vsync").(*vsync.Vsync)
        defer v.Close()
        fmt.Fprintln(os.Stderr, v.EnvSource("DATABASE_URL"))
    },
}
```

## Testing — injecting a synthetic vault

The library reads two strings and one S3 bundle. For tests, mint a fixture once and reuse:

```go
// test_helpers_test.go
package myapp

import (
    "context"
    "os"
    "testing"

    vsync "github.com/muthuishere/vsync/libraries/go"
)

const (
    fixtureConfig     = "vsync-cfg-v1:H4sIAAAA..." // from `vsync runtime-token --env=test --no-validate`
    fixturePassphrase = "test-test-test-test"
)

func newTestVsync(t *testing.T) *vsync.Vsync {
    t.Helper()
    os.Setenv("VSYNC_CONFIG", fixtureConfig)
    os.Setenv("VSYNC_PASSPHRASE", fixturePassphrase)
    t.Cleanup(func() {
        os.Unsetenv("VSYNC_CONFIG")
        os.Unsetenv("VSYNC_PASSPHRASE")
    })
    v, err := vsync.Open(context.Background())
    if err != nil { t.Fatalf("vsync open: %v", err) }
    t.Cleanup(func() { _ = v.Close() })
    return v
}
```

Prefer `OpenWith` for tests — no env-var mutation needed:

```go
func TestDatabaseURL(t *testing.T) {
    v, err := vsync.OpenWith(context.Background(), fixtureConfig, fixturePassphrase)
    if err != nil { t.Fatal(err) }
    defer v.Close()

    db, ok := v.GetEnv("DATABASE_URL")
    if !ok || db != "postgres://test" {
        t.Errorf("got %q, want postgres://test", db)
    }
}
```

### Conformance suite

```bash
cd libraries/go
go test -run TestConformance ./...
```

The corpus at `docs/specs/test-vectors/` is shared with the Python / TypeScript / Java libs.

## Redaction & logging hygiene

The handle's `String()` (from `fmt.Stringer`) returns `<vsync:redacted>`:

```go
log.Printf("v=%s", v)   // → v=<vsync:redacted>
```

Safe to log: `EnvSource(k).String()`, `HasEnv(k)`, `Generation()`. **Never log `GetEnv(k)` or `GetAsContent(name)` results.**

The internal fields holding the plaintext map are unexported, so `fmt.Printf("%+v", *v)` cannot expose them either. The library doesn't install global hooks; structured-logging hygiene is your job.

## Where to go next

- **Mint a runtime-token:** [Runtime tokens](/guide/runtime-token)
- **Real-world deploy recipe:** [Go service + AWS ECS](/examples/go-service-ecs)
- **Spec:** [`v0.12-vsync-s3-client`](/specs/v0.12-vsync-s3-client)
- **pkg.go.dev:** [pkg.go.dev/github.com/muthuishere/vsync/libraries/go](https://pkg.go.dev/github.com/muthuishere/vsync/libraries/go)
- **Compare languages:** [Overview](/libraries/)
