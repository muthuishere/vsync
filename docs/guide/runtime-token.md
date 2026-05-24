# Runtime tokens (and passphrase rotation)

The CLI writes the vault. The [runtime libraries](/libraries/) read it. The bridge between them is a **runtime token** — a single string you paste into your deployment platform's environment, alongside the passphrase.

## What `vsync runtime-token` does

Mints the `VSYNC_CONFIG` bootstrap blob the runtime libs read. The blob is:

```
vsync-cfg-v1:<base64url(gzip(JSON))>
```

The inner JSON contains S3 endpoint + region + bucket + scoped IAM key + prefix + env + salt + iterations. gzip + base64url-no-pad keeps it env-var-safe (no padding chars to escape).

## Minting a token

```bash
# Uses your existing per-(repo, env) config (from `vsync init`)
vsync runtime-token --env=prod
```

Output (single line on stdout — pipe-friendly):

```
vsync-cfg-v1:H4sIAAAAAAAAA3WPMQ7CMAxFr2J5BomEhCFqJZbCxgQH...
```

Paste this into your platform's secret store as `VSYNC_CONFIG`. The passphrase you set at `vsync init` goes in as `VSYNC_PASSPHRASE`.

## What it validates

By default, `runtime-token` does a single S3 HEAD against `<prefix>/manifest` before emitting the blob — catches wrong creds / wrong bucket / wrong region at issue time, not at your app's first boot.

