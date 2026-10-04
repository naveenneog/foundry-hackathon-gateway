#!/usr/bin/env bash
# Launcher for macOS and Linux. Not a port: admin.ps1 is cross-platform (ADR-0010), so this only
# checks the three prerequisites and hands over. Keeping it this thin is the point - there is no
# second implementation to drift.
set -euo pipefail

missing=0

need() {
  local cmd="$1" name="$2" how="$3"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf '  [x]  %s is not installed.\n       %s\n' "$name" "$how"
    missing=1
  fi
}

# $OSTYPE is a bash builtin, so this still works when PATH is broken - which is exactly when an
# operator most needs the install guidance below. Everything above the handover uses builtins
# only, for the same reason: an earlier version called dirname here and died before it could
# explain why.
case "${OSTYPE:-}" in
  darwin*) pwsh_how='brew install --cask powershell'
           az_how='brew install azure-cli'
           node_how='brew install node' ;;
  # Every non-macOS host, not just Debian. A distro-specific command would be wrong for most of
  # them, so these are the pages that branch by distro.
  *)       pwsh_how='https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux'
           az_how='https://learn.microsoft.com/cli/azure/install-azure-cli-linux'
           node_how='https://nodejs.org/en/download' ;;
esac

need pwsh 'PowerShell 7'   "$pwsh_how"
need az   'Azure CLI'      "$az_how"
need node 'Node.js 20+'    "$node_how"
[ "$missing" -eq 0 ] || { echo; echo 'Install the above and run this again.'; exit 1; }

# Resolve this script's directory, after the checks so it may use external commands. A launcher
# is usually put on PATH by symlinking it, and the lexical directory of the symlink is not where
# admin.ps1 lives, so follow the link where the tools to do it exist.
self="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
  while [ -L "$self" ]; do
    link="$(readlink "$self")"
    case "$link" in
      /*) self="$link" ;;
      *)  self="${self%/*}/$link" ;;
    esac
  done
fi
case "$self" in
  */*) here="$(cd "${self%/*}" && pwd -P)" ;;
  *)   here="$(pwd -P)" ;;
esac

if [ ! -f "$here/admin.ps1" ]; then
  printf '  [x]  admin.ps1 was not found next to this launcher (looked in %s).\n' "$here"
  exit 1
fi

# admin.ps1 declares #Requires -Version 7.0, so the host rejects an older pwsh before parsing.
# ${1+"$@"} rather than "$@": macOS ships bash 3.2, where `set -u` treats "$@" as unset when
# there are no arguments - and no arguments is the documented way to open the menu.
exec pwsh -NoProfile -File "$here/admin.ps1" ${1+"$@"}
