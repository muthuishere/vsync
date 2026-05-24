# Java — `vsync-s3-client`

Same wire format as the Python reference, idiomatic Java surface: `AutoCloseable` for try-with-resources, checked-exception-free (subclasses `RuntimeException`), JDK 17+ records and `var` throughout.

## Install

**Maven:**

```xml
<dependency>
    <groupId>io.github.muthuishere</groupId>
    <artifactId>vsync-s3-client</artifactId>
    <version>0.11.0</version>
</dependency>
```

**Gradle (Kotlin DSL):**

```kotlin
dependencies {
    implementation("io.github.muthuishere:vsync-s3-client:0.11.0")
}
```

**Gradle (Groovy):**

```groovy
dependencies {
    implementation 'io.github.muthuishere:vsync-s3-client:0.11.0'
}
```

Requires JDK 17 or higher. Runs on JDK 21. Uses the AWS SDK v2 (already a transitive dependency).

## Hello world

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.VsyncClient;

public class App {
    public static void main(String[] args) {
        try (Vsync v = VsyncClient.open()) {
            String dbUrl = v.getEnv("DATABASE_URL");
            System.out.println("db: " + dbUrl);
        }
    }
}
```

Set `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` in the process environment first — see [Runtime tokens](/guide/runtime-token).

## The two open paths — `open()` vs `openWith()`

### `VsyncClient.open()`

Reads `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` from `System.getenv()`. The right default when your platform's secret store injects directly into the process environment.

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.VsyncClient;
import io.github.muthuishere.vsync.s3client.client.VsyncOptions;
import java.util.Map;

// Minimum
try (Vsync v = VsyncClient.open()) {
    // ...
}

// With defaults
var options = VsyncOptions.builder()
    .defaults(Map.of("PORT", "8080"))
    .build();
try (Vsync v = VsyncClient.open(options)) {
    // ...
}
```

### `VsyncClient.openWith(config, passphrase)`

Accepts the two bootstrap strings directly. Use when your secrets layer is something other than env vars (HashiCorp Vault fetched at boot, AWS Secrets Manager via SDK, Spring `@Value` from another property source).

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.VsyncClient;
import io.github.muthuishere.vsync.s3client.client.VsyncOptions;
import java.util.Map;

String blob = fetchFromKms("/myapp/vsync-config");
String pw   = fetchFromKms("/myapp/vsync-passphrase");

// Minimum
try (Vsync v = VsyncClient.openWith(blob, pw)) {
    // ...
}

// With defaults
var options = VsyncOptions.builder()
    .defaults(Map.of("PORT", "8080"))
    .build();
try (Vsync v = VsyncClient.openWith(blob, pw, options)) {
    // ...
}
```

Both return the same `Vsync` handle. Behavioral parity from then on.

## Full API

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.Source;

try (Vsync v = VsyncClient.open()) {
    // Scalar accessors — pure-memory after open()
    String  dbUrl  = v.getEnv("DATABASE_URL");        // null if missing
    boolean hasIt  = v.hasEnv("STRIPE_KEY");
    Source  source = v.envSource("DATABASE_URL");     // enum

    // Binary content
    byte[] saJson = v.getAsContent("gcp-sa.json");

    // Generation & explicit poll
    long    gen     = v.generation();                 // captured at open()
    long    remote  = v.remoteGeneration();           // blocking; one HEAD on the manifest
    boolean stale   = v.hasNewVersion();              // convenience
}
```

`Source` is an enum:

```java
public enum Source {
    VAULT, ENV, DEFAULT, MISSING;

    @Override public String toString() { return name().toLowerCase(); }
}
```

| Method | Returns | Blocks? |
|---|---|---|
| `getEnv(String key)` | `String` (or `null`) | no |
| `hasEnv(String key)` | `boolean` | no |
| `envSource(String key)` | `Source` | no |
| `getAsContent(String name)` | `byte[]` | no |
| `generation()` | `long` | no |
| `remoteGeneration()` | `long` | **yes** — one HEAD |
| `hasNewVersion()` | `boolean` | **yes** — one HEAD |
| `close()` | `void` | no |

`Vsync` implements `AutoCloseable` — try-with-resources is the idiomatic path. `close()` is idempotent.

