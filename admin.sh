#!/usr/bin/env bash
# Launcher for macOS and Linux. Not a port: admin.ps1 is cross-platform (ADR-0010), so this only
# checks the three prerequisites and hands over. Keeping it this thin is the point - there is no
# second implementation to drift.
set -euo pipefail

here="${BASH_SOURCE[0]}"
case "$here" in
  */*) here="$(cd "${here%/*}" && pwd)" ;;
  *)   here="$(pwd)" ;;
esac
missing=0

need() {
  local cmd="$1" name="$2" how="$3"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf '  [x]  %s is not installed.\n       %s\n' "$name" "$how"
    missing=1
  fi
}

# $OSTYPE is a bash builtin, so this still works when PATH is broken - which is exactly when an
# operator most needs the install guidance below.
case "${OSTYPE:-}" in
  darwin*) pwsh_how='brew install --cask powershell'
           az_how='brew install azure-cli'
           node_how='brew install node' ;;
  *)       pwsh_how='https://learn.microsoft.com/powershell/scripting/install/install-ubuntu'
           az_how='curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash'
           node_how='https://nodejs.org/en/download' ;;
esac

need pwsh 'PowerShell 7'   "$pwsh_how"
need az   'Azure CLI'      "$az_how"
need node 'Node.js 20+'    "$node_how"
[ "$missing" -eq 0 ] || { echo; echo 'Install the above and run this again.'; exit 1; }

# admin.ps1 declares #Requires -Version 7.0, so the host rejects an older pwsh before parsing.
exec pwsh -NoProfile -File "$here/admin.ps1" "$@"
