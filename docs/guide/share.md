# Onboarding teammates

The `.share` file is the one-passphrase onboarding step. It bundles **both halves** required to push/pull — the S3 credentials + the AES encryption key — sealed with a passphrase you generate at export time.

## Owner: export a `.share`

```bash
vsync export dev
```

Output:

```
✅ wrote ./<repo>-dev.share
   passphrase: correct-horse-battery-staple

Send the file and passphrase on different channels.
The file is useless without the passphrase; the passphrase is useless without the file.
```

The default passphrase is a randomly-generated 4-word phrase (~52 bits entropy — fine for the threat model since the `.share` file isn't published). Override with `--passphrase=<your-own>` if you want to pick it.

Override the output path with `--out=<path>` (default: `./<repo>-<env>.share` at cwd).

## Send via two channels

This is the load-bearing security step:

- **File** via one channel: Slack DM, email attachment, AirDrop, USB stick.
- **Passphrase** via a different channel: SMS, password manager's secure share, voice call.

If you send both on Slack, a Slack-compromise gives the attacker both halves. The whole point of the split is that an attacker has to compromise **two** channels.

## Teammate: import + pull

```bash
cd cloned-repo
vsync import dev ./<repo>-dev.share
# Passphrase: <paste>
```

Idempotent — re-importing overwrites the local config + keychain entry. Useful if the team rotated the key and re-shared.

Then pull the vault contents:

```bash
vsync pull dev
```

And link the `.env`:

```bash
vsync use dev
```

Total time: ~30 seconds from receiving the `.share` to having a working `infra/vault/dev/`.

## After onboarding

The `.share` file has served its purpose — delete it. The teammate's machine now has the per-(repo, env) config + keychain key; they don't need the share file again unless they re-onboard a new machine.

## Onboarding a second device for yourself

Same flow. Export from machine A, send to machine B (Signal-to-Signal, email to yourself), import + pull on machine B. Both machines now hold the same halves and can push/pull independently.

## Onboarding multiple teammates

One `.share` per teammate? Or one shared `.share`?

vsync doesn't enforce. But: **send each teammate a fresh export** so the audit log can attribute imports to specific people. The audit log records the `git_email` and `os_user` of whoever imports, but a re-used `.share` doesn't change behavior — it just makes the trail less granular.

## Rotation / offboarding

There's no per-user revoke. When someone leaves:

1. **Revoke their bucket access** at the cloud provider (separate axis from vsync — IAM / API key delete).
2. **Re-init the (repo, env)** — `vsync init dev` overwrites the keychain entry with a new key. Re-`push` from local.
3. **Re-export `.share` files** for surviving teammates so they can re-import the new key.

The ex-teammate still has whatever secrets they `pull`ed in the past. Anything actively sensitive (DB passwords, API tokens) needs to be rotated in the upstream systems too — vsync can't and won't try.

See also: [Audit log](/guide/audit) — the audit trail surfaces who exported when, useful for spotting unexpected exports.

---

[Next: Fanout to where prod runs →](/guide/sync)