For async, wrap `remoteGeneration()` / `hasNewVersion()` in `CompletableFuture.supplyAsync(...)`. The library doesn't ship a CompletableFuture-returning API to avoid imposing an executor choice.

## Materialization recipe — `getAsContent` → tempfile

Some SDKs demand a filesystem path (GCP `GOOGLE_APPLICATION_CREDENTIALS`, OpenSSL cert, JVM truststores). The lib deliberately doesn't ship an `assetPath()` accessor — operators control tmpdir, perms, and cleanup. Three lines:

```java
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;

byte[] bytes = v.getAsContent("gcp-sa.json");

Path dir  = Files.createTempDirectory("vsync-");
Path path = dir.resolve("gcp-sa.json");
Files.write(path, bytes);
Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));

System.setProperty("GOOGLE_APPLICATION_CREDENTIALS", path.toString());
// ... initialise Google client here ...
```

Notes:

- `Files.createTempDirectory` returns a dir with platform-appropriate perms (`0700` on POSIX).
- For SIGKILL safety on Linux, target `/dev/shm`:

```java
Path dir = Files.createTempDirectory(Path.of("/dev/shm"), "vsync-");
```

- `setPosixFilePermissions` is no-op on Windows — file system ACLs are the perimeter there.
- Clean up at JVM exit:

```java
Runtime.getRuntime().addShutdownHook(new Thread(() -> {
    try { Files.deleteIfExists(path); } catch (Exception ignored) {}
}));
```

## Error taxonomy

All exceptions extend `VSyncException` (which extends `RuntimeException` — no `throws` clauses).

```java
import io.github.muthuishere.vsync.s3client.client.errors.*;

try (Vsync v = VsyncClient.open()) {
    // use v
} catch (ConfigMissingException e) {
    // VSYNC_CONFIG / VSYNC_PASSPHRASE unset, or magic prefix wrong.
    // In dev: source your .env.
    // In prod: deployment misconfiguration — fail the healthcheck.
    throw e;
} catch (WrongPassphraseException e) {
    // Bundle pulled, passphrase rejected. Rotation race?
    throw e;
} catch (S3UnreachableException e) {
    // Network / DNS / TLS / IAM 403. Don't degrade.
    throw e;
} catch (ManifestNotFoundException | BundleCorruptException e) {
    // Operator needs to run `vsync push <env>`.
    throw e;
} catch (ConfigUnsupportedVersionException | UnsupportedSpecVersionException e) {
    // Bump vsync-s3-client and redeploy.
    throw e;
}
```

The full set:

| Class | Meaning |
|---|---|
| `ConfigMissingException` | `VSYNC_CONFIG` / `VSYNC_PASSPHRASE` unset, or magic prefix wrong |
| `ConfigUnsupportedVersionException` | inner JSON `v` newer than the lib understands |
| `S3UnreachableException` | network / DNS / TLS / IAM 403 |
| `ManifestNotFoundException` | bucket reachable, `<prefix>manifest` absent |
| `WrongPassphraseException` | GCM auth tag rejected the passphrase |
| `BundleCorruptException` | magic byte mismatch / truncated read / dangling pointer |
| `UnsupportedSpecVersionException` | unknown `RQE1` / `RQEM0001` envelope version |

## Common deployment patterns

### Spring Boot

`VsyncConfig.java`:

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.VsyncClient;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import jakarta.annotation.PreDestroy;

@Configuration
public class VsyncConfig {

    private Vsync handle;

    @Bean
    public Vsync vsync() {
        this.handle = VsyncClient.open();
        return this.handle;
    }

    @PreDestroy
    public void shutdown() {
        if (handle != null) handle.close();
    }
}
```

`DataSourceConfig.java`:

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import javax.sql.DataSource;

@Configuration
public class DataSourceConfig {

    @Bean
    public DataSource dataSource(Vsync vsync) {
        return DataSourceBuilder.create()
            .url(vsync.getEnv("DATABASE_URL"))
            .username(vsync.getEnv("DATABASE_USER"))
            .password(vsync.getEnv("DATABASE_PASSWORD"))
            .build();
    }
}
```

