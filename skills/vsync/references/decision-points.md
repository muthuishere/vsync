# Decision points

Ask these *once*, at the right moment. One question at a time — never a
questionnaire.

---

## Owner or joining?

The first fork, and it decides everything after it.

| Signal | Workflow |
|---|---|
| "I want to share secrets with my team" | Owner setup (1) |
| "someone sent me a file" / "I'm joining" | Teammate onboarding (2) |
| "I got a new laptop" | Keytree restore (7) |

If it's genuinely ambiguous, ask: *"Are you setting this up for the team, or
joining one that already exists?"*

---

## Which S3 backend?

Only asked during owner setup. It decides the endpoint typed into
`vsync profile add`.

| Backend | Endpoint shape |
|---|---|
| AWS S3 | `https://s3.<region>.amazonaws.com` |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` |
| Hetzner | `https://<region>.your-objectstorage.com` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` |
| MinIO / self-hosted | whatever they run it on |

Any S3-compatible bucket works. Don't recommend one — ask what they already
use. If they have no bucket at all, that's a prerequisite to solve before
vsync is useful.

---

## One env or several?

`dev` / `staging` / `prod` are separate `(repo, env)` pairs — separate config,
separate key, separate bucket prefix, separate audit log.

Start with **one**. Adding another later is just another `vsync init <env>`.
Don't have them set up three environments before the first push has ever
worked.

---

## Where did the `.share` file land?

Asked during teammate onboarding. Downloads land in different places per
browser and chat client. Ask for the path rather than guessing
`~/Downloads/…`; a wrong guess produces a confusing "cannot read" error.

---

## Which deployment platform?

Asked only for the production-runtime workflow. It changes *where the blob is
pasted*, never what the blob is:

- Vercel / Netlify → project environment variables
- AWS ECS / Lambda → task definition env or Secrets Manager
- Google Cloud Run → `--set-secrets` / env
- Azure → App Settings or Key Vault
- Plain VPS / systemd → an `EnvironmentFile`, or the `_FILE` convention

---

## Whole env, or part of one?

If someone wants to give a teammate *only some* secrets:

- **A whole env** — `vsync keystore export --repo=<r> --env=<e>` does this
  today, at env granularity.
- **Some secrets within one env** — not supported. One AES key covers the
  whole env; there is no per-secret grant. Say so plainly and suggest a
  separate env for the narrower scope, noting it costs another config + key +
  prefix to maintain.

Don't imply partial-within-env sharing works. It doesn't.
