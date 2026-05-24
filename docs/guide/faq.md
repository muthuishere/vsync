# FAQ

Common questions about vsync, sorted by where they come up.

## Concepts

### What's the relationship between the CLI and the runtime libraries?

**The CLI writes; the libraries read.** The CLI (`@muthuishere/vsync`) is Bun-native, runs on operator laptops and CI runners, manages the on-disk config, the OS keychain, and the S3 bundle. The libraries (`vsync-s3-client` in Python / TypeScript / Go / Java) run inside your application process, do one S3 round trip at `open()`, and expose accessors. They never write to S3.

You install one CLI per machine; you import one library per application.

### Why two separate halves on disk (`config` and `keychain`)?

Separation of leak channels. A teammate's laptop attacker who reads `~/.config/vsync/<repo>/env_<env>` gets bucket creds but no AES key (can't decrypt bundles). One who extracts the keychain entry gets the AES key but no bucket location (can't reach the bundle). Both halves are required to compromise the (repo, env).

This is **not** MFA — it's defence in depth. An attacker with full filesystem + keychain access (root, or your unlocked laptop) has both. See [security model](/architecture/security).

### Why two separate inputs (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`) at runtime?

Same idea: separation of leak channels. A leaked `VSYNC_CONFIG` (terraform/helm chart leak) gives bucket location + IAM read key but not the passphrase. A leaked passphrase (Slack thread, log line) without the bucket location is useless. The design protects against asymmetric leakage, not against full process compromise. See [trust ceiling](/libraries/#trust-ceiling-read-the-spec-not-the-marketing).

### Is the vault tamper-evident?

**No** for the audit log itself (anyone with bucket-write can rewrite `audit.csv`). **Yes** for bundle contents (AES-GCM auth tags reject byte tampering) and **yes** for manifest pointer-swap attacks (manifest pointer-seal `RQEM0001` catches "swap latest to point at older bundle" attacks).

For tamper-evident audit, we'd need signed/chained rows + per-user signing keys. That's parked for a hypothetical 0.5+ — see [v0.4 §12](/specs/v0.4-audit-log).

### Can I encrypt the disk config file too?

No, by design. The disk file is owner-read-only (`chmod 0600`); that's the security envelope. If your home directory is compromised, an extra passphrase on the config file is the least of your problems — at that point the attacker likely also captured your keystrokes typing the passphrase.

If you really need encryption at rest on the disk side, use FileVault / LUKS / BitLocker (full-disk encryption). vsync targets defence in depth, not perfect-forward security in a fully compromised host.

## Library behaviour

### Why doesn't the lib refresh automatically?

**Pull-once semantics.** One S3 round trip at `open()`, then in-memory forever. To pick up new secrets, restart the process. Reasoning:

- Composes with every orchestrator (k8s rollout, systemd restart, Vercel redeploy, Cloud Run new revision) without the lib needing to know about any of them.
- A background refresh that swaps bundle contents mid-process introduces race conditions — what if some code is mid-read?
- A refresh-on-every-call design slows hot paths and creates an implicit dependency on S3 health for every secret lookup.

If you want live-reload, build it one layer up: a sidecar polls `has_new_version()`, signals the orchestrator, orchestrator restarts the process. See [pull-once semantics](/libraries/#pull-once-semantics-no-refresh-no-daemon).

### Can I have multiple envs in one process?

Yes — open multiple handles. Each `open()` / `open_with()` returns an independent client scoped to the `env` baked into its `VSYNC_CONFIG`.

```python
v_prod    = vsync_s3_client.open_with(config=prod_blob,    passphrase=prod_pw)
v_staging = vsync_s3_client.open_with(config=staging_blob, passphrase=staging_pw)

db_prod    = v_prod.get_env("DATABASE_URL")
db_staging = v_staging.get_env("DATABASE_URL")
```

Use `open_with` rather than `open` here — the env-var based `open()` wouldn't know which env to use.

### Why is there no CLI on each language?

The CLI is the **writer**. There's one writer (Bun-native, well-tested, ships with the keychain integration). Putting a CLI in every language would mean four implementations of the same writer logic — four codebases to keep in lockstep, four sets of bugs, four crypto audits. Not worth it.

Each language gets a **reader** (`vsync-s3-client`) because that's what runs in the app process. Different language runtimes need different bindings; libraries are unavoidable. CLIs aren't.

### What's the difference between `vsync sync` and `vsync runtime-token`?

| | `vsync sync <env> <target>` | `vsync runtime-token --env=<env>` |
|---|---|---|
| What it does | Fans out `.env.<env>` KVs to an external secret store (GitHub Actions, GCP Secret Manager, AWS Secrets Manager, Azure Key Vault, HashiCorp Vault) | Mints a single `VSYNC_CONFIG` blob the runtime libs read |
| Where the secrets end up | One KV per secret in the destination platform; your app reads from that platform's SDK | Your app reads from the vsync runtime lib, which decrypts the bundle from S3 directly |
| Operator workflow | "Push my Vercel deployment's secrets to GitHub Actions for CI"; "Push my prod creds to GCP Secret Manager so the GCP-side terraform can read them" | "Bootstrap my runtime to read directly from S3 — fewer moving parts than going through a downstream secret store" |
| When to use | When the destination platform has consumers (CI, terraform, sidecars) that need direct access via the platform's API | When the application itself is the only consumer and you want to skip the intermediate platform |

Both are valid. Some teams use both — `sync` to GitHub Actions for CI access, runtime libs in the production app for boot-time fetch.

### Do I need GitHub Actions?

No. The runtime libs read directly from S3; they don't need GitHub Actions, GCP Secret Manager, or any other platform. `vsync sync` is **optional** — it's there for teams that need to fan out to a downstream platform (e.g., CI that uses GitHub Actions secrets).

If your only consumers are your application process, skip `vsync sync` entirely. CLI: push, mint runtime-token, paste into platform secret store. Lib: open at boot, read values.

### Does this work on Heroku / Render / Coolify / Railway?

Yes — anywhere you can set environment variables (or mount host files) for your application, you can use vsync. Each platform has its own env-var UI, but the contract is the same: `VSYNC_CONFIG` + `VSYNC_PASSPHRASE` into the process environment.

For platforms with a "Sensitive" env-var marker (Vercel, Render, Fly.io, Railway), mark both as Sensitive. For platforms without (Heroku via dashboard, Coolify), they're regular env vars — your platform's access controls become the perimeter.

### Will the lib work with my company's HTTP proxy?

The Python lib uses `boto3`, which respects `HTTPS_PROXY` / `NO_PROXY` env vars. The TS lib uses Node's built-in fetch, which respects `HTTPS_PROXY` if you set `NODE_OPTIONS=--use-system-ca` or use `undici`'s proxy agent. The Go lib uses `net/http`, which respects `HTTPS_PROXY` natively. The Java lib uses the AWS SDK v2, which respects JVM `-Dhttps.proxyHost`.

In all cases, set the proxy at the **runtime** level (env var, JVM property), not in vsync config — vsync doesn't know about proxies.

## Operations

### Why does `vsync push` overwrite history?

It doesn't. Each push writes a **new** object at `<prefix>v=<ts>` and updates the `manifest` pointer to point at it. Old `v=<ts>` objects remain in the bucket forever (unless you configure a lifecycle policy or manually delete). `vsync versions <env>` lists them; `vsync pull <env>@<ts>` would let you fetch a specific version (this verb is on the roadmap but not implemented in 0.x).

### How do I prune old bundles?

vsync doesn't auto-prune. Configure a bucket lifecycle policy:

```bash
# AWS — delete bundles older than 90 days
aws s3api put-bucket-lifecycle-configuration --bucket your-bucket \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-old-vsync-bundles",
      "Filter": { "Prefix": "<prefix>v=" },
      "Status": "Enabled",
      "Expiration": { "Days": 90 }
    }]
  }'
```

Bundle lifecycle is bucket-admin territory; vsync stays out of it.

### Can I git-track the encrypted bundle?

You could `aws s3 cp s3://<bucket>/<prefix>v=<ts> .` and commit the bytes, but **don't**. The bundle on S3 is the source of truth. Committing snapshots means:

- Stale data ages with your git history (you'll forget which commit corresponds to which bundle).
- Two sources of truth (git + S3) drift.
- Bigger git repo for no benefit.

If you want offline backups, use the bucket's versioning + lifecycle, or pull periodically to an off-site backup.

### What about multiple bucket regions for redundancy?

Out of scope. vsync points at one endpoint per env. If you want regional failover, set up S3 cross-region replication at the bucket level, and have a fallback `VSYNC_CONFIG` blob with the replica endpoint ready for manual cutover. The library doesn't do automatic regional failover.

### How big can a vault be?

In practice: tens of MB before S3 round-trip latency becomes noticeable. The library decompresses the whole bundle into memory on `open()`, so:

- Tens of KB → instant boot.
- Single MB → ~100-500ms decryption + parse.
- 10 MB → ~1-2s.
- 100 MB → consider whether you're using vsync for the wrong thing. Large binary blobs (model weights, full database dumps) belong in their own object store, not the vault.

The vault is for **secrets** — strings and small binary credentials. Not a general file-sync tool.

## Profiles & init

### Can I have a "default" profile to skip the `--profile=` flag?

No, by design. v0.13 explicitly removed the default-profile concept. Rationale: picking a profile every time means creds always have a name in the audit chain (whoever ran `vsync init` typed the profile name). A "default" makes it easy for the wrong profile to silently get used for the wrong env.

If you find yourself typing the same `--profile=…` constantly, alias the command: `alias vinit='vsync init --profile=acme-prod'`. The alias lives in your shell; the choice is still explicit on every invocation.

### Can I rename a profile?

No `vsync profile rename` verb. Same reasoning as the "default profile" cut — every profile name is deliberate. To rename: `vsync profile remove <old>` + `vsync profile add <new>`. Configs that referenced the old name will show as `dangling-profile` in `vsync status` until you re-init them with the new profile.

### What happens to my old `~/.config/vsync/defaults` file after upgrade?

It's renamed to `~/.config/vsync/defaults.bak` on first invocation post-upgrade. Read it, recreate the values as a named profile via `vsync profile add`, then delete the `.bak` when you're confident. No auto-migration — operators name their profiles deliberately. See [v0.13 §5](/specs/v0.13-profiles-init-status#_5-migration-from-old-single-default).

## Backends

### Does it work with Cloudflare R2?

Yes. Use R2's account-level API tokens, endpoint format `https://<accountid>.r2.cloudflarestorage.com`, region `auto`. Audit-log append works (R2 supports `If-Match`).

### Does it work with Backblaze B2?

Yes via B2's S3-compatible API endpoint. Use application keys scoped to a bucket. Audit-log append works (B2 supports conditional headers).

### Does it work with Hetzner Object Storage?

Yes — this is the author's daily driver. Endpoint format `https://<region>.your-objectstorage.com`. Use Hetzner sub-users for bucket-scoped IAM. The audit log has a Hetzner-specific quirk (unquoted ETags) that vsync handles automatically — see [audit protocol §Hetzner quirk](/architecture/audit-protocol#the-hetzner-ceph-quirk).

### Does it work with MinIO (self-hosted)?

Yes. MinIO is S3-compatible enough that vsync works out of the box. Audit-log append works (MinIO supports conditional headers in recent versions).

### Does it work with DigitalOcean Spaces?

Yes via the Spaces S3-compatible endpoint. Some users report DO Spaces returning different ETag formats than AWS — the audit-log retry logic handles this, but report any quirks you hit.

### Does it work with Wasabi?

Yes. Same pattern as B2 — S3-compatible API, application keys.

## Migration & versioning

### What changed between 0.9 and 0.10?

Several connected changes:

1. **Profiles replaced single defaults.** New `vsync profile` verb family. `vsync init` now requires `--profile=<name>`.
2. **`vsync runtime-token` + `vsync rotate-passphrase`** CLI verbs added.
3. **Four runtime libraries** shipped (Python, TypeScript, Go, Java) — same wire format across all four.
4. **`vsync status`** command added.

See [upgrade guide](/guide/upgrade-to-0.11) for the step-by-step migration.

### Will 0.11 break my 0.9 deployment?

The wire format is **unchanged** between 0.9 and 0.11 — bundles written by 0.9 are read by 0.11, and vice versa. What broke:

- `~/.config/vsync/defaults` is renamed to `defaults.bak` (cosmetic; doesn't affect bundle access).
- `vsync init` rejects `--bucket=` / `--endpoint=` flags — you must use `--profile=`.
- Runtime libraries renamed `get`/`has`/`source`/`asset_bytes`/`asset_path` → `getEnv`/`hasEnv`/`envSource`/`getAsContent`. Apps using the runtime libs must update method calls.

In-place CLI upgrade works. Runtime-lib upgrade requires code changes.

### Is there a stable wire format I can target with my own reader?

Yes — the wire formats (`RQE1`, `RQEM0001`, `SLS1`, `vsync-cfg-v1:`) are specified in [v0.2](/specs/v0.2-secret-lib), [v0.4](/specs/v0.4-audit-log), [v0.10](/specs/v0.10-runtime-token-cli), [v0.12](/specs/v0.12-vsync-s3-client). The 31-vector conformance corpus at `docs/specs/test-vectors/` is the canonical test set — if your reader passes the corpus, it's compatible.

We don't promise wire-format stability across major versions before 1.0. Pre-1.0 pump-and-dump is permitted; the magic prefixes change on a major break.

## Where to go next

- **Things that broke:** [Troubleshooting](/guide/troubleshooting)
- **Things that went wrong:** [Incident response](/guide/incident-response)
- **Things that need to rotate:** [Passphrase](/guide/rotate-passphrase-runbook) · [IAM key](/guide/iam-rotation-runbook)
- **Upgrade from 0.9.x:** [Upgrade guide](/guide/upgrade-to-0.11)
