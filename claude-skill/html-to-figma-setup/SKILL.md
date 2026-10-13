---
name: html-to-figma-setup
description: Guide someone through installing the HTML to Figma Importer plugin and connecting it to Claude or another AI app on a new computer or Figma account, one simple step at a time.
---

# Setting up HTML → Figma

The HTML to Figma Importer is a Figma desktop plugin (folder `html-to-figma`, usually shared as
`html-to-figma.zip`) that turns HTML into editable Figma layers. Its MCP server lets AI apps send HTML to it.
Use this skill when someone wants to install it, move it to another computer, use it with another Figma
account, or connect an AI app to it.

## How to guide

- One step per message. Plain words. Tell them what they'll see, then ask them to say what happened.
- Never dump all steps at once, and don't explain how it works unless asked.
- Celebrate the finish, and give them one example prompt to try.

## 0 · Work out what's needed (ask only what you can't infer)

| Situation | Steps needed |
|---|---|
| Different Figma account, same computer | Step 2 only |
| New computer | Steps 1, 2, 3 |
| Only connecting another AI app | Step 3 only |
| Will only use the plugin by hand | Steps 1–2 |

Also confirm: **Mac or Windows** (no Linux; Figma desktop plugins need macOS or Windows), and that the **Figma
desktop app** is installed (figma.com/downloads). The browser version of Figma can't load local plugins.

They need the `html-to-figma` folder or zip. If they don't have it, ask them to copy it from their other
computer, cloud drive or email. You can't download it for them.

## 1 · Folder in a permanent place

Unzip if needed, and move the `html-to-figma` folder somewhere it can stay (Documents is good).
Settings will point at this location; moving it later just means running the installer again.

## 2 · Add the plugin to Figma

Figma desktop → open any design file → menu **Plugins → Development → Import plugin from manifest…** →
choose **`manifest.json`** in the folder.
✅ Success: **HTML to Figma Importer** appears under Plugins → Development.

## 3 · Connect the AI app

Double-click **`Install - Mac`** or **`Install - Windows`** in the folder. It finds AI apps (Claude Desktop,
Claude Code, ChatGPT desktop/Codex, Cursor, VS Code, Windsurf, Gemini CLI), asks once, and connects them.
Then they restart those apps. **Claude Desktop must be fully quit**, from the menu bar or tray, not just the window closed.

- Mac says it can't open it → right-click → **Open** → **Open**.
- Windows "protected your PC" → **More info → Run anyway**.
- "Needs Node.js" → it opens nodejs.org; install the LTS version with default settings, then double-click again.
- App not found / not listed → in the Figma plugin click **Connect AI app**, choose the app, **Copy**, and paste
  where it says.

## 4 · Check it worked

Open the plugin in Figma. The badge at the top right turns green: **AI connected**.
If you have the `figma_bridge_status` tool in this conversation, call it. It should report "Plugin: connected" and
their file name. Then suggest a first prompt, e.g. *"Turn this page into a Figma design for desktop and mobile."*
Remind them: keep the plugin window open while the AI works; **⌥⌘P / Ctrl+Alt+P** reopens it quickly.

## If you can act on their computer

With a shell on their machine, run from the folder: `node mcp-server/html-to-figma-mcp.mjs setup --yes`
(or name apps, e.g. `setup claude-desktop cursor`), then `node mcp-server/html-to-figma-mcp.mjs status`.
Use `config <app>` to print settings for a manual paste. Step 2 is a Figma click-through: the person does it, or
you do it with computer control if they agree.

## Fixes

| Symptom | Fix |
|---|---|
| Badge stays **Waiting for AI app** | Fully restart the AI app; if still waiting, run the installer again. |
| Badge says **Update MCP server** | Plugin and server are from different releases → run the installer from the newest folder, restart the app. |
| `spawn node ENOENT` / server failed to start | Run the installer again (it writes the full path to Node). |
| Plugins → Development missing | They're in browser Figma → use the desktop app. |
| Folder moved | Run the installer again. |
| `File not found on the user's computer` when importing | The HTML is in your sandbox, not on their PC → send the code with `html` (+ `files`), or `upload_file_for_import` in parts for long pages. |
| Port 3055 used by another program | Set env `HTML_TO_FIGMA_PORT` for the server and the same port in plugin Options → MCP bridge port. |
| Remove it | `node mcp-server/html-to-figma-mcp.mjs remove`; in Figma, Plugins → Development → Manage plugins in development → remove it. |

Full details are in `START-HERE.md` in the folder.
