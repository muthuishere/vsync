# Push / pull / versions

The day-to-day rhythm.

## `vsync push <env>`

```
[1/5] zipping infra/vault/dev/
[2/5] sealing manifest ts=20260516-113304
[3/5] encrypting
[4/5] uploading 646 bytes → s3://muthuishere-vsync-e2e/vsync/dev/versions/20260516-113304.enc
[5/5] updating pointer → s3://muthuishere-vsync-e2e/vsync/dev/latest
✅ pushed vsync/dev (version: 20260516-113304)
```

Five steps:

1. **Zip** the resolved vault folder (`infra/vault/<env>/` by default).
2. **Manifest-seal** — embeds the timestamp inside the encrypted plaintext (anti-rollback; see [Crypto envelopes](/architecture/crypto)).
3. **Encrypt** with AES-256-GCM using your per-(repo, env) AES key.
4. **Upload** to `s3://<bucket>/<repo>/<env>/versions/<ts>.enc`.
5. **Update pointer** — atomically replaces `s3://<bucket>/<repo>/<env>/latest` with the new version's timestamp.

If anyone's pulling concurrently, they'll see either the old version or the new — never a half-written one.

## `vsync pull <env>`

```
[1/6] backing up local infra/vault/dev/ (if any)
      → /Users/muthu/.config/vsync/backups/dev-20260516-113414.zip.enc
[2/6] reading pointer s3://…/vsync/dev/latest
[3/6] downloading version 20260516-113343 (vsync/dev/versions/20260516-113343.enc)
[4/6] decrypting
[5/6] verifying manifest ts
[6/6] unzipping into /Users/muthu/projects/myrepo
✅ pulled vsync/dev version 20260516-113343
```

Six steps:

1. **Backup** the current vault folder (encrypted with the same key) to `~/.config/vsync/backups/`. Two-deep rolling buffer — older backups auto-pruned. See [Recovering a local backup](#recovering-a-local-backup) below.
2. **Read pointer** — fetches the `latest` object to learn which version to pull.
3. **Download** the version's `.enc` blob.
4. **Decrypt** with the keychain key + PBKDF2 over the per-repo salt.
5. **Verify manifest ts** — refuses to install a bundle whose embedded timestamp doesn't match the pointer. This rejects "pointer flipped to old version" attacks from anyone with bucket-write but not the key.
6. **Unzip** into the resolved vault folder. Existing files are overwritten.

## `vsync versions <env>`

```
s3://muthuishere-vsync-e2e/vsync/regression/versions/  (5 versions)
 * 20260516-180858    646 B    2h ago
   20260516-174208    644 B    5h ago
   20260515-201410    640 B    1d ago
   20260515-180858    646 B    1d ago
   20260515-152233    640 B    2d ago
```

Read-only list of every version on S3 for this (repo, env), newest-first. The `*` marker shows which version `latest` currently points at. No decrypt needed; only the disk config (S3 creds) is read.

Useful for:

- Verifying your `push` landed.
- Confirming a teammate's recent push before you `pull`.
- Spotting unexpected versions (someone else's machine pushed?).

## Switching envs mid-day

```bash
vsync use production       # repoint ./.env → infra/vault/production/.env.production
bun run dev                # restart with prod creds (be careful!)
vsync use dev              # back to dev
```

See [Switching envs](/guide/use).

## Backups & recovery

Before each `pull`, vsync writes the existing vault folder to `~/.config/vsync/backups/<env>-<ts>.zip.enc` (two-deep rolling buffer). The format is AES-256-GCM with the same per-(repo, env) keychain key + salt.

To decrypt one by hand (rare — `pull` itself is the recovery path 99% of the time):

1. Get the key:
   - **macOS:** `security find-generic-password -s tools.vsync -a <repo>/<env> -w`
   - **Linux:** `secret-tool lookup service tools.vsync account <repo>/<env>`
   - **Windows:** Credential Manager UI under "tools.vsync"
2. Get the salt: `gunzip -c ~/.config/vsync/<repo>/env_<env> | jq -r .encryption.salt`
3. Envelope is `RQE1` (4-byte magic) + 12-byte IV + AES-GCM ciphertext. Derive: `AES-GCM key = PBKDF2-SHA256(keychain-key, salt, 600k iters)`.

In practice, don't lose the keychain entry, and you'll never need this.

---

[Next: Onboarding teammates →](/guide/share)
