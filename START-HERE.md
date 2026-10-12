# HTML → Figma · Start here

Turn any web page or HTML file into an editable Figma design, by yourself or by asking your AI app
(Claude, ChatGPT, Cursor, VS Code and others).

**Setup takes about 5 minutes and you only do it once per computer.**

---

## 1 · Put this folder somewhere it can stay

Move the `html-to-figma` folder to a place you won't tidy away, such as **Documents**.
(If you move it later, just repeat step 3.)

## 2 · Add the plugin to Figma

1. Open the **Figma desktop app** (the browser version can't load plugins from your computer).
2. Open any design file.
3. In the menu, choose **Plugins → Development → Import plugin from manifest…**
4. Pick the file **`manifest.json`** inside this folder.

That's it. The plugin now lives under **Plugins → Development → HTML to Figma Importer**.

## 3 · Connect your AI app *(optional: skip it if you'll only use the plugin by hand)*

Double-click the installer in this folder:

- **Mac:** `Install - Mac`
  If your Mac says it can't open it, right-click it → **Open** → **Open**.
- **Windows:** `Install - Windows`
  If Windows shows a blue "protected your PC" box, click **More info → Run anyway**.

It finds the AI apps on your computer, asks once, and connects them all. Then **restart those apps**.

> The installer needs **Node.js**, a free helper program. If it isn't on your computer, the installer opens the
> download page for you. Install it with the default settings and double-click the installer again.

---

## You're done 🎉

Open the plugin in Figma (**Plugins → Development → HTML to Figma Importer**).

- **By hand:** choose an HTML file, pick Desktop / Tablet / Mobile / Canvas, click **Import**.
- **With your AI app:** when the plugin's badge says **AI connected**, just ask, for example:
  *"Turn this landing page into a Figma design for desktop and mobile."*
  Keep the plugin window open while your AI app works (you can minimise it).

**Tip:** reopen the plugin quickly with **⌥⌘P** (Mac) or **Ctrl+Alt+P** (Windows), Figma's "run last plugin".

## Something not working?

| What you see | What to do |
|---|---|
| Badge says **Waiting for AI app** | Restart your AI app (fully quit it, then reopen). If it still waits, run the installer again. |
| Badge says **Update MCP server** | You have two different versions. Run the installer from the newest folder, then restart your AI app. |
| Your AI app isn't listed by the installer | In the plugin, click **Connect AI app**, pick your app (or "Another app") and copy the settings shown. |
| "Plugins → Development" is missing | You're in the browser. Use the Figma desktop app. |
| Using a **different Figma account** | Repeat **step 2** in that account if the plugin isn't listed. Nothing else changes. |
| **New computer** | Copy this folder over and do steps 1–3 there. |
| Fonts look different | Figma uses fonts installed on your computer. Install the page's fonts, or accept the closest match it picks. |

Uninstall the AI connection any time by running, in a terminal inside this folder:
`node mcp-server/html-to-figma-mcp.mjs remove`

---
---

## For AI assistants helping someone set this up

You've been given this folder (or this file) and asked to help install it. Follow this playbook.

**How to talk:** one step at a time, plain words, no jargon unless the person uses it. Say what they'll see
before they see it. After each step, ask them to tell you what happened. Never paste the whole guide at once.

### First, find out (ask only what you can't tell)
1. **Mac or Windows?** (Figma desktop plugins aren't supported on Linux.)
2. **Is the Figma desktop app installed?** If not: figma.com/downloads.
3. **Which AI app(s) do they want to connect?** Or "none, I'll use it by hand" → skip step 3.
4. **Is this a new computer, or only a different Figma account?** A different account on the same computer
   only needs step 2. A new computer needs steps 1–3.

### Steps (same as above, with what to check)
1. **Folder in a permanent place.** Settings point to its exact location; moving it later means re-running the installer.
2. **Figma: Plugins → Development → Import plugin from manifest… → `manifest.json`.**
   Must be the desktop app with a design file open. Success = "HTML to Figma Importer" appears under Plugins → Development.
3. **Run the installer** (`Install - Mac` / `Install - Windows`). It runs
   `node mcp-server/html-to-figma-mcp.mjs setup`, which detects Claude Desktop, Claude Code, ChatGPT desktop/Codex,
   Cursor, VS Code, Windsurf and Gemini CLI, adds an `html-to-figma` server entry to each app's config (keeping
   everything else, backing up the original as `*.before-html-to-figma`) and lists what to restart.
   - macOS Gatekeeper blocks it → right-click → Open → Open.
   - Windows SmartScreen → More info → Run anyway.
   - "Needs Node.js" → install the LTS version from nodejs.org with defaults, then run the installer again.
4. **Restart the AI app completely** (Claude Desktop: quit from the menu bar/tray, not just close the window).
5. **Verify:** open the plugin in Figma → its badge turns green, **AI connected**. If *you* now have the
   `figma_bridge_status` tool, call it: it should say "Plugin: connected" and name their Figma file.

### If you can run commands on their computer
Run the installer non-interactively from the folder: `node mcp-server/html-to-figma-mcp.mjs setup --yes`
(or name apps: `… setup claude-desktop cursor`). Check with `node mcp-server/html-to-figma-mcp.mjs status`
once the AI app and the plugin are open. The Figma step (2) must still be clicked by the person, or done with
computer control if you have it and they agree.

### Manual setup (installer can't run, or an app it doesn't know)
`node mcp-server/html-to-figma-mcp.mjs config <app>` prints the exact settings; apps:
`claude-desktop, claude-code, chatgpt, cursor, vscode, windsurf, gemini, lmstudio`.
Or the plugin's **Connect AI app** button shows them with a Copy button. The entry is always:
command = full path to `node`, argument = full path to `mcp-server/html-to-figma-mcp.mjs`, transport = stdio.
Config files: Claude Desktop → Settings → Developer → Edit Config · Cursor `~/.cursor/mcp.json` ·
VS Code "MCP: Open User Configuration" (key `servers`, add `"type": "stdio"`) · Windsurf
`~/.codeium/windsurf/mcp_config.json` · Gemini CLI `~/.gemini/settings.json` · ChatGPT desktop/Codex
`~/.codex/config.toml` (`[mcp_servers.html-to-figma]`) · LM Studio: Program tab → Install → Edit mcp.json.
Browser-only chat apps can't run local tools; they need a desktop app.

### Troubleshooting map
| Symptom | Cause → fix |
|---|---|
| AI app shows the server failed / `spawn node ENOENT` | App can't find Node → re-run installer (it writes the full path to node). |
| Badge "Waiting for AI app" | AI app not restarted, or its config wasn't saved → restart; run `… status`. |
| Badge "Update MCP server" | Plugin and server from different releases → re-run the installer from the newest folder, restart the app. |
| Port 3055 busy (non-HTML-to-Figma program) | Set `HTML_TO_FIGMA_PORT` in the app's server env and the same port in plugin Options → MCP bridge port. |
| Several AI apps connected | Fine. They share one connection automatically. |
| Folder was moved | Re-run the installer. |

Version: see `CHANGELOG.md` (the plugin shows its version next to its title).
