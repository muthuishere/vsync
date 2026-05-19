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