- 200 / 304 → ✓ emit blob.
- 403 / 401 → exit 2, "credentials accepted by S3 but cannot read `<prefix>manifest`".
- 404 on manifest → **non-fatal warning** (freshly-init'd env may not have been pushed yet; "run `vsync push <env>` before booting apps") + emit blob anyway.
- DNS / connect / TLS / 5xx → exit 3.

```bash
vsync runtime-token --env=prod --no-validate     # skip the HEAD (offline / air-gapped)
vsync runtime-token --env=prod --json            # also dump the pre-encoding JSON to stderr
                                                 # (with a loud "this contains your AWS secret" banner)
```

## Override fields at mint time

```bash
vsync runtime-token --env=prod \
  --access-key=AKIA_NEW \
  --secret-key=NEW_SECRET
```

Useful after your cloud-admin team rotates the IAM key (see "IAM key rotation" below). Other overrides: `--bucket`, `--endpoint`, `--region`, `--prefix`.

## Deploying the two env vars

Pick whichever pattern fits your platform.

**Cloud platforms (Vercel, AWS ECS, GCP Cloud Run, Azure App Service):**

```
Vercel:        Environment Variables UI → VSYNC_CONFIG, VSYNC_PASSPHRASE (mark both as "Sensitive")
AWS ECS:       Task definition → "secrets": [{ "name": "VSYNC_CONFIG", "valueFrom": "arn:aws:secretsmanager:..." }]
GCP Cloud Run: --set-secrets=VSYNC_CONFIG=projects/.../secrets/cfg:latest
Azure:         App Service → Configuration → Application settings → @Microsoft.KeyVault(SecretUri=...)
```

**VPS / Docker / bare-metal:**

Use the `_FILE` variant so the secret lives at a host path mounted into the container.

```bash
# On the host:
echo 'vsync-cfg-v1:H4sIAAAA...' > /etc/vsync/config
echo 'correct-horse-battery-staple' > /etc/vsync/passphrase
chmod 0600 /etc/vsync/*

# Docker:
docker run \
  -v /etc/vsync:/etc/vsync:ro \
  -e VSYNC_CONFIG_FILE=/etc/vsync/config \
  -e VSYNC_PASSPHRASE_FILE=/etc/vsync/passphrase \
  myapp:0.11.0
```

`_FILE` wins if both forms are set — operator who mounted a file meant it. Trailing whitespace is stripped from file values; env values are taken verbatim (leading-space in passphrase IS part of the passphrase).

The runtime libs check file permissions: warn on world-readable (`0644`), refuse on world-writable (`0666`).

## Rotating the passphrase

If the passphrase leaked into logs, Slack, an ex-employee's terminal, or you just want to rotate on schedule — there's a first-class verb:

```bash
$ vsync rotate-passphrase --env=prod
Old passphrase: ********
New passphrase: ********
Confirm new passphrase: ********
Re-encrypt bundle and push? [y/N] y

✓ Bundle re-encrypted with new passphrase (gen=3 → gen=4)
✓ Manifest pointer updated atomically (ETag-conditional)
✓ Audit log entry written

Next steps:
  1. Update VSYNC_PASSPHRASE (or contents of VSYNC_PASSPHRASE_FILE)
     in your secret store / host file
  2. Roll-restart apps in prod

⚠ Apps booting between this moment and step 1 will fail to decrypt.
  This rotation race window is operator-owned; vsync cannot bridge it in v1.
```

### What rotate does atomically

1. Decrypt the current bundle with the old passphrase (in-memory).
2. Re-encrypt the plaintext with the new passphrase (fresh salt, fresh nonce).
3. PUT new bundle to S3 (new object key; old object untouched).
4. ETag-conditional manifest swap: `If-Match: <currentManifestEtag>` (per [v0.4](/specs/v0.4-audit-log)) — so a concurrent rotation aborts cleanly with 412.
5. Append an `action="rotate"` row to the audit log with `meta = {"event":"rotate", "gen":N+1, "prev_gen":N}`.

At no point may the bundle and manifest disagree. If step 3 fails, you exit with a clear "stale object at `v=<newTs>` is harmless (manifest never named it)" hint.

### The race window

Between when the CLI updates the S3 manifest and when you update `VSYNC_PASSPHRASE` in your platform secret store, **apps that boot will fail to decrypt** — they'll pull the new bundle but try to decrypt with the old passphrase from their env.

Shorten the window. The recipe:

1. Have the new passphrase ready in your platform's secret store *before* running `vsync rotate-passphrase`.
2. After rotate succeeds: trigger a rolling restart immediately.
3. Apps that boot during the window get `WrongPassphraseError` from `Vsync.open()` and exit; the orchestrator restarts them; by then your secret-store update has propagated.

Two-passphrase grace-period rotation (accept either passphrase for an overlap window) is parked for v2.

## IAM key rotation — done externally, then re-mint

`vsync rotate-passphrase` only rotates the **passphrase**. The IAM key embedded in `VSYNC_CONFIG` is rotated **externally** by your cloud-admin team (or by AWS Secrets Manager auto-rotation if the bucket creds live there). vsync deliberately has no IAM admin permissions.

Workflow:

```bash
# 1. Cloud-admin team issues a new scoped read-only IAM key.

# 2. Operator re-mints the bootstrap blob with the new creds:
vsync runtime-token --env=prod \
  --access-key=AKIA_NEW \
  --secret-key=NEW_SECRET
# → vsync-cfg-v1:H4sI...new...

# 3. Update VSYNC_CONFIG in the platform secret store.
# 4. Roll-restart apps. New IAM key is in use; old key can be revoked.
```

`runtime-token` validates the new creds against S3 before emitting (the HEAD probe) — wrong creds fail loud at issue time, not at app boot.

## Exit codes

`runtime-token`:

| Code | Meaning |
|---|---|
| 0 | Blob written to stdout |
| 1 | Missing required input (no creds + no TTY, missing `--env`) |
| 2 | Credential validation failed (403/401 on manifest) |
| 3 | S3 unreachable (DNS / network / TLS / 5xx) |
| 4 | Per-(repo, env) config file missing |

`rotate-passphrase`:

| Code | Meaning |
|---|---|
| 0 | Rotation complete; audit row written |
| 1 | Wrong old passphrase / mismatched new passphrase / missing input |
| 2 | S3 error during bundle re-upload |
| 3 | Manifest swap failed — 412 conflict (concurrent rotation) |
| 4 | Rotation succeeded but audit append failed (recovery hint printed) |
| 5 | Per-(repo, env) config file missing |

## Where to go next

- **Runtime libraries** that read what you minted: [/libraries/](/libraries/)
- **Spec for the wire format:** [`v0.10-runtime-token-cli`](/specs/v0.10-runtime-token-cli)
- **Spec for the lib API:** [`v0.12-vsync-s3-client`](/specs/v0.12-vsync-s3-client)
- **Audit log details:** [Audit log](/guide/audit)
