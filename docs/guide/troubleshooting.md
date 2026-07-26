# Troubleshooting

Symptoms grouped by where they surface. Each entry: typical cause, how to diagnose, how to fix.

## CLI errors

### `no config file for <repo>/<env>`

The per-(repo, env) file isn't on disk.

- **You own this env:** `vsync init <env> --profile=<name>` creates one.
- **A teammate already set it up:** ask them to `vsync export <env>` and send you the `.share` + passphrase, then `vsync import <env> <file>`.
- **You're in the wrong directory:** repo identity is auto-detected from `package.json` / git root / cwd ([precedence chain](/architecture/repo-identity)). `cd` into the actual project root, or pass `--repo=<name>` explicitly.

### `encryption key for <repo>/<env> not found in keychain`

The disk file exists but the keychain entry is gone (someone wiped Keychain Access, or you imported the config without the key).

- **Re-`import`** the `.share` (carries both halves — config + key).
- **OR `vsync init <env>`** — generates a fresh key. Any prior S3 bundle for this (repo, env) becomes inaccessible to you. Re-`push` from local to seed the new key. **Coordinate with the team** before doing this — it invalidates everyone else's pulls until they re-import.

### `failed to decrypt share file — passphrase wrong or file corrupt`

Double-check the passphrase. Whitespace and case matter. If still failing, ask the sender to re-`export` — the file may have been truncated in transit.

### `pointer claims X but bundle was sealed as Y` during pull

Defensive anti-rollback check failed. Someone with bucket-write access pointed `latest` at a renamed older bundle, but the embedded manifest timestamp doesn't match. Refuse + report to ops.

