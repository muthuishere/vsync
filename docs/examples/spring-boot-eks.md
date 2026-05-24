# Spring Boot + AWS EKS

A Spring Boot app deployed to AWS EKS (Kubernetes) with `vsync-s3-client` reading secrets from S3 at boot. The two env vars come from a Kubernetes `Secret` mounted as env vars, populated via the AWS Secrets Manager Secrets Store CSI Driver.

## Stack

- **App:** Spring Boot 3.3 + Java 21
- **Platform:** AWS EKS (Kubernetes)
- **Secret store:** AWS Secrets Manager → Kubernetes Secret (via Secrets Store CSI Driver)
- **Vault:** AWS S3
- **Lib:** `io.github.muthuishere:vsync-s3-client:0.11.0`

## Working directory tree

```
my-spring-app/
├── src/main/java/com/example/myapp/
│   ├── MyAppApplication.java
│   ├── config/
│   │   ├── VsyncConfig.java
│   │   └── DataSourceConfig.java
│   └── web/
│       └── HealthController.java
├── infra/
│   └── vault/                       (gitignored)
│       └── prod/
│           └── .env.prod
├── infra/k8s/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── secret-provider-class.yaml   (CSI driver config)
│   └── service-account.yaml         (IRSA — IAM Roles for Service Accounts)
├── Dockerfile
├── pom.xml
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

### 3. IRSA — IAM Role for Service Accounts

The EKS service account needs to read the Secrets Manager secrets.

```bash
# Create IAM policy
aws iam create-policy --policy-name myapp-vsync-secrets-read --policy-document '{
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

# Create the IRSA mapping
eksctl create iamserviceaccount \
  --cluster my-eks-cluster \
  --namespace myapp \
  --name myapp-sa \
  --attach-policy-arn arn:aws:iam::123456789012:policy/myapp-vsync-secrets-read \
  --approve
```

### 4. Install the Secrets Store CSI Driver + AWS provider

(One-time per cluster.)

```bash
helm repo add secrets-store-csi-driver \
  https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts
helm install -n kube-system csi-secrets-store \
  secrets-store-csi-driver/secrets-store-csi-driver

kubectl apply -f https://raw.githubusercontent.com/aws/secrets-store-csi-driver-provider-aws/main/deployment/aws-provider-installer.yaml
```

## Code

### `pom.xml` (excerpt)

```xml
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-jdbc</artifactId>
    </dependency>
    <dependency>
        <groupId>org.postgresql</groupId>
        <artifactId>postgresql</artifactId>
    </dependency>
    <dependency>
        <groupId>io.github.muthuishere</groupId>
        <artifactId>vsync-s3-client</artifactId>
        <version>0.11.0</version>
    </dependency>
</dependencies>
```

### `MyAppApplication.java`

```java
package com.example.myapp;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class MyAppApplication {
    public static void main(String[] args) {
        SpringApplication.run(MyAppApplication.class, args);
    }
}
```

### `config/VsyncConfig.java`

```java
package com.example.myapp.config;

import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.VsyncClient;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class VsyncConfig {

    private static final Logger log = LoggerFactory.getLogger(VsyncConfig.class);
    private Vsync handle;

    @Bean
    public Vsync vsync() {
        this.handle = VsyncClient.open();
        log.info("vsync booted: gen={}, db source={}",
            handle.generation(),
            handle.envSource("DATABASE_URL"));
        return this.handle;
    }

    @PreDestroy
    public void shutdown() {
        if (handle != null) {
            handle.close();
        }
    }
}
```

### `config/DataSourceConfig.java`

```java
package com.example.myapp.config;

import io.github.muthuishere.vsync.s3client.client.Vsync;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;

@Configuration
public class DataSourceConfig {

