#!/bin/bash
# Double-click me to connect HTML → Figma to the AI apps on this Mac.
cd "$(dirname "$0")" || exit 1
clear
echo "HTML → Figma installer"
echo

# Find Node.js (apps opened from Finder don't always see your shell's PATH)
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node"; do
    if [ -x "$p" ]; then NODE="$p"; break; fi
  done
fi
if [ -z "$NODE" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  NODE="$(command -v node 2>/dev/null)"
fi

if [ -z "$NODE" ]; then
  echo "One thing first: this needs Node.js, a free helper program."
  echo "Opening the download page now — choose the macOS installer, click through it,"
  echo "then double-click this file again."
  open "https://nodejs.org/en/download"
  echo
  read -n 1 -s -r -p "Press any key to close this window."
  exit 1
fi

"$NODE" "mcp-server/html-to-figma-mcp.mjs" setup "$@"
echo
read -n 1 -s -r -p "Press any key to close this window."