`HealthController.java`:

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.errors.S3UnreachableException;
import io.github.muthuishere.vsync.s3client.client.errors.ManifestNotFoundException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import java.util.Map;

@RestController
public class HealthController {

    private final Vsync vsync;

    public HealthController(Vsync vsync) { this.vsync = vsync; }

    @GetMapping("/healthz")
    public Map<String, Object> healthz() {
        try {
            if (vsync.hasNewVersion()) {
                return Map.of(
                    "status", "stale",
                    "localGen", vsync.generation(),
                    "remoteGen", vsync.remoteGeneration()
                );
            }
            return Map.of("status", "fresh", "gen", vsync.generation());
        } catch (S3UnreachableException | ManifestNotFoundException e) {
            return Map.of("status", "unknown", "gen", vsync.generation());
        }
    }
}
```

Note: bind `Vsync` as a singleton bean. Spring's container handles `@PreDestroy` to call `close()` on shutdown.

### Quarkus

```java
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.VsyncClient;
import io.quarkus.runtime.StartupEvent;
import io.quarkus.runtime.ShutdownEvent;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;

@Singleton
public class VsyncProducer {

    private Vsync handle;

    void onStart(@Observes StartupEvent ev) {
        this.handle = VsyncClient.open();
    }

    void onStop(@Observes ShutdownEvent ev) {
        if (handle != null) handle.close();
    }

    @ApplicationScoped
    public Vsync vsync() { return handle; }
}
```

### Plain JDBC / no framework

```java
import java.sql.Connection;
import java.sql.DriverManager;

try (Vsync v = VsyncClient.open();
     Connection conn = DriverManager.getConnection(
         v.getEnv("DATABASE_URL"),
         v.getEnv("DATABASE_USER"),
         v.getEnv("DATABASE_PASSWORD"))) {
    // use conn
}
```

The nested try-with-resources keeps the lifecycle obvious — `vsync` closes after the connection, both close on any exit path.

## Testing — injecting a synthetic vault

For unit tests, prefer `openWith` over env-var mutation:

```java
import org.junit.jupiter.api.Test;
import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.VsyncClient;
import static org.junit.jupiter.api.Assertions.*;

class MyAppTest {

    private static final String FIXTURE_CONFIG =
        "vsync-cfg-v1:H4sIAAAA...";  // from `vsync runtime-token --env=test --no-validate`
    private static final String FIXTURE_PASSPHRASE = "test-test-test-test";

    @Test
    void readsDatabaseUrl() {
        try (Vsync v = VsyncClient.openWith(FIXTURE_CONFIG, FIXTURE_PASSPHRASE)) {
            assertEquals("postgres://test", v.getEnv("DATABASE_URL"));
        }
    }
}
```

For Spring Boot integration tests, expose a test profile that uses fixture strings:

```java
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

@TestConfiguration
class VsyncTestConfig {

    @Bean @Primary
    public Vsync vsync() {
        return VsyncClient.openWith(FIXTURE_CONFIG, FIXTURE_PASSPHRASE);
    }
}
```

### Conformance suite

```bash
cd libraries/java
mvn test -Dtest='*ConformanceTest'
```

The corpus at `docs/specs/test-vectors/` is shared with the Python / TypeScript / Go libs.

## Redaction & logging hygiene

`Vsync.toString()` returns an opaque label:

```java
System.out.println(v);   // → <vsync:redacted gen=3 env=prod>
```

Safe to log: `envSource(k).toString()`, `hasEnv(k)`, `generation()`. **Never log `getEnv(k)` or `getAsContent(name)` results.**

The internal fields holding the plaintext map are private and final. Reflection access requires explicit `setAccessible(true)`, which is auditable. The library does not register a global logging filter; logger configuration is your responsibility.

## Where to go next

- **Mint a runtime-token:** [Runtime tokens](/guide/runtime-token)
- **Real-world deploy recipe:** [Spring Boot + AWS EKS](/examples/spring-boot-eks)
- **Spec:** [`v0.12-vsync-s3-client`](/specs/v0.12-vsync-s3-client)
- **Maven Central:** [io.github.muthuishere:vsync-s3-client](https://central.sonatype.com/artifact/io.github.muthuishere/vsync-s3-client)
- **Compare languages:** [Overview](/libraries/)
