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
