# HTML → Figma Importer

> New here? Open **START-HERE.md**: three steps, about five minutes.

A Figma plugin that imports an HTML file as editable design layers: frames, text, images and vectors.

## Install (development plugin)

1. Unzip this folder somewhere permanent.
2. Open the **Figma desktop app** (development plugins can't be imported in the browser).
3. Menu → **Plugins → Development → Import plugin from manifest…** and pick `manifest.json`.
4. Run it from **Plugins → Development → HTML to Figma Importer**.

## Use

- **File** – pick an `.html` file. Select its images/CSS at the same time (multi-select) so relative paths resolve.
- **Folder** – pick a whole site folder; links like `img/hero.jpg`, `css/style.css` and `/fonts/x.woff2` are resolved and inlined. If it contains several pages, choose one.
- **Paste** – paste raw HTML.
- **Import as** – pick one or more; each becomes its own frame, side by side:
  - *Desktop* (1440×900), *Tablet* (768×1024), *Mobile* (390×844) – the page is laid out at that screen width
    (and height, for `vh` units). Frames are full page height unless *Crop to one screen* is on.
  - *Canvas* – the frame is sized to what the page actually paints. A centred 1080×1350 poster comes in as a
    1080×1350 frame without the page around it; designs wider than the screen (e.g. a 1920px slide) are widened to fit.
    Fluid pages that fill the window fall back to the desktop width at full height.
  - Screen sizes are editable under **Options → Screen sizes**. Your choices are remembered between runs.
- **Auto Layout**
  - *Flexbox & grid containers* (default) – `display: flex` / `grid` become Auto Layout frames.
  - *Flexbox, grid & stacked blocks* – also converts ordinary block containers whose children stack vertically.
  - *Off* – everything absolutely positioned, exactly as rendered.
- **Options**
  - *Run JavaScript* – needed for pages that build themselves (Tailwind Play CDN, React bundles…).
  - *Remove empty wrappers* – divs with no fill/border/clip are dissolved so the layer tree stays lean.
  - *Freeze animations* – disables CSS animations/transitions so elements are captured at rest.
  - *Text layers* – one editable layer per paragraph, or one per line for pixel-exact wrapping.
  - *Crop to one screen* – Desktop/Tablet/Mobile frames get the screen height; content below is clipped (still there, just hidden).
  - *Wait after load* – extra time for scripts or web fonts.
  - *Base URL* – resolves relative links against a website when you have just the HTML.

## Use from an AI app (MCP)

The `mcp-server/` folder lets AI apps import HTML into Figma for you: Claude (Desktop & Code), ChatGPT desktop /
Codex, Cursor, VS Code (Copilot), Windsurf, Gemini CLI, LM Studio, or any app that supports local MCP servers.
Ask things like *"turn this landing page into a Figma design, desktop and mobile"* or *"design an Instagram post
and put it in Figma"*.

```
AI app ──MCP (stdio)──▶ html-to-figma-mcp.mjs ──ws://localhost:3055──▶ plugin open in Figma desktop
```

**Connect:** double-click **`Install - Mac`** or **`Install - Windows`** in this folder. It finds your AI apps and
connects them (see **START-HERE.md** for the 3-step walkthrough). For an app it doesn't know, click
**Connect AI app** in the plugin and copy the settings shown. From a terminal:

```bash
node mcp-server/html-to-figma-mcp.mjs setup          # connect detected apps (asks first; --yes to skip)
node mcp-server/html-to-figma-mcp.mjs config cursor  # print settings for one app
node mcp-server/html-to-figma-mcp.mjs status         # is the plugin connected right now?
node mcp-server/html-to-figma-mcp.mjs remove         # disconnect again
```

Requires Node.js 18+, with no `npm install` needed (the server has no dependencies). Keep the plugin window open in
Figma while the AI works; the header badge says **AI connected** when ready.

| Tool | What it does |
|---|---|
| `import_html_to_figma` | Imports from a local file `path` (its images/CSS/fonts are bundled automatically), an `html` string, or a `url`. Accepts `devices` (desktop / tablet / mobile / canvas), `auto_layout`, `crop_to_screen`, `screen_sizes`, `text_layers`, `run_scripts`, `wait_ms` and more. Returns frame names, node IDs, sizes and PNG previews, so the AI can check the result. |
| `figma_bridge_status` | Says whether the plugin is connected and which Figma file/page imports will land in. |

Notes:
- **Several AI apps at once** work: the first one to start hosts the connection and the others share it. If it
  quits, another takes over automatically.
- The bridge listens on 127.0.0.1 only and refuses web pages; only the plugin and local AI apps can connect.
- Turn AI access off any time with **Options → Let AI apps import (MCP)**.
- Different port: set `HTML_TO_FIGMA_PORT` in the server's environment and the same port under **Options → MCP bridge port**.
- Large pages: raise the time limit with `HTML_TO_FIGMA_TIMEOUT_MS` (default 180000).
- `claude-skill/html-to-figma-setup/SKILL.md` is a Claude skill that teaches Claude to guide setup on a new
  computer or account.

## How it works

`ui.html` renders the page in a hidden iframe at your chosen size with a small extractor script injected
into it. The extractor walks the DOM, reads each element's real layout box and computed style, and sends a
plain JSON layer tree back; `code.js` then creates the Figma nodes. (The page itself never gets access to the plugin.)

| HTML / CSS | Figma |
|---|---|
| Elements with background, border, shadow, radius, clipping | Frames (fills, per-side strokes, corner radii, effects, clip content) |
| `linear-` / `radial-` / `conic-gradient`, `url()` backgrounds | Gradient and image fills |
| Text, incl. bold/italic/links/`<mark>` inside a paragraph | One text layer with mixed styles, letter spacing, line height, text case, decoration, hyperlinks |
| Gradient text (`background-clip: text`) | Gradient text fill |
| `<img>` (PNG/JPG/GIF/WebP/AVIF), `<video poster>`, `<canvas>` | Image fills (other formats are converted to PNG) |
| Inline `<svg>`, `<img src="*.svg">`, icon sprites (`<use href="#id">`) | Vector layers, with `currentColor` and CSS-styled fills/strokes baked in |
| Inputs, selects, textareas, checkboxes, radios, ranges | Styled boxes with value/placeholder text and drawn controls |
| `box-shadow`, `filter: blur()`, `backdrop-filter: blur()` | Drop/inner shadows, layer blur, background blur |
| `z-index` / positioned elements | Layer order follows CSS painting order |
| `oklch()`, `lab()`, `color-mix()` etc. | Converted to sRGB |

### Auto Layout

For every flex/grid (or stacked block) container, the importer works out the Figma settings from the
measured layout, not just from the CSS:

- **Direction, gap, padding** (CSS padding + border), **alignment** on both axes, including *space between*.
- **Wrap** – `flex-wrap` rows and multi-row grids become wrapping Auto Layout with row and column gaps.
- **Fill container** for `flex-grow` items and stretched items; **Hug contents** where the container is exactly as big as its content.
- `position: absolute` children become absolutely positioned items inside the Auto Layout frame.
- Items are ordered visually, so `order` and `*-reverse` directions come out right.

Each container is converted only if a simulation of Figma's layout puts every child back within 2px of where
the browser drew it. Anything that can't be expressed (uneven margins between items, mixed per-item
alignment) stays absolutely positioned, so the import never shifts. The final status line says how many
frames got Auto Layout.

