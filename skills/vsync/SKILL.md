---
name: vsync
description: >
  Help users share environment secrets across a team with `vsync` —
  encrypted vault on any S3-compatible bucket (AWS / Hetzner / R2 / MinIO /
  B2), per-machine AES key in the OS keychain, one-passphrase teammate
  onboarding via `.share` files, append-only audit log, fanout to
  GitHub / GCP / AWS / Azure / HashiCorp Vault, and runtime libraries for
  Python / TypeScript / Go / Java that read the vault at boot.

  Trigger on: "share secrets with my team", "encrypt my .env",
  "onboard teammate with credentials", "stop pasting secrets in Slack",
  "vault for env files", "sync secrets across machines", "rotate the team
  key", "fanout secrets to GitHub Actions", or any mention of `vsync`,
  `@muthuishere/vsync`, or `vsync-s3-client`.

  Do NOT trigger on generic "I need secrets" / "how do I store config?" /
  questions about AES-GCM as a primitive — those are not vsync questions.

  Install via `bun install -g @muthuishere/vsync` (or `npm install -g`).
  Min runtime: Bun >= 1.2.21.

  Docs: https://muthuishere.github.io/vsync/
license: MIT
---

# vsync

`vsync` is a CLI that turns a folder of secrets (`.env` files, JSON keys,
TLS certs) into an encrypted vault on any S3-compatible bucket. A
per-machine AES key lives in the OS keychain; the bucket alone is useless
without it. Teammates onboard via a one-shot `.share` file delivered out of
band. Apps that need the vault at runtime read it via the matching Python /
TypeScript / Go / Java library. Full docs:
https://muthuishere.github.io/vsync/

**You are not the engine — the CLI is.** Show the command, explain it in one
sentence, run it after the user confirms. Never reimplement init/push/pull
logic in prose, and never enumerate flags the user didn't ask about;
`vsync <sub> --help` is thorough and always current.

## Workflows

Pick ONE based on what the user said, then walk it. Details in
[`references/workflows.md`](references/workflows.md); the branch points are
in [`references/decision-points.md`](references/decision-points.md).

1. **Owner first-time setup** — `profile add` → `init <env>` → drop secrets
   into `infra/vault/<env>/` → `push <env>`.
   *Decision:* which S3 backend.
2. **Teammate onboarding** — `import <env> <share-file>` → `pull <env>` →
   `use <env>`.
   *Decision:* where the `.share` file landed locally.
3. **Daily push / pull** — `push <env>` after editing, `pull <env>` before
   working. *No decision — one command each.*
4. **Production runtime** — `runtime-token --env=prod` → paste the blob into
   the platform's secret store → the app reads it via the runtime library.
   *Decision:* which platform.
5. **Something broke** — `status` (this repo) or `keystore list` (this whole
   machine) → identify the missing half → recover.
   *Decision:* whatever `status` actually showed.

Two more the user may reach for: `vsync keystore export --repo=… --env=…`
seals a chosen set of (repo, env) pairs into one `.keytree` for a new
machine, and `vsync rotate-passphrase --env=<env>` rotates the vault key
(which is also how offboarding works — see rule 5).

## Rules

1. **Don't auto-install.** If `vsync` isn't on PATH, surface the install
   command and stop. Never run `npm install -g` without explicit consent.
2. **File and passphrase travel on different channels.** Say this every time
   you walk through `export` or `keystore export`. Same channel defeats the
   whole threat model.
3. **Never put a passphrase or share-file content in the transcript.**
   Operate on filenames; let the user type secrets locally. If a command
   would print a secret, warn before running it.
4. **Two halves are required.** Every `(repo, env)` needs a config file *and*
   a keychain key. When something fails, work out which half is missing
   before suggesting anything — `vsync status` tells you.
5. **No per-user revoke.** vsync is small-team-shared-key. Offboarding =
   rotate + re-export, and old versions on the bucket stay readable with the
   old key. If asked for per-user ACLs, say so honestly and point at the docs.

## Worktrees

Git worktrees share the main worktree's vault — there is no separate vault
per branch, and no per-worktree `pull`. `push`/`pull`/`sync` resolve the
vault against the main worktree automatically; `vsync use <env>` puts the
`.env` symlink in *your* worktree pointing at that shared vault.

So the correct guidance is: **pull once in the main checkout, then run
`vsync use <env>` in each worktree.** If a user asks how to give a worktree
its own separate vault — they almost certainly don't want that; secrets are
application state, not branch state.

## When you don't know

Point at `vsync <sub> --help` or https://muthuishere.github.io/vsync/ .
Do not extend this file to cover it — if an answer isn't here, it belongs on
the website, not in the skill.