    @Bean
    public DataSource dataSource(Vsync vsync) {
        String url      = vsync.getEnv("DATABASE_URL");
        String user     = vsync.getEnv("DATABASE_USER");
        String password = vsync.getEnv("DATABASE_PASSWORD");

        if (url == null || user == null || password == null) {
            throw new IllegalStateException(
                "DATABASE_URL / DATABASE_USER / DATABASE_PASSWORD must be set in vault");
        }

        return DataSourceBuilder.create()
            .url(url)
            .username(user)
            .password(password)
            .driverClassName("org.postgresql.Driver")
            .build();
    }
}
```

### `web/HealthController.java`

```java
package com.example.myapp.web;

import io.github.muthuishere.vsync.s3client.client.Vsync;
import io.github.muthuishere.vsync.s3client.client.errors.ManifestNotFoundException;
import io.github.muthuishere.vsync.s3client.client.errors.S3UnreachableException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class HealthController {

    private final Vsync vsync;

    public HealthController(Vsync vsync) {
        this.vsync = vsync;
    }

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

## Deployment

### `Dockerfile`

```dockerfile
FROM eclipse-temurin:21-jdk-alpine AS builder

WORKDIR /build
COPY pom.xml .
COPY .mvn/ .mvn/
COPY mvnw .
RUN ./mvnw dependency:go-offline -B

COPY src/ src/
RUN ./mvnw package -DskipTests -B

FROM eclipse-temurin:21-jre-alpine

WORKDIR /app
COPY --from=builder /build/target/*.jar app.jar

EXPOSE 8080
ENTRYPOINT ["java", "-XX:+UseContainerSupport", "-jar", "/app/app.jar"]
```

### `infra/k8s/secret-provider-class.yaml`

```yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: myapp-vsync-secrets
  namespace: myapp
spec:
  provider: aws
  parameters:
    objects: |
      - objectName: "myapp/prod/vsync-config"
        objectType: "secretsmanager"
        objectAlias: "vsync-config"
      - objectName: "myapp/prod/vsync-passphrase"
        objectType: "secretsmanager"
        objectAlias: "vsync-passphrase"
  secretObjects:
    - secretName: myapp-vsync-env
      type: Opaque
      data:
        - objectName: vsync-config
          key: VSYNC_CONFIG
        - objectName: vsync-passphrase
          key: VSYNC_PASSPHRASE
```

This tells the CSI driver to fetch from Secrets Manager and project into a Kubernetes Secret named `myapp-vsync-env`.

### `infra/k8s/deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: myapp
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      serviceAccountName: myapp-sa
      containers:
        - name: app
          image: 123456789012.dkr.ecr.eu-central-1.amazonaws.com/myapp:latest
          ports:
            - containerPort: 8080
          envFrom:
            - secretRef:
                name: myapp-vsync-env
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits:   { cpu: 1000m, memory: 1Gi }
          startupProbe:
            httpGet: { path: /healthz, port: 8080 }
            failureThreshold: 30      # 30 * 2s = 60s budget for vsync.open + Spring boot
            periodSeconds: 2
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 10
            failureThreshold: 3
          volumeMounts:
            - name: vsync-secrets
              mountPath: /mnt/secrets
              readOnly: true
      volumes:
        - name: vsync-secrets
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: myapp-vsync-secrets
```

Notes:

- **`envFrom` + `secretRef`** pulls `VSYNC_CONFIG` and `VSYNC_PASSPHRASE` from the projected K8s Secret into env vars on the container.
- **`volumeMounts`** is required by the CSI driver — it must mount the volume to trigger the secret sync into the K8s Secret. The mount itself is unused; the side effect is the Secret population.
- **`startupProbe` failureThreshold: 30 × period 2s = 60s budget.** Spring Boot cold-starts in 8-15s on JDK 21 native (or 20-40s on JIT); vsync `open()` adds <1s. Adjust based on your timings.
- **`maxUnavailable: 1, maxSurge: 1`** does a careful rolling deploy: at most one pod down, at most one extra pod up at a time.

### Deploy

```bash
kubectl apply -f infra/k8s/secret-provider-class.yaml
kubectl apply -f infra/k8s/deployment.yaml
kubectl apply -f infra/k8s/service.yaml
```

## After rotation — EKS specifics

### Rotate the passphrase

```bash
# 1. On a laptop
vsync rotate-passphrase --env=prod

# 2. Update Secrets Manager
aws secretsmanager update-secret \
  --secret-id myapp/prod/vsync-passphrase \
  --secret-string 'new-passphrase'

# 3. Force pod re-roll — pods re-mount the CSI volume on restart,
#    which re-fetches from Secrets Manager
kubectl rollout restart deployment/myapp -n myapp

# 4. Wait for rollout, verify
kubectl rollout status deployment/myapp -n myapp
kubectl exec -n myapp deploy/myapp -- wget -qO- http://localhost:8080/healthz
# → {"status":"fresh","gen":<new>}
```

**Important:** the CSI driver re-fetches secrets when a pod restarts, not on a schedule. Running pods keep the old projected Secret value until they're recreated. The rolling restart is the propagation mechanism.

### Auto-sync option

The CSI driver supports `syncSecret.enabled=true` and pod restarts on secret rotation — but it relies on detecting AWS Secrets Manager version changes. For the most predictable behaviour, stick with explicit `kubectl rollout restart` after rotation.

## Things to watch out for

- **JVM cold start.** Spring Boot on JIT takes 20-40s to first request. vsync `open()` adds ~200-500ms. The `startupProbe` failureThreshold needs to cover the JVM's startup, not just vsync's. GraalVM Native Image cuts cold-start dramatically if you can use it.
- **`@PreDestroy` order.** Spring shuts down beans in reverse dependency order. The `VsyncConfig.shutdown()` runs **after** any bean that depends on the `Vsync` handle, which means `DataSourceConfig`'s connection pool drains first, then vsync closes. This is correct.
- **JMX / Actuator exposing env vars.** Spring Boot Actuator's `/actuator/env` endpoint shows env vars by default. **Disable in production** or restrict via security — `management.endpoint.env.enabled=false` in `application.properties`.
- **Pod logs catching env on crash.** If your app does `Exception.getMessage()` that includes env contents, or if your logger has a stack-trace formatter that dumps env, secrets land in CloudWatch. Audit your logging config.
- **Sidecar containers** in the pod share the env vars (if `envFrom` is at the pod level, not container level — but it's at container level in the deployment above, so this is fine by default).
- **HPA / autoscaling.** If you scale up, new pods do their own vsync `open()` — one S3 round trip per new pod. At 100+ pods, that's 100 S3 reads. S3 handles this trivially, but if you're worried about cost or rate-limiting, scale slowly.
- **Image pull secrets vs. vsync.** ECR auth is handled by the kubelet's IAM role, separate from vsync. Don't try to put ECR pull creds in the vault.

## Local development

```bash
vsync pull dev
vsync use dev   # ./.env → infra/vault/dev/.env.dev

# Run with Spring's default property loading (reads ./.env if spring-dotenv is configured,
# or use system properties via -Dspring.profiles.active=local + application-local.properties)
./mvnw spring-boot:run
```

For exercising the runtime lib in dev:

```bash
export VSYNC_CONFIG_FILE=$(mktemp)
export VSYNC_PASSPHRASE_FILE=$(mktemp)
chmod 0600 $VSYNC_CONFIG_FILE $VSYNC_PASSPHRASE_FILE
echo "$DEV_BLOB" > $VSYNC_CONFIG_FILE
echo "$DEV_PASSPHRASE" > $VSYNC_PASSPHRASE_FILE

./mvnw spring-boot:run
```

## Where to go next

- **Java lib reference:** [Java](/libraries/java)
- **Mint a token:** [Runtime tokens](/guide/runtime-token)
- **Rotate the passphrase:** [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook)
- **Other AWS recipe:** [Go + ECS](/examples/go-service-ecs)
