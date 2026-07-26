# Releasing

All five artifacts ship under **one unified version**, enforced by
`task check:version`. Publishing runs in GitHub Actions on a `v*` tag, using
**OIDC trusted publishing** — no long-lived registry tokens in this repo.

## One-time setup

Do these once per package. Until they exist, the publish jobs will fail with
an auth error — that's the intended failure mode, not a fallback to tokens.

### npm — `@muthuishere/vsync` and `@muthuishere/vsync-s3-client`

For **each** package on npmjs.com → *Settings* → *Trusted Publisher*:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization / user | `muthuishere` |
| Repository | `vsync` |
| Workflow filename | `release.yml` |
| Environment | *(leave empty)* |

The workflow installs `npm@latest` because OIDC trusted publishing needs npm
CLI ≥ 11.5.1. It uses `npm publish`, **not** `bun publish` — the OIDC
handshake lives in the npm client.

### PyPI — `vsync-s3-client`

pypi.org → project → *Publishing* → *Add a new publisher* → GitHub:

| Field | Value |
|---|---|
| Owner | `muthuishere` |
| Repository | `vsync` |
| Workflow name | `release.yml` |
| Environment | *(leave empty)* |

### Maven Central — no OIDC

Sonatype's Central Portal has **no GitHub OIDC trusted-publisher flow**, so
Java is the one artifact that still needs secrets. The job is *gated* on them
and skips cleanly when absent, so it never blocks the rest of the release.

Repository secrets, if you want Java published from CI:

- `CENTRAL_TOKEN_USERNAME` / `CENTRAL_TOKEN_PASSWORD` — Central Portal user token
- `MAVEN_GPG_PRIVATE_KEY` — ASCII-armoured private key
- `MAVEN_GPG_PASSPHRASE`

Otherwise publish it by hand: `task java:publish`.

### Go — nothing to configure

There is no registry. The module is resolved from the `libraries/go/v<version>`
tag; pushing that tag *is* the release.

## Cutting a release

```bash
# 1. bump every package to the same version, then confirm
task check:version                 # must print ✓ all packages at <version>

# 2. full local gate
task test:all                      # CLI + Python + TS + Go + Java

# 3. tag (local only — creates v<version> AND libraries/go/v<version>)
task tag:release

# 4. this is the irreversible step — it triggers the publish workflow
git push --tags
```

Step 4 is the point of no return: npm and PyPI releases cannot be
un-published, only deprecated or yanked. Everything before it is local and
reversible.

## Rehearsing without publishing

Actions → **Release** → *Run workflow* → leave **dry_run** checked. That runs
the full gate plus `npm publish --dry-run` and a real PyPI build, and uploads
nothing.

## What the workflow guarantees

- The tag and `package.json` version must match, or the run fails immediately.
- `task check:version` and the whole CLI suite must pass **before** any
  publish job starts, so a partial release across four registries is unlikely.
- Each publish job requests `id-token: write` explicitly; the top-level
  default is `contents: read`.
- If the companion `libraries/go/v<version>` tag is missing, the run warns
  rather than failing — the other artifacts are already out by then, and the
  fix is simply pushing the tag.

## If a release goes wrong

- **npm** — `npm deprecate @muthuishere/vsync@<version> "<why>"`. Unpublishing
  is only possible within 72 hours and is disruptive; prefer a patch release.
- **PyPI** — yank the release in the web UI. Yanked versions stay installable
  by exact pin but are skipped by resolvers.
- **Go** — a tag cannot be meaningfully retracted once the proxy has cached
  it. Publish a new patch and, if needed, add a `retract` directive to
  `go.mod`.
- **Maven Central** — immutable. Publish a patch.

Because three of the four are effectively irreversible, the local gate exists
to catch problems before `git push --tags`.
