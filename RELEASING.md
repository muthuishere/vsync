# Releasing

## What actually ships

Only the CLI. As of 0.15.0 it is the sole artifact that has ever been
published:

| Artifact | Registry | Status |
|---|---|---|
| `@muthuishere/vsync` | npm | **published** — released by CI |
| `@muthuishere/vsync-s3-client` | npm | never published |
| `vsync-s3-client` | PyPI | never published |
| `io.github.muthuishere:vsync-s3-client` | Maven Central | never published |
| `libraries/go` | — | no registry; the git tag *is* the release |

The libraries are versioned in lockstep and **built and tested** on every
release, so a CLI can't ship next to broken library code. They are not
uploaded anywhere.

## Auth: OIDC, no tokens

The CLI publishes with **npm OIDC trusted publishing**. There is no
`NPM_TOKEN` in this repo and there shouldn't be.

One-time setup — npmjs.com → `@muthuishere/vsync` → *Settings* →
*Trusted Publisher* → GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `muthuishere` |
| Repository | `vsync` |
| Workflow filename | `release.yml` |
| Environment | *leave blank* |

Two things that fail confusingly if wrong: the workflow field is the bare
filename (no `.github/workflows/` prefix), and Environment must be blank
because the workflow declares none.

The job installs `npm@latest` because OIDC needs npm CLI ≥ 11.5.1, and uses
`npm publish` rather than `bun publish` — the OIDC handshake lives in the npm
client.

## Cutting a release

```bash
task check:version                 # must print ✓ all packages at <version>
task test:all                      # CLI + Python + TS + Go + Java
task tag:release                   # local only: v<version> + libraries/go/v<version>
git push --tags                    # ← irreversible: triggers the publish
```

Everything before `git push --tags` is local and undoable. That last step is
not: an npm version cannot be un-published after 72 hours, only deprecated.

## Rehearsing

Actions → **Release** → *Run workflow*, leave **dry_run** checked. Runs the
version gate, the CLI suite, every library's tests, and
`npm publish --dry-run`. Uploads nothing. Worth doing after any change to the
workflow or to the trusted-publisher config.

## Publishing a library for the first time

Not needed today — recorded so the trap is known when it is.

**npm and Maven have no "pending publisher" concept.** A trusted publisher is
attached to a package that already exists, so the *first* publish of
`@muthuishere/vsync-s3-client` cannot use OIDC. Bootstrap it once by hand:

```bash
cd libraries/typescript && npm publish --access public
```

…then add the trusted publisher on the now-existing package page, and CI can
take it from there.

**PyPI is the exception** — it supports *pending publishers* at
<https://pypi.org/manage/account/publishing/>, which reserve a name that
doesn't exist yet and authorise its first OIDC publish. No manual bootstrap
needed.

**Maven Central has no OIDC path at all.** Sonatype's Central Portal needs a
user token plus a GPG key. If Java ever ships, it needs
`CENTRAL_TOKEN_USERNAME` / `CENTRAL_TOKEN_PASSWORD` / `MAVEN_GPG_PRIVATE_KEY` /
`MAVEN_GPG_PASSPHRASE` as repository secrets, or publish by hand with
`task java:publish`.

**Go needs nothing.** Pushing `libraries/go/v<version>` is the release; the
module proxy resolves it from the tag.

## If a release goes wrong

- **npm** — `npm deprecate @muthuishere/vsync@<version> "<why>"`. Unpublishing
  is only possible within 72 hours and breaks anyone who already installed it;
  prefer a patch release.
- **Go** — a tag can't be meaningfully retracted once the proxy caches it. Ship
  a patch and add a `retract` directive to `go.mod` if needed.
- **PyPI / Maven** — not applicable yet. PyPI supports yanking; Maven Central
  is immutable.
