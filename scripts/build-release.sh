#!/bin/bash
# Build the installable zip (plugin + MCP server + docs + examples, no tests) into dist/.
set -e
cd "$(dirname "$0")/.."
VERSION=$(sed -n "s/^const PLUGIN_VERSION = '\([0-9.]*\)'.*/\1/p" code.js)
SERVER=$(sed -n "s/^const VERSION = '\([0-9.]*\)'.*/\1/p" mcp-server/html-to-figma-mcp.mjs)
if [ "$VERSION" != "$SERVER" ]; then echo "Version mismatch: plugin $VERSION, MCP server $SERVER"; exit 1; fi
grep -q "## $VERSION " CHANGELOG.md || { echo "CHANGELOG.md has no entry for $VERSION"; exit 1; }
rm -rf dist && mkdir -p dist/html-to-figma
cp -r manifest.json code.js ui.html mcp-server example claude-skill README.md START-HERE.md CHANGELOG.md \
  "Install - Mac.command" "Install - Windows.cmd" dist/html-to-figma/
chmod +x "dist/html-to-figma/Install - Mac.command"
(cd dist && zip -qrX "html-to-figma-v$VERSION.zip" html-to-figma)
echo "dist/html-to-figma-v$VERSION.zip"
