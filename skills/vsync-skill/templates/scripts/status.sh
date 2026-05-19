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
