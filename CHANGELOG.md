# Changelog

The version shows in the plugin window's title bar and next to "HTML → Figma" in the panel.
The plugin and the MCP server always share a version number; if they don't match, the plugin's
header pill says **Update MCP server**.

## 1.7.0 — 2026-10-13
AI apps no longer need the HTML saved on your computer.
- **Send HTML code directly.** `import_html_to_figma` takes the code in `html`, plus the images and CSS it uses in
  `files`, so an AI working in its own sandbox or a cloud workspace can import what it wrote.
- **Long pages in parts:** new `upload_file_for_import` tool sends big HTML (and its assets) piece by piece, then
  `import_html_to_figma({upload_id})` imports it, with the same result as importing the file from disk.
- If an AI passes a `path` that isn't on your computer, the error now tells it to send the code instead.

## 1.6.1 — 2026-10-12
Found in the first live test inside Figma:
- Two items pushed to opposite edges (label left, value right via `margin-left: auto`) now use
  **Space between** and fill their container, instead of a fixed gap that breaks when resized.
  A real CSS `gap` stays a gap.
- Rows with `align-items: baseline` always get Figma's **Baseline** alignment.
- **Canvas** imports drop the invisible page wrappers: the frame contains the card/poster/slide directly.

## 1.6.0 — 2026-10-12
Auto Layout overhaul, tested against a real 9-screen dashboard design.
- **No more wrapped labels.** One-line text now always hugs its content instead of being stretched to the
  browser's exact width, so it can't break onto two lines when Figma draws the font slightly wider
  (129 wrapped labels → 0 on the test file). Its container grows with it.
- **Safety net:** if Figma still wraps text the browser drew on one line, the plugin switches it to auto width.
- **Many more containers become Auto Layout.** Rows spaced with margins (e.g. `margin-left: auto`, a label
  on the left and a value on the right) are rebuilt as nested Auto Layout groups, using Space between where
  items are pushed apart (flexbox mode: 108 containers left absolute → 5).
- **Baseline alignment:** rows using `align-items: baseline` (big number + unit) use Figma's Baseline alignment.
- **Cleaner layers:** wrappers that only hold one piece of text are removed; the text sits directly in the row.
- Inline text with `opacity` stays part of its sentence (opacity becomes the text colour's transparency).
- Fixed: a message arriving while the plugin window was still loading could be lost (e.g. saved settings).

## 1.5.0 — 2026-10-12
- **Works with any MCP-capable AI app**, not just Claude: ChatGPT desktop/Codex, Cursor, VS Code, Windsurf,
  Gemini CLI, LM Studio and others.
- **One-click setup:** `Install - Mac` / `Install - Windows` find your AI apps and connect them
  (`setup`, `remove`, `config <app>`, `status` commands for the terminal).
- **Connect AI app** panel in the plugin with copy-ready settings for each app.
- Several AI apps can use the plugin at the same time; if one quits, another takes over.
- **START-HERE.md**: a 3-step guide for people, plus a playbook for AI assistants helping with setup.
- Claude skill `html-to-figma-setup` so Claude can guide installation on a new computer or account.

## 1.4.0 — 2026-10-12
- Version number shown in the plugin title bar, panel header and import notifications.
- Plugin and MCP server check each other's version and warn when they differ.

## 1.3.0 — 2026-10-12
- MCP server (`mcp-server/html-to-figma-mcp.mjs`, no dependencies) so Claude can import HTML into Figma:
  tools `import_html_to_figma` and `figma_bridge_status`, with PNG previews of the result.
- Page capture now runs inside the rendered page, so it works however Figma sandboxes the plugin window.

## 1.2.0 — 2026-10-12
- Import as Desktop, Tablet, Mobile or Canvas (frame sized to the content); several at once.
- Editable screen sizes, "Crop to one screen", settings remembered between runs.

## 1.1.0 — 2026-10-12
- Flexbox and grid containers become Auto Layout (direction, gap, padding, alignment, wrap, fill/hug,
  absolute children), verified against the rendered layout before being applied.

## 1.0.0 — 2026-10-12
- First release: import an HTML file, folder or pasted HTML as frames, text, images and vectors.
