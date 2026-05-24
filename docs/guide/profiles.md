# Profiles

A **profile** is a named bag of S3 credentials + bucket info that you reuse across repos. One profile per S3 backend (Hetzner, AWS, Cloudflare R2, …) — `vsync init` picks one when you set up an env, so you don't re-type endpoint + creds for every project.

Replaced the older single `~/.config/vsync/defaults` mechanism in **0.10.0**. Multiple profiles, no implicit default, explicit `--profile=<name>` on init.

## The four verbs

```bash
vsync profile list                    # tabular: name, endpoint, bucket
vsync profile show <name>             # full details, secret key masked (AKIA****GXQ4)
vsync profile show <name> --reveal-secret   # interactive confirm, then plaintext secret
vsync profile add <name>              # interactive — prompts for endpoint, bucket, etc.
vsync profile remove <name>           # confirm before delete
```

No `default` verb — there's no default profile concept; you always pick one explicitly. No `rename` verb — `remove` + `add` if you really need to.

## First-time setup

```bash
$ vsync profile add hetzner-personal
S3 endpoint URL [hel1.your-objectstorage.com]:
Region [auto]:
Bucket name: personal-secrets
Default prefix (optional, e.g. "myapp/"): video-ai/
Access key ID: HZN1...
Secret access key: ****************
✓ Created profile hetzner-personal at ~/.config/vsync/profiles/hetzner-personal.json (mode 0600)

$ vsync profile add aws-video-ai-prod
S3 endpoint URL: https://s3.eu-central-1.amazonaws.com
Region: eu-central-1
Bucket name: video-ai-secrets
Default prefix (optional): 
Access key ID: AKIA...
Secret access key: ****************
✓ Created profile aws-video-ai-prod
```

## Listing & inspecting

```bash
$ vsync profile list
NAME                  ENDPOINT                                  BUCKET
hetzner-personal      hel1.your-objectstorage.com               personal-secrets
aws-video-ai-prod     s3.eu-central-1.amazonaws.com             video-ai-secrets
r2-client-a           <accountid>.r2.cloudflarestorage.com      client-a-secrets

$ vsync profile show aws-video-ai-prod
name:            aws-video-ai-prod
endpoint:        https://s3.eu-central-1.amazonaws.com
region:          eu-central-1
bucket:          video-ai-secrets
prefix:          (none — init prompts for one)
accessKeyId:     AKIA********GXQ4
secretAccessKey: ****
```

`show` masks the secret by default. `show --reveal-secret` prompts `Are you sure? [y/N]` before printing the plaintext to stdout. Refuses outright on non-TTY (no `--force` escape — copy from `~/.config/vsync/profiles/<name>.json` directly if you need to script it).

## Using a profile to init an env

```bash
# Required form — explicit profile flag
vsync init prod --profile=aws-video-ai-prod

# TTY without --profile — shows numbered picker
$ vsync init prod
No --profile given. Available profiles:
  1) hetzner-personal      hel1.your-objectstorage.com / personal-secrets
  2) aws-video-ai-prod     s3.eu-central-1.amazonaws.com / video-ai-secrets
  3) r2-client-a           <accountid>.r2.cloudflarestorage.com / client-a-secrets
Pick [1-3], or `q` to quit: 2

# Non-TTY without --profile — fails loud
$ vsync init prod < /dev/null
✘ Missing --profile=<name>. Run `vsync profile list` to see available profiles.

# Profile not found — fails with hint
$ vsync init prod --profile=does-not-exist
✘ Profile `does-not-exist` not found. Existing: hetzner-personal, aws-video-ai-prod, r2-client-a.
   Run `vsync profile add does-not-exist` to create it.
```

## Profile prefix → env prefix

If a profile carries a `prefix` (e.g. `"video-ai/"`), `vsync init prod --profile=<name>` combines it with the env to produce `video-ai/prod/`. If the profile has no prefix, init prompts.

```
profile.prefix = "video-ai/"   +  env = "prod"   →  vault prefix = "video-ai/prod/"
profile.prefix = (none)        +  env = "prod"   →  init prompts for prefix
```

That `video-ai/prod/` is what shows up as the `prefix` field in `VSYNC_CONFIG` blobs (see [Runtime tokens](/guide/runtime-token)), and as the S3 key prefix where the manifest + bundle land.

## Re-init detection — keep, overwrite, edit, abort

Running `vsync init <env>` for an env you've already configured shows you the existing state and asks before clobbering:

```
$ vsync init prod --profile=aws-video-ai-prod
⚠ Config for (video-ai, prod) already exists:
  Profile:    aws-video-ai-prod
  Endpoint:   https://s3.eu-central-1.amazonaws.com
  Bucket:     video-ai-secrets
  Prefix:     video-ai/prod/
  Access key: AKIA********GXQ4
  Created:    2026-03-12 (45 days ago)
  Last push:  2026-04-28

Options:
  [k] keep — exit without changes
  [o] overwrite — re-init this env (your keychain key stays; bundle on S3 unaffected)
  [e] edit — re-prompt with current values as defaults (override prefix, audit, etc.)
  [a] abort

Choice [k]:
```

**Overwrite requires typing `o` or `overwrite`** — bare Enter defaults to `keep`. Designed for muscle-memory safety.

## Where profiles live

```
~/.config/vsync/profiles/
├── hetzner-personal.json
├── aws-video-ai-prod.json
└── r2-client-a.json
```

Each file is `0600` (owner-only). Mode bits checked on every read; world-writable (`0666`) refused outright.

The legacy `~/.config/vsync/defaults` file is **renamed to `defaults.bak`** on first invocation after upgrade from 0.9.x. Operator runs `vsync profile add <name>` to recreate values as a named profile — no auto-migration to a `default.json` (force explicit naming).

## Where to go next

- **Check what's configured:** [Status](/guide/commands#status)
- **Mint a runtime-token from a profile:** [Runtime tokens](/guide/runtime-token)
- **Spec:** [`v0.13-profiles-init-status`](/specs/v0.13-profiles-init-status)