Try it on `example/dashboard.html` (pick the `example` folder and choose that page).

### Fonts

Fonts are matched to what's installed in Figma (closest weight/italic). Generic stacks map to sensible
defaults (`system-ui` → SF Pro / Inter, `monospace` → Roboto Mono…). Substitutions are listed when the import finishes.

## Limitations

- Auto Layout text sizes are recomputed by Figma, so where Figma's font is wider, hugging frames grow slightly (text never wraps because of it).
- Containers whose content overflows (scrolling panels) and items positioned with mixed per-item alignment stay absolutely positioned.
- `::before` / `::after` content and list bullets are approximated or skipped (browsers don't expose their geometry).
- Rotated/skewed elements are imported as their bounding box.
- Remote images load only if the server allows cross-origin requests; otherwise a grey placeholder named
  "(image unavailable)" is used.
- Content that appears on scroll via JavaScript (scroll-reveal libraries) is captured in its hidden state.

## Developing & releasing updates

```
manifest.json, code.js, ui.html   the Figma plugin (no build step)
mcp-server/                       MCP server for AI apps (no dependencies)
tests/                            test suite + test pages
scripts/build-release.sh          builds the installable zip into dist/
```

1. Make the change. To try it, re-import `manifest.json` in Figma (or just reopen the plugin; Figma reloads the files).
2. Run the tests: `python3 tests/run_tests.py` (needs Node 18+, Python 3, `pip install playwright pillow && playwright install chromium`).
   They also run automatically on GitHub for every push.
3. Bump the version in **both** `code.js` (`PLUGIN_VERSION`) and `mcp-server/html-to-figma-mcp.mjs` (`VERSION`),
   and add a `## x.y.z — date` entry to `CHANGELOG.md`.
4. Commit and push. Then on GitHub: **Releases → Draft a new release**, create the tag (e.g. `v1.6.2`), paste the
   changelog entry as notes, **Publish**. GitHub builds the installable zip and attaches it to the release within a
   minute or two (it refuses if the tag doesn't match the version in `code.js`). Users update by downloading that zip
   and unzipping it over their folder.