This is the manifest pointer-seal (`RQEM0001`) doing its job. See [Crypto envelopes](/architecture/crypto#rqem0001-manifest-pointer-seal).

### `failed to decrypt s3://… — the keychain key for <repo>/<env> doesn't match the bundle's seal`

The key in your keychain wasn't the one used to seal the bundle. Most likely cause: someone re-`init`-ed the (repo, env), pushed a new bundle, and forgot to re-`export` for you. Get a fresh `.share` from them.

### `Missing --profile=<name>. Run vsync profile list to see available profiles.`

`vsync init` requires an explicit profile flag (as of 0.10). Create a profile first:

```bash
vsync profile add <name>
vsync init <env> --profile=<name>
```

If you have a TTY, running `vsync init <env>` without `--profile` shows an interactive picker. Non-TTY (CI) always requires the flag.

### `Profile <name> not found. Existing: a, b, c.`

Typo in the profile name, or the profile was removed. Check:

```bash
vsync profile list
```

### `Config exists for <repo>/<env>` (re-init prompt)

You're trying to `vsync init` an env that's already configured. The CLI shows the current config and asks `[k]eep / [o]verwrite / [e]dit / [a]bort`. Choose:

- **keep / abort** — exit, no changes.
- **edit** — re-prompt every field with current values as defaults. Hit Enter through what you don't want to change.
- **overwrite** — wipe and re-init. **Must type `o` or `overwrite`** (no bare-Enter into destructive paths).

Non-TTY: the CLI refuses and tells you to add `--interactive` on a TTY or manually remove the config file.

## Sync target errors

### `My GITHUB_TOKEN got pushed to GitHub Actions`

As of **v0.7**, vsync has no implicit excludes. A bare `vsync sync dev gh` will push every KV in `.env.<env>` — including `GITHUB_TOKEN` and `GOOGLE_APPLICATION_CREDENTIALS`. Pre-0.6 silently skipped both; that magic is gone.

To restore the old behaviour, name the exclusions explicitly:

```bash
vsync sync dev gh \
  --exclude-property=GITHUB_TOKEN \
  --exclude-property=GOOGLE_APPLICATION_CREDENTIALS
```

`--exclude-property` is repeatable — one occurrence per key. Drop the flag set into your Taskfile / CI so the policy is visible at the call site. See [v0.7 migration](/specs/v0.7-explicit-sync-parser#_5-migration-0-6-x-→-0-7-0).

### `My FOO_PATH arrived as a path string instead of file contents`

Same story: as of **v0.7** the `_PATH` / `_FILE` suffix-to-file rule is no longer applied automatically. A bare `vsync sync` pushes `FOO_PATH=keys/foo` as the literal string `keys/foo`.

Opt in explicitly:

```bash
vsync sync dev gh \
  --inline-file-suffix=_PATH \
  --inline-file-suffix=_FILE
```

Repeatable — one suffix per occurrence. Add any custom suffixes your project uses (`_KEY`, `_CERT`, etc.) the same way. See [Fanout — file references](/guide/sync#file-references-in-env-env-explicit-opt-in).

### AWS: `aws secretsmanager` errors with `ResourceNotFoundException`

Expected on the first push to a brand-new key — vsync probes with `describe-secret` and switches to `create-secret` when the secret doesn't exist yet. The line shows up only because the AWS CLI prints to stderr before exiting non-zero; vsync swallows the exit code and continues with `create-secret`. If the message keeps appearing on subsequent runs of the *same* key, the real cause is a **region mismatch** — `--aws-region` is missing, wrong, or pointing at a region where the secret was never created.

```bash
# Check what's persisted in the per-(repo, env) config:
gunzip -c ~/.config/vsync/<repo>/env_<env> | jq .sync.aws
```

Set the right region with `--aws-region=<region>` (saved on first use) and re-run.

### Azure: `az keyvault secret set` rejects my key with "name does not match"

Azure Key Vault accepts only `0-9 A-Z a-z -` in secret names. An underscore in your `.env.<env>` (e.g. `DATABASE_URL`) fails at push time with a name-validation error from `az`.

**vsync deliberately does not translate `_` → `-`** — that's the v0.7 no-magic theme. Operator options:

- Rename the key in `.env.<env>` to use a dash (`DATABASE-URL=…`).
- Skip the offending keys with `--exclude-property=DATABASE_URL` (repeatable).
- Maintain an Azure-shaped env file alongside the shared one.

See [Fanout — `vsync sync <env> azure`](/guide/sync#vsync-sync-env-azure) for the full constraint discussion.

### Vault: `vault kv put` fails with "permission denied" or "no handler for route"

Two distinct causes, same surface:

- **`no handler for route`** — `--vault-mount` points at something that isn't a KV v2 mount. vsync only supports KV v2 (KV v1, Transit, PKI, namespaces are out of scope). Check with `vault secrets list` and pass the right mount.
- **`permission denied`** — the token from `vault login` (in `~/.vault-token`) lacks `create` / `update` capability on `<mount>/data/<secretPath>`. Talk to whoever manages your Vault policies; vsync doesn't elevate or refresh tokens.

vsync writes the whole KV map in **one atomic `vault kv put`** — either everything lands or nothing does. There's no partial-success state to recover from.

### `gh` / `gcloud` / `aws` / `az` / `vault` not found on PATH

Install and authenticate them locally. vsync shells out for all five sync targets; it doesn't manage external CLI auth for any of them.

- GitHub CLI: [cli.github.com](https://cli.github.com)
- gcloud CLI: [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)
- AWS CLI: [aws.amazon.com/cli](https://aws.amazon.com/cli/)
- Azure CLI: [learn.microsoft.com/cli/azure/install-azure-cli](https://learn.microsoft.com/cli/azure/install-azure-cli)
- HashiCorp Vault CLI: [developer.hashicorp.com/vault/install](https://developer.hashicorp.com/vault/install)

After install: `gh auth login` / `gcloud auth login` / `aws configure` (or `aws sso login`) / `az login` / `vault login`.

## Audit log errors

### `warning: failed to record audit entry: …` after a successful push/pull

The parent command succeeded; only the audit-append failed. Possible causes:

- **403 AccessDenied** — your IAM key can't write to `audit.csv` (read-only setup). Silently skipped; nothing to do.
- **5xx / network error** — transient bucket failure. Pull/push still succeeded.
- **412 Precondition Failed × 3** — three concurrent writers raced for the audit log. Your row was dropped after the third retry; the others probably landed. Re-running the command with `--no-audit` (then a manual `vsync audit` to confirm) is fine.

See [Audit append protocol](/architecture/audit-protocol) for the retry logic.

## Runtime library errors

The runtime libs (Python / TypeScript / Go / Java) raise one of seven canonical error classes on boot. Each maps to a typical cause, a diagnostic step, and a recovery action.

### `ConfigMissingError` / `ConfigMissingException` / `ErrConfigMissing`

**Cause:** `VSYNC_CONFIG` or `VSYNC_PASSPHRASE` is unset, or the magic prefix on `VSYNC_CONFIG` is wrong (you pasted raw JSON or a token from a different version).

**Diagnose:**

```bash
# Inside the running container / on the host:
echo "$VSYNC_CONFIG" | head -c 20    # should print "vsync-cfg-v1:..."
echo "$VSYNC_PASSPHRASE" | wc -c     # non-zero
```

If the value is unset, the platform isn't injecting it. Check:

- **Vercel:** Settings → Environment Variables → is it marked Sensitive and scoped to this deployment env?
- **ECS:** Task definition `secrets` block resolved? `aws ecs describe-tasks --tasks <id>` shows env at start.
- **Cloud Run:** `gcloud run services describe <svc>` shows the `--set-secrets` mapping.
- **EKS:** the projected K8s Secret exists? `kubectl get secret myapp-vsync-env -o yaml`.
- **VPS:** `ls -la /etc/vsync/` — files exist, mode 0600.

**Fix:** wire up the missing path, redeploy.

### `ConfigUnsupportedVersionError` / similar

**Cause:** The inner JSON of `VSYNC_CONFIG` has a `v` field newer than what the library understands. E.g. you minted with vsync 0.15 but the runtime lib pinned at 0.11.

**Fix:** bump the runtime library version in your dependency manifest. The library is forward-compatible only within a major version — past a `v: 2` blob, you need a `vsync-s3-client` version that knows `v: 2`.

### `S3UnreachableError` / similar

**Cause:** The library could establish a TCP connection but the request didn't get a 200. Common subtypes:

- **DNS** — `<endpoint>` doesn't resolve. The endpoint URL in your `VSYNC_CONFIG` blob is wrong (typo, dead domain).
- **TCP / TLS** — the endpoint refuses connection or TLS handshake fails. Network egress restricted; VPC SG / firewall blocks 443; corporate proxy.
- **403 Forbidden** — IAM key valid but lacks `s3:GetObject` / `s3:ListBucket` on the prefix.
- **401 Unauthorized** — IAM key invalid (wrong, revoked, never existed).
- **5xx** — S3 itself is down (rare) or the regional endpoint is unhealthy.

**Diagnose:**

```bash
# Decode the blob to inspect the endpoint and IAM key id (the secret is omitted)
echo "$VSYNC_CONFIG" | sed 's/^vsync-cfg-v1://' | base64 -d | gunzip | jq '{endpoint, region, bucket, prefix, accessKeyId}'

# Test connectivity from the runtime host
curl -v "https://<endpoint>/" -o /dev/null

# Re-mint with --no-validate to confirm whether validation HEAD was succeeding before
vsync runtime-token --env=prod --no-validate
```

**Fix:** depends on the subtype. Wrong endpoint → fix the blob and redeploy. Bad IAM → [IAM rotation runbook](/guide/iam-rotation-runbook). Network → check firewall / VPC.

### `ManifestNotFoundError` / similar

**Cause:** Bucket reachable, IAM key authorised, but `<prefix>manifest` doesn't exist. Typical reasons:

- **Env was init'd but never pushed.** Run `vsync push <env>` from a laptop with the env configured.
- **Prefix mismatch** — the `prefix` in the blob doesn't match where the CLI pushed. E.g. blob says `myapp/prod/`, but the team is pushing to `acme/prod/`. Re-mint the blob from the same machine that does the pushes so they match.
- **Bucket got wiped / lifecycle-policy deleted it.** Re-push from local.

**Diagnose:**

```bash
aws s3 ls s3://<bucket>/<prefix>
# Should show: manifest, audit.csv, v=20...
# If empty: the env wasn't pushed (or got wiped).
```

**Fix:** run `vsync push <env>` from a teammate with the env.

### `WrongPassphraseError` / similar

**Cause:** Bundle pulled OK; GCM auth tag rejected the supplied passphrase. Common causes:

- **Rotation race window.** You ran `vsync rotate-passphrase` but haven't updated the platform secret store yet. Apps that boot in this window get this error. Update the secret store, restart.
- **Wrong env's passphrase pasted.** `VSYNC_PASSPHRASE` for env A doesn't decrypt env B's bundle.
- **Whitespace mangling.** The passphrase in the secret store has a trailing newline (some `echo "..." | aws secretsmanager update-secret` flows do this). Env-direct injection is taken verbatim — leading/trailing space is part of the passphrase. Use `_FILE` (trailing whitespace stripped) or `echo -n` to avoid the newline.

**Diagnose:**

```bash
# Confirm the value the runtime sees doesn't have a trailing newline
echo -n "$VSYNC_PASSPHRASE" | wc -c   # exact char count
echo "$VSYNC_PASSPHRASE" | wc -c      # +1 if the env var has a trailing \n
```

**Fix:** [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook) if you're mid-rotation, or fix the platform's passphrase value, or use the `_FILE` variant.

### `BundleCorruptError` / similar

**Cause:** The bytes fetched from S3 aren't a valid `RQE1` envelope. Possible reasons:

- **Truncated download** — network failure mid-fetch. Usually transient; retry the request.
- **Manifest points at a non-existent object** — the bucket is in a torn state. Operator needs to investigate `s3://<bucket>/<prefix>` directly.
- **Wrong magic bytes** — the object at `<prefix>v=<ts>` isn't a vsync bundle. Someone uploaded a different file under the manifest pointer (deliberately or by accident).
- **Anti-rollback check failed** — the bundle's embedded timestamp doesn't match the manifest pointer. See [crypto envelopes — RQEM0001](/architecture/crypto#rqem0001-manifest-pointer-seal). This is the protocol catching tampering; report to ops immediately.

**Diagnose:**

```bash
# Pull from a laptop and see if you get the same error
vsync pull <env>
# If yes, the bucket is genuinely torn — escalate.
```

**Fix:** re-push from local: `vsync push <env>`. This atomically writes a new bundle and a new manifest pointing at it, replacing the torn state.

### `UnsupportedSpecVersionError` / similar

**Cause:** The `RQE1` or `RQEM0001` envelope's version byte is unknown to this library. Means the bundle on S3 was written by a newer CLI than your runtime lib supports.

**Fix:** upgrade the runtime library. Versioning across the CLI and runtime libs is tracked together — `vsync-s3-client` 0.11.0 reads what `vsync` 0.11.x writes. Mixing minor versions across the boundary is fine; mixing majors is not.

## Common config mistakes

### `endpoint` URL has a trailing slash

vsync internally appends paths; a trailing slash creates `https://host//manifest`. Strip it.

```
✘ https://s3.amazonaws.com/
✓ https://s3.amazonaws.com
```

### `endpoint` includes the bucket name (virtual-hosted style)

vsync uses **path-style** URLs (`https://<endpoint>/<bucket>/<key>`). If your endpoint already includes the bucket:

```
✘ endpoint: https://my-bucket.s3.amazonaws.com   (virtual-hosted)
✓ endpoint: https://s3.amazonaws.com
  bucket:   my-bucket
```

For S3-compatible providers that only support virtual-hosted (rare), file an issue — vsync today is path-style only.

### IAM key has `s3:GetObject` but not `s3:ListBucket`

`vsync pull` does a `ListObjectsV2` first to find the latest manifest pointer. Without `ListBucket`, you get 403 even though `GetObject` is allowed.

Add both:

```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:ListBucket"],
  "Resource": [
    "arn:aws:s3:::your-bucket",
    "arn:aws:s3:::your-bucket/<prefix>/*"
  ]
}
```

The two `Resource` lines matter — `ListBucket` is a bucket-level action (no `/*`), `GetObject` is an object-level action (with `/*`).

### Prefix doesn't end with `/`

The `prefix` field in `VSYNC_CONFIG` and per-env config must end with `/`. Without it, `<prefix>manifest` resolves wrong.

```
✘ prefix: myapp/prod         (missing trailing slash)
✓ prefix: myapp/prod/
```

vsync's CLI adds the trailing slash automatically at `init` time, but if you hand-edit the blob, double-check.

### `region` mismatch with bucket region

If you specify `region: us-east-1` but the bucket lives in `eu-central-1`, the SigV4 signature is calculated for the wrong region and S3 rejects with `SignatureDoesNotMatch`. Match `region` to the bucket's actual region (or `auto` for providers like Cloudflare R2 that don't care).

## `./.env exists as a regular file — refusing to touch it`

`vsync use` won't clobber a real `.env`. Move or delete it first:

```bash
mv .env .env.local.bak
vsync use dev
```

There is no `--force` flag — by design. See [Switching envs — safety](/guide/use#safety-never-clobber-a-real-file).

## `repo name "profiles" is reserved`

vsync keeps its own state in `<config>/profiles/` and `<config>/backups/`. A
repo with either name would write its config *inside* one of those
directories, colliding with vsync's own files and vanishing from
`vsync keystore list`.

Both names are refused. Pick another with `--repo=<name>`, or commit a
`.vsync` file pinning a different identity. If you hit this after upgrading to
0.15.0, a repo of that name was already half-broken — check
`<config>/profiles/` for a stray `env_*` file and move it under a properly
named directory.

## `pull` fails right after a successful `rotate-passphrase`

Fixed in **0.15.0**. Before that, `rotate-passphrase` re-encrypted the bundle
under the new passphrase but never wrote it back to the OS keychain, so the
machine that ran the rotation kept the *old* key and could no longer decrypt.
Rotation appeared to succeed and quietly locked out the operator.

If you're on an older CLI and stuck in this state: upgrade, then recover local
access with a fresh `vsync export` / `vsync import` from a teammate who still
has a working key — or from a `.keytree` if you made one. Teammates who never
rotated are unaffected.

## Windows: `EPERM` when running `vsync use`

Windows symlinks require either:

- **Developer Mode** — Settings → Privacy & security → For developers
- OR **elevated terminal** — Run as administrator

vsync catches `EPERM` and prints this hint.

## Tests failing on Linux

`bun test test/keychain.test.ts` requires libsecret (`gnome-keyring`, `keepassxc-secret-service`, etc.). Headless Linux without one of these will fail keychain tests.

## "It worked yesterday and now nothing pushes"

Check `vsync versions <env>` — does the bucket still have your bundles?

Check S3 credentials in the disk config:

```bash
gunzip -c ~/.config/vsync/<repo>/env_<env> | jq .s3
```

Then try a direct `aws s3 ls s3://<bucket>/<repo>/<env>/` with those creds. If that fails, the issue is bucket-side (creds rotated, bucket permissions changed) — not vsync.

## `vsync status` shows `LOCAL IS BEHIND`

```
prod  ...  ✘ LOCAL IS BEHIND (local gen=3, remote gen=5)
```

Someone (probably another teammate, possibly a CI job) pushed to this env since you last pulled. Run `vsync pull prod` to catch up.

## `vsync status` shows `keychain key without config (orphan)`

You have a keychain entry for an env that has no on-disk config. Usually means you deleted `~/.config/vsync/<repo>/env_<env>` but didn't delete the keychain entry. Options:

- Restore the config via `vsync import <env>` from a `.share` (if you have it).
- Delete the orphan keychain entry — see [security — inspecting / removing keychain](/architecture/security#inspecting-removing-the-keychain-entry).

## `vsync status` shows `config without key`

Inverse — disk config exists but no keychain entry. Recovery:

- Re-`vsync import` the `.share` — both halves restored.
- Or `vsync init <env>` — generates a new key (invalidates everyone else's bundle for this env until they re-import).

---

Still stuck? [Open an issue](https://github.com/muthuishere/vsync/issues) with the command you ran + the full error message + the output of `vsync status`.
