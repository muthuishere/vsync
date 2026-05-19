---
name: vsync-skill
---

# Setup scripts — `infra/setup/scripts/`

Three shell scripts the Taskfile (`references/taskfile-template.md`) references. Copy each into `infra/setup/scripts/<filename>` and run `chmod +x` on all three.

```bash
mkdir -p infra/setup/scripts
chmod +x infra/setup/scripts/*.sh
```

## `bootstrap-env.sh` — one-shot import + pull

The user-facing onboarding command. A new teammate runs `task bootstrap ENV=dev SHARE=…` and this script chains `vsync import` (prompts for passphrase) + `<env>:pull` task (decrypts vault + creates all symlinks). Idempotent — re-running re-imports (handy after key rotation).

```bash
#!/usr/bin/env bash
#
# One-shot first-time bootstrap for an env: import a .share file (vsync
# prompts interactively for the passphrase that was sent on a separate
# channel) then pull the vault from S3 + set up the symlinks.
#
# Idempotent — re-running re-imports (overwriting the existing keychain
# entry for that env) and re-pulls. Safe on a fresh machine or after a
# key rotation.
#
# USAGE
#   infra/setup/scripts/bootstrap-env.sh <local|dev|production> <share-file>
#
# EXAMPLES
#   infra/setup/scripts/bootstrap-env.sh dev   ~/Downloads/myapp-dev.share
#   infra/setup/scripts/bootstrap-env.sh local ~/Downloads/myapp-local.share

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $(basename "$0") <local|dev|production> <share-file>" >&2
  exit 1
fi

env=$1
share=$2

case $env in
  local|dev|production) ;;
  *)
    echo "error: env must be 'local', 'dev', or 'production' (got '$env')" >&2
    exit 1
    ;;
esac

if [[ ! -r $share ]]; then
  echo "error: share file not readable: $share" >&2
  exit 1
fi

repo_root=$(git rev-parse --show-toplevel)

case $env in
  local)      pull_task=local:pull ;;
  dev)        pull_task=dev:pull ;;
  production) pull_task=prod:pull ;;
esac

echo "→ vsync import $env $share"
echo "  (you'll be prompted for the passphrase from the separate channel)"
echo
vsync import "$env" "$share"

echo
echo "→ task -t infra/setup/Taskfile.yml $pull_task"
echo "  (pulls + decrypts the vault, sets up env-file + SSH symlinks)"
echo

cd "$repo_root"
task -t infra/setup/Taskfile.yml "$pull_task"

echo
echo "✓ $env bootstrapped."
echo "  The .share file is no longer needed; consider removing it:"
echo "    rm $share"
```

## `ensure-link.sh` — conservative `$HOME`-scoped symlink helper

Used for symlinks that live outside the repo (`~/.ssh/<key>` is the canonical case). Different safety semantics from the inline Taskfile recipes: this script **never overrides** an existing symlink even if it points elsewhere, because another worktree or unrelated project may own it.

Behaviour table:

| State | Action |
|---|---|
| Link doesn't exist | Create symlink |
| Symlink points at expected target | No-op (silent success) |
| Symlink points elsewhere | Skip with warning — manual `unlink` required to retarget |
| Regular file at link path | Refuse with error |

```bash
#!/usr/bin/env bash
#
# Idempotent + conservative symlink creator. Used for $HOME-scoped links
# that are shared across worktrees (e.g. ~/.ssh/<key>) — never overrides
# an existing symlink, even if it points somewhere unexpected, because
# another worktree or unrelated project may own it.
#
# For repo-root symlinks like ./.env.<env> that DO need to retarget on
# mismatch (each worktree owns its own copy), use the inline ensure:link
# / ensure:local:link recipes in the Taskfile instead.
#
# USAGE
#   ensure-link.sh <link-path> <target-path>
#
# BEHAVIOR
#   missing                       → create symlink
#   symlink, correct target       → no-op (silent success)
#   symlink, different target     → skip with warning
#                                    (never overrides — delete manually to retarget)
#   regular file                  → refuse with error
#
# Both paths can be absolute or relative.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $(basename "$0") <link-path> <target-path>" >&2
  exit 1
fi

link=$1
target=$2
name=$(basename "$link")

if [[ -L $link ]]; then
  current=$(readlink "$link")
  if [[ $current == "$target" ]]; then
    echo "  ✓ $name already points at $target"
  else
    echo "  ⚠ $name exists as a symlink to $current — leaving it alone"
    echo "    (delete it manually if you want it to point at $target instead)"
  fi
elif [[ -e $link ]]; then
  echo "  ✗ $link exists as a regular file — refusing to touch" >&2
  echo "    move or rename it before re-running" >&2
  exit 1
else
  parent=$(dirname "$link")
  [[ -d $parent ]] || mkdir -p "$parent"
  ln -s "$target" "$link"
  echo "  + $name → $target"
fi
```

## `status.sh` — probe vsync version + 0.7+ flag set

Defensive script that surfaces the upgrade instruction up front. Runs `vsync sync 2>&1` (no args → exits non-zero by design, but prints help) and greps for `--inline-file-suffix`. If absent, the install is pre-0.7 and `*:sync:gh` tasks will fail with a confusing error.

Run after a fresh install, or wire into CI to guard against accidentally checking in flag combos that need a newer vsync than developers have.

```bash
#!/usr/bin/env bash
#
# Setup-tool status: verify the binaries the infra/setup verbs depend on,
# and probe vsync for the 0.7+ flag set required by *:sync:gh tasks.
#
# Run after a fresh install, or wire into CI to guard against accidentally
# checking in flag combos that need a newer vsync than developers have.
#
# USAGE
#   infra/setup/scripts/status.sh

set -uo pipefail

tool_version() {
  local tool=$1
  case $tool in
    vsync)
      # vsync has no --version flag; report the bun-global install version.
      bun pm ls -g 2>/dev/null | grep '@muthuishere/vsync' | sed 's/.*@//' || echo "present"
      ;;
    *)
      "$tool" --version 2>&1 | head -1 || echo "present"
      ;;
  esac
}

echo "🔍 Setup-tool status:"
for tool in git vsync bun task; do
  if command -v "$tool" &>/dev/null; then
    echo "  ✅ $tool: $(tool_version "$tool")"
  else
    echo "  ❌ $tool: Not installed"
  fi
done

echo
if command -v vsync &>/dev/null; then
  # `vsync sync` with no args exits non-zero by design — capture help text
  # separately so pipefail doesn't bite the grep.
  help=$(vsync sync 2>&1 || true)
  if printf '%s' "$help" | grep -q -- '--inline-file-suffix'; then
    echo "  ✅ vsync supports the 0.7+ flag set (--inline-file-suffix / --exclude-property)"
  else
    echo "  ❌ vsync is too old — *:sync:gh tasks will fail."
    echo "     Upgrade with: bun install -g @muthuishere/vsync@latest"
  fi
fi
```
