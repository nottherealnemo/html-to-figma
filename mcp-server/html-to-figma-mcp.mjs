#!/usr/bin/env node
// HTML → Figma MCP server (zero dependencies, Node 18+).
//
// Any MCP-capable AI app (Claude, ChatGPT desktop, Cursor, VS Code, Windsurf, Gemini CLI…) talks to this
// process over stdio. The Figma plugin "HTML to Figma Importer" connects to it over a WebSocket on
// localhost. Tool calls are forwarded to the plugin, which renders the HTML and builds the Figma layers.
//
//   AI app ──stdio/MCP──▶ this server ──ws://127.0.0.1:3055──▶ Figma plugin (open in Figma desktop)
//
// Several AI apps can be connected at once: the first server to start owns the port ("hub"); the
// others connect to it and pass their requests through ("relay"). If the hub exits, a relay takes over.
//
// Commands (run from a terminal; the installers in the plugin folder do this for you):
//   node html-to-figma-mcp.mjs setup [--yes] [app…]   connect AI apps found on this computer
//   node html-to-figma-mcp.mjs remove                 disconnect them again
//   node html-to-figma-mcp.mjs config <app>           print the settings to paste by hand
//   node html-to-figma-mcp.mjs status                 is the plugin connected right now?
//   (no command)                                      run as an MCP server — what AI apps do
//
// Environment:
//   HTML_TO_FIGMA_PORT         WebSocket port shared with the plugin (default 3055)
//   HTML_TO_FIGMA_TIMEOUT_MS   max time per import (default 180000)

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.7.0'; // keep in step with PLUGIN_VERSION in code.js
const PORT = parseInt(process.env.HTML_TO_FIGMA_PORT || '3055', 10);
const TIMEOUT_MS = parseInt(process.env.HTML_TO_FIGMA_TIMEOUT_MS || '180000', 10);
const MAX_ASSET_BYTES = 60 * 1024 * 1024;
const SERVER_PATH = fileURLToPath(import.meta.url);
const SERVER_NAME = 'html-to-figma';

const log = (...a) => process.stderr.write('[html-to-figma] ' + a.join(' ') + '\n');

/* ================================================================== */
/* Minimal WebSocket (RFC 6455): server side for the plugin & relays,  */
/* client side for relays                                               */
/* ================================================================== */

class Socket {
  constructor(sock, onMessage, onClose, { client = false } = {}) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.frags = []; this.closed = false; this.client = client;
    this.onMessage = onMessage; this.onClose = onClose;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('close', () => this.finish());
    sock.on('error', () => this.finish());
  }
  finish() { if (!this.closed) { this.closed = true; this.onClose(this); } }
  parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(need);
      if (op === 0x8) { this.send(Buffer.alloc(0), 0x8); this.sock.end(); this.finish(); return; }
      if (op === 0x9) { this.send(payload, 0xa); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frags.push(payload);
        if (fin) { const msg = Buffer.concat(this.frags).toString('utf8'); this.frags = []; this.onMessage(this, msg); }
      }
    }
  }
  send(data, op = 0x1) {
    if (this.closed) return;
    let payload = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | op;
    if (this.client) { // clients must mask what they send
      head[1] |= 0x80;
      const mask = crypto.randomBytes(4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      head = Buffer.concat([head, mask]);
    }
    this.sock.write(Buffer.concat([head, payload]));
  }
  close() { try { this.send(Buffer.alloc(0), 0x8); this.sock.end(); } catch (e) { /* ignore */ } }
}

function wsConnect(port, onMessage, onClose) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port, path: '/',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (res, sock) => {
      const want = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.headers['sec-websocket-accept'] !== want) { sock.destroy(); reject(new Error('bad handshake')); return; }
      resolve(new Socket(sock, onMessage, onClose, { client: true }));
    });
    req.on('response', () => reject(new Error(`Port ${port} is used by another program, not the HTML to Figma bridge.`)));
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

/* ================================================================== */
/* Bridge                                                               */
/*  hub:   owns the port; the plugin and any relays connect to it       */
/*  relay: another AI app's server; forwards its calls through the hub */
/* ================================================================== */

const bridge = {
  role: 'starting',      // 'hub' | 'relay' | 'starting'
  server: null,
  plugin: null,          // hub: { socket, info }
  relays: new Set(),     // hub: relay sockets
  hub: null,             // relay: socket to the hub
  pending: new Map(),    // id -> { resolve, reject, timer, onProgress }
  problem: null,
  seq: 0,
};

const settle = (id, ok, value) => {
  const p = bridge.pending.get(id);
  if (!p) return;
  clearTimeout(p.timer); bridge.pending.delete(id);
  if (ok) p.resolve(value); else p.reject(value instanceof Error ? value : new Error(value || 'Import failed in Figma'));
};

function failAllPending(message) {
  for (const id of [...bridge.pending.keys()]) settle(id, false, new Error(message));
}

/* ----- hub side ----- */

function hubMessage(socket, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  if (msg.type === 'hello') { // the Figma plugin
    if (bridge.plugin && bridge.plugin.socket !== socket) bridge.plugin.socket.close();
    bridge.plugin = { socket, info: msg.info || {} };
    socket.send({ type: 'welcome', version: VERSION, serverPath: SERVER_PATH, nodePath: process.execPath });
    log('plugin connected:', JSON.stringify(msg.info || {}));
    return;
  }
  if (msg.type === 'hello-relay') { bridge.relays.add(socket); socket.isRelay = true; socket.send({ type: 'welcome-relay', version: VERSION }); return; }
  if (msg.type === 'info' && bridge.plugin && bridge.plugin.socket === socket) { bridge.plugin.info = msg.info || {}; return; }

  // Requests passed through from relays
  if (socket.isRelay && msg.type === 'relay-status') {
    socket.send({ type: 'relay-status-result', id: msg.id, plugin: bridge.plugin ? bridge.plugin.info : null, hubVersion: VERSION });
    return;
  }
  if (socket.isRelay && msg.type === 'relay-call') {
    callPluginDirect(msg.call.type, msg.call.payload, (m) => socket.send({ type: 'relay-progress', id: msg.id, message: m }))
      .then((result) => socket.send({ type: 'relay-result', id: msg.id, ok: true, result }))
      .catch((err) => socket.send({ type: 'relay-result', id: msg.id, ok: false, error: err.message }));
    return;
  }

  // Replies from the plugin
  const p = bridge.pending.get(msg.id);
  if (!p) return;
  if (msg.type === 'progress') { p.onProgress && p.onProgress(msg.message); return; }
  if (msg.type === 'result') settle(msg.id, msg.ok, msg.ok ? msg.result : (msg.error || 'Import failed in Figma'));
}

function hubClose(socket) {
  if (socket.isRelay) { bridge.relays.delete(socket); return; }
  if (bridge.plugin && bridge.plugin.socket === socket) {
    bridge.plugin = null;
    log('plugin disconnected');
    failAllPending('The Figma plugin disconnected before the import finished (was the plugin window closed?).');
  }
}

function createServer() {
  const server = http.createServer((req, res) => {
    // Small status endpoint: http://localhost:3055/
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'html-to-figma-bridge', version: VERSION, pluginConnected: !!bridge.plugin, plugin: bridge.plugin && bridge.plugin.info, relays: bridge.relays.size }));
  });
  server.on('upgrade', (req, sock) => {
    // The plugin's UI runs in a sandboxed iframe ("null" origin); relays are local Node processes (no origin).
    // Web pages always carry a real origin and are refused, so websites can't talk to the bridge.
    const origin = req.headers.origin;
    const key = req.headers['sec-websocket-key'];
    if (!key || (origin && origin !== 'null' && !/^https:\/\/([a-z0-9-]+\.)*figma\.com$/.test(origin))) {
      sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.setNoDelay(true);
    new Socket(sock, hubMessage, hubClose);
  });
  return server;
}

/* ----- relay side ----- */

function relayMessage(socket, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  const p = bridge.pending.get(msg.id);
  if (!p) return;
  if (msg.type === 'relay-progress') { p.onProgress && p.onProgress(msg.message); return; }
  if (msg.type === 'relay-result') settle(msg.id, msg.ok, msg.ok ? msg.result : msg.error);
  if (msg.type === 'relay-status-result') settle(msg.id, true, msg);
}

function relayClose() {
  if (bridge.role !== 'relay') return;
  bridge.hub = null; bridge.role = 'starting';
  failAllPending('The connection to Figma was interrupted (another AI app that was hosting it closed). Please try again.');
  setTimeout(startBridge, 300 + Math.random() * 700); // become the hub, or join the new one
}

/* ----- start: be the hub, or join the existing one ----- */

function startBridge() {
  if (bridge.role === 'hub' || bridge.role === 'relay') return;
  const server = createServer();
  server.once('error', async (err) => {
    if (err.code !== 'EADDRINUSE') { bridge.problem = `Bridge error: ${err.message}`; log(bridge.problem); setTimeout(startBridge, 5000); return; }
    try {
      bridge.hub = await wsConnect(PORT, relayMessage, relayClose);
      bridge.role = 'relay'; bridge.problem = null;
      bridge.hub.send({ type: 'hello-relay', version: VERSION });
      log(`another AI app already hosts the bridge on port ${PORT}; sharing it`);
    } catch (e) {
      bridge.problem = `Port ${PORT} is busy (${e.message}). Close the program using it, or set HTML_TO_FIGMA_PORT to another port here and in the plugin's Options.`;
      log(bridge.problem);
      setTimeout(startBridge, 5000);
    }
  });
  server.once('listening', () => { bridge.role = 'hub'; bridge.server = server; bridge.problem = null; log(`bridge listening on ws://127.0.0.1:${PORT}`); });
  server.listen(PORT, '127.0.0.1');
}

/* ----- calls ----- */

function newCall(onProgress) {
  const id = 'r' + process.pid + '-' + (++bridge.seq);
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(id, false, new Error(
      `Timed out after ${Math.round(TIMEOUT_MS / 1000)}s waiting for Figma. Very large pages may need a longer HTML_TO_FIGMA_TIMEOUT_MS.`)), TIMEOUT_MS);
    bridge.pending.set(id, { resolve, reject, timer, onProgress });
  });
  return { id, promise };
}

function callPluginDirect(type, payload, onProgress) {
  if (!bridge.plugin) return Promise.reject(new Error(notConnectedText()));
  const { id, promise } = newCall(onProgress);
  bridge.plugin.socket.send({ id, type, payload });
  return promise;
}

function callPlugin(type, payload, onProgress) {
  if (bridge.role === 'hub') return callPluginDirect(type, payload, onProgress);
  if (bridge.role === 'relay' && bridge.hub) {
    const { id, promise } = newCall(onProgress);
    bridge.hub.send({ type: 'relay-call', id, call: { type, payload } });
    return promise;
  }
  return Promise.reject(new Error(bridge.problem || 'The Figma bridge is still starting. Try again in a moment.'));
}

async function pluginStatus() {
  if (bridge.role === 'hub') return { plugin: bridge.plugin ? bridge.plugin.info : null };
  if (bridge.role === 'relay' && bridge.hub) {
    const { id, promise } = newCall(null);
    bridge.hub.send({ type: 'relay-status', id });
    try { return await Promise.race([promise, new Promise((r) => setTimeout(() => r({ plugin: null, slow: true }), 3000))]); }
    finally { if (bridge.pending.has(id)) settle(id, true, null); }
  }
  return { plugin: null };
}

async function waitForPlugin(ms) {
  const t0 = Date.now();
  for (;;) {
    const st = await pluginStatus();
    if (st && st.plugin) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

function notConnectedText() {
  if (bridge.role === 'starting' && bridge.problem) return bridge.problem;
  return 'The Figma plugin is not connected. Ask the user to open the Figma desktop app, run Plugins → Development → ' +
    '"HTML to Figma Importer", and keep the plugin window open (it can be minimised). The plugin connects automatically ' +
    `to ws://localhost:${PORT}; its header shows "AI connected" when ready. If the plugin isn't installed yet, the ` +
    'START-HERE.md file in the plugin folder explains setup in three steps.';
}

/* ================================================================== */
/* Local files: bundle an HTML file with the assets it references       */
/* ================================================================== */

const REF_PATTERNS = [
  /\s(?:src|href|poster|data|xlink:href)\s*=\s*["']([^"'#][^"']*)["']/gi,
  /url\(\s*["']?([^"')]+?)["']?\s*\)/gi,
  /@import\s+["']([^"']+)["']/gi,
];
const isExternal = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u.trim());

function collectFiles(entry) {
  const root = path.dirname(entry);
  const found = new Map(); // absolute path -> true
  let total = 0;
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (found.has(file)) continue;
    let stat;
    try { stat = fs.statSync(file); } catch (e) { continue; }
    if (!stat.isFile()) continue;
    if (total + stat.size > MAX_ASSET_BYTES) { log('asset limit reached, skipping', file); continue; }
    total += stat.size; found.set(file, true);
    if (!/\.(html?|css|svg)$/i.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const refs = new Set();
    for (const re of REF_PATTERNS) { re.lastIndex = 0; let m; while ((m = re.exec(text))) refs.add(m[1]); }
    for (const m of text.matchAll(/\ssrcset\s*=\s*["']([^"']+)["']/gi)) {
      for (const part of m[1].split(',')) refs.add(part.trim().split(/\s+/)[0]);
    }
    for (let ref of refs) {
      if (!ref || isExternal(ref)) continue;
      ref = ref.replace(/[?#].*$/, '');
      try { ref = decodeURIComponent(ref); } catch (e) { /* keep raw */ }
      const abs = ref.startsWith('/') ? path.join(root, ref) : path.resolve(path.dirname(file), ref);
      if (!found.has(abs)) queue.push(abs);
    }
  }
  // Key files relative to their common ancestor so ../ references still resolve in the plugin.
  let base = root;
  for (const f of found.keys()) while (!f.startsWith(base + path.sep) && base !== path.dirname(base)) base = path.dirname(base);
  const files = {};
  for (const f of found.keys()) files[path.relative(base, f).split(path.sep).join('/')] = fs.readFileSync(f).toString('base64');
  return { files, entry: path.relative(base, entry).split(path.sep).join('/'), count: found.size, bytes: total };
}

/* ================================================================== */
/* MCP tools                                                           */
/* ================================================================== */

const DEVICE_ENUM = ['desktop', 'tablet', 'mobile', 'canvas'];
const sizePair = { type: 'array', items: { type: 'integer', minimum: 100, maximum: 8000 }, minItems: 2, maxItems: 2 };

const TOOLS = [
  {
    name: 'import_html_to_figma',
    title: 'Import HTML into Figma',
    description:
      'Render an HTML page and rebuild it as editable Figma layers (frames, text, images, vectors, Auto Layout) in the ' +
      'Figma file the user has open. Use this when the user wants a web page, HTML mockup, email template, or HTML you ' +
      'generated turned into a Figma design. Provide exactly one source: `html` (the HTML code itself as a string, ' +
      'optionally with `files` for images/CSS it references by relative path), `upload_id` (HTML sent in parts with ' +
      'upload_file_for_import; use this when the code is too long for one call, roughly over 40 KB), `path` (an ' +
      'absolute path to an .html file ON THE USER\'S COMPUTER, where Figma runs; its images, CSS and fonts are included ' +
      'automatically), or `url` (an http(s) page). If the HTML is in your own workspace or sandbox rather than on the ' +
      'user\'s computer, `path` will not find it: send the code with `html` or upload_file_for_import instead. Choose `devices` for the frames to create: desktop/tablet/mobile lay the page out at ' +
      'that screen size; canvas sizes the frame to the content itself (best for posters, cards, slides, social images). ' +
      'Requires the "HTML to Figma Importer" plugin to be open in Figma desktop; call figma_bridge_status first if unsure. ' +
      'Returns the created frame names, node IDs and sizes, plus PNG previews of the result.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The HTML code to import (a complete document or a fragment). CSS can be inline; images can be data: URIs, absolute URLs, or relative paths supplied in `files`.' },
        files: {
          type: 'object', additionalProperties: { type: 'string' },
          description: 'Only with `html`: extra files the HTML references by relative path, e.g. {"style.css": "body{…}", "img/logo.png": "data:image/png;base64,…"}. Text files as plain text; binary files as data: URIs.',
        },
        upload_id: { type: 'string', description: 'Import files sent earlier with upload_file_for_import.' },
        entry: { type: 'string', description: 'With `upload_id`: which uploaded .html file to import. Default index.html, or the only HTML file.' },
        path: { type: 'string', description: 'Absolute path to an .html/.htm file on the user\'s computer (the one running Figma). Not for files in your own sandbox.' },
        url: { type: 'string', description: 'An http(s) URL to fetch and import. Relative assets load from that site.' },
        devices: { type: 'array', items: { type: 'string', enum: DEVICE_ENUM }, minItems: 1, uniqueItems: true, description: 'Frames to create, one per device. Default ["desktop"].' },
        auto_layout: { type: 'string', enum: ['flex', 'all', 'off'], description: 'flex (default): flexbox & grid containers become Auto Layout. all: also stacked block containers. off: absolute positions only.' },
        crop_to_screen: { type: 'boolean', description: 'Desktop/tablet/mobile frames use the screen height instead of the full page height. Default false.' },
        screen_sizes: {
          type: 'object', description: 'Override screen sizes as [width, height]. Defaults: desktop [1440,900], tablet [768,1024], mobile [390,844].',
          properties: { desktop: sizePair, tablet: sizePair, mobile: sizePair }, additionalProperties: false,
        },
        text_layers: { type: 'string', enum: ['paragraph', 'lines'], description: 'paragraph (default): one editable text layer per paragraph. lines: one per rendered line, pixel-exact.' },
        run_scripts: { type: 'boolean', description: 'Run the page JavaScript before capturing (needed for Tailwind CDN, React, etc.). Default true.' },
        remove_empty_wrappers: { type: 'boolean', description: 'Dissolve wrapper divs that paint nothing. Default true.' },
        freeze_animations: { type: 'boolean', description: 'Disable CSS animations/transitions so elements are captured at rest. Default true.' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 30000, description: 'Extra wait after load for scripts/fonts. Default 400.' },
        base_url: { type: 'string', description: 'Resolve relative URLs in `html` against this URL.' },
        name: { type: 'string', description: 'Name for the frames when the page has no <title>.' },
        preview: { type: 'boolean', description: 'Return PNG previews of the created frames. Default true.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Import HTML into Figma', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'upload_file_for_import',
    title: 'Upload HTML (or an asset) for import',
    description:
      'Send HTML code, or an image/CSS/font file it uses, to the Figma bridge in one or more parts, then import it with ' +
      'import_html_to_figma({upload_id}). Use this when the HTML is too long to pass in a single call (roughly over 40 KB) ' +
      'or comes with separate asset files. Send long files in consecutive parts of up to ~40 KB with `append: true` on ' +
      'every part after the first. The first call returns an upload_id; pass it to every later call. ' +
      'Text files as plain text; binary files (images, fonts) with encoding "base64" or as a data: URI.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The file content, or the next part of it.' },
        file_name: { type: 'string', description: 'Relative name as the HTML refers to it, e.g. "index.html", "css/site.css", "img/hero.jpg". Default "index.html".' },
        encoding: { type: 'string', enum: ['text', 'base64'], description: 'text (default) or base64 for binary files. data: URIs are decoded automatically.' },
        append: { type: 'boolean', description: 'Add this part to the end of the file instead of replacing it. Default false.' },
        upload_id: { type: 'string', description: 'The upload to add to (returned by the first call). Omit to start a new upload.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    annotations: { title: 'Upload HTML for import', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'figma_bridge_status',
    title: 'Figma plugin connection status',
    description: 'Check whether the "HTML to Figma Importer" plugin is open and connected, and which Figma file and page imports will land in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Figma plugin connection status', readOnlyHint: true, openWorldHint: false },
  },
];

class ToolError extends Error {}

async function toolStatus() {
  const lines = [];
  if (bridge.role === 'hub') lines.push(`Bridge: running on ws://127.0.0.1:${PORT} (server v${VERSION})`);
  else if (bridge.role === 'relay') lines.push(`Bridge: shared with another AI app on port ${PORT} (server v${VERSION})`);
  else lines.push('Bridge: NOT running. ' + (bridge.problem || 'Starting…'));
  const st = await pluginStatus();
  const i = st && st.plugin;
  if (i) {
    lines.push(`Plugin: connected (plugin v${i.version || '?'})`);
    if (i.version && i.version.split('.').slice(0, 2).join('.') !== VERSION.split('.').slice(0, 2).join('.')) {
      lines.push('Warning: the plugin and this MCP server are different versions. Ask the user to install both from the same release (see START-HERE.md).');
    }
    if (i.fileName) lines.push(`Figma file: ${i.fileName}`);
    if (i.page) lines.push(`Current page: ${i.page}  — new frames are placed here, to the right of existing content.`);
  } else lines.push('Plugin: not connected. ' + notConnectedText());
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/* ================================================================== */
/* Setup: connect AI apps on this computer to this server               */
/* ================================================================== */

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32', IS_MAC = process.platform === 'darwin';
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

function claudeDesktopConfig() {
  if (IS_MAC) return path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (IS_WIN) {
    const classic = path.join(APPDATA, 'Claude');
    if (fs.existsSync(classic)) return path.join(classic, 'claude_desktop_config.json');
    // Microsoft Store install keeps its data in a package folder.
    const pkgs = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Packages');
    try {
      for (const d of fs.readdirSync(pkgs)) {
        if (/^(Anthropic|Claude)/i.test(d)) {
          const p = path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude');
          if (fs.existsSync(p)) return path.join(p, 'claude_desktop_config.json');
        }
      }
    } catch (e) { /* none */ }
    return path.join(classic, 'claude_desktop_config.json');
  }
  return path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
}
function vscodeUserDir() {
  if (IS_MAC) return path.join(HOME, 'Library', 'Application Support', 'Code', 'User');
  if (IS_WIN) return path.join(APPDATA, 'Code', 'User');
  return path.join(HOME, '.config', 'Code', 'User');
}

// kind: 'json' (key = top-level object), 'toml' (Codex), 'cli' (Claude Code), 'manual' (no known file)
const APPS = [
  { id: 'claude-desktop', name: 'Claude Desktop', kind: 'json', key: 'mcpServers', file: claudeDesktopConfig,
    restart: 'Quit Claude completely (not just the window) and open it again.' },
  { id: 'claude-code', name: 'Claude Code', kind: 'cli', restart: 'Start a new Claude Code session.' },
  { id: 'chatgpt', name: 'ChatGPT desktop / Codex', kind: 'toml', file: () => path.join(HOME, '.codex', 'config.toml'),
    restart: 'Restart ChatGPT (or Codex).' },
  { id: 'cursor', name: 'Cursor', kind: 'json', key: 'mcpServers', file: () => path.join(HOME, '.cursor', 'mcp.json'), restart: 'Restart Cursor.' },
  { id: 'vscode', name: 'VS Code (Copilot)', kind: 'json', key: 'servers', file: () => path.join(vscodeUserDir(), 'mcp.json'),
    detect: () => fs.existsSync(vscodeUserDir()), restart: 'Restart VS Code, then start the server from the MCP view if asked.' },
  { id: 'windsurf', name: 'Windsurf', kind: 'json', key: 'mcpServers', file: () => path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    restart: 'Restart Windsurf.' },
  { id: 'gemini', name: 'Gemini CLI', kind: 'json', key: 'mcpServers', file: () => path.join(HOME, '.gemini', 'settings.json'),
    restart: 'Start a new Gemini CLI session.' },
  { id: 'lmstudio', name: 'LM Studio', kind: 'manual', key: 'mcpServers',
    where: 'In LM Studio: Program tab (right sidebar) → Install → Edit mcp.json, paste, save.' },
];

function entryFor(app) {
  const e = { command: process.execPath, args: [SERVER_PATH] };
  return app.key === 'servers' ? { type: 'stdio', ...e } : e;
}

function hasCli(name) {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8', shell: IS_WIN, timeout: 15000 });
  return r.status === 0;
}

function detect(app) {
  if (app.kind === 'cli') return hasCli('claude');
  if (app.kind === 'manual') return false;
  if (app.detect) return app.detect();
  return fs.existsSync(path.dirname(app.file()));
}

/** JSON that may contain comments or trailing commas (VS Code, Gemini) */
function parseLenientJson(text) {
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  let out = '', inStr = false, i = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function backupOnce(file) {
  const bak = file + '.before-html-to-figma';
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

function writeJsonEntry(app, remove) {
  const file = app.file();
  let data = {};
  if (fs.existsSync(file)) {
    try { data = parseLenientJson(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`couldn't read ${file} (it isn't valid JSON), so it was left untouched`); }
  } else if (remove) return 'nothing to remove';
  if (typeof data !== 'object' || Array.isArray(data) || data === null) throw new Error(`${file} has an unexpected format; left untouched`);
  data[app.key] = data[app.key] && typeof data[app.key] === 'object' ? data[app.key] : {};
  if (remove) {
    if (!data[app.key][SERVER_NAME]) return 'nothing to remove';
    delete data[app.key][SERVER_NAME];
  } else data[app.key][SERVER_NAME] = entryFor(app);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupOnce(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

const tomlStr = (s) => JSON.stringify(s); // TOML basic strings use JSON-compatible escapes
function tomlBlock() {
  return `[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlStr(process.execPath)}\nargs = [${tomlStr(SERVER_PATH)}]\n`;
}
function writeTomlEntry(app, remove) {
  const file = app.file();
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!text && remove) return 'nothing to remove';
  // Drop our table (and its sub-tables) if present, then append a fresh one.
  const lines = text.split('\n'), keep = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^\[/.test(t)) skipping = t === `[mcp_servers.${SERVER_NAME}]` || t.startsWith(`[mcp_servers.${SERVER_NAME}.`);
    if (!skipping) keep.push(line);
  }
  text = keep.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  if (!remove) text = (text.trim() ? text + '\n' : '') + tomlBlock();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupOnce(file);
  fs.writeFileSync(file, text);
  return file;
}

function claudeCode(remove) {
  const opts = { encoding: 'utf8', shell: IS_WIN, timeout: 60000 };
  spawnSync('claude', ['mcp', 'remove', '--scope', 'user', SERVER_NAME], opts);
  if (remove) return 'removed';
  const r = spawnSync('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', SERVER_NAME, '--', process.execPath, SERVER_PATH], opts);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'claude mcp add failed').trim());
  return 'registered for all your projects';
}

function apply(app, remove) {
  if (app.kind === 'json') return writeJsonEntry(app, remove);
  if (app.kind === 'toml') return writeTomlEntry(app, remove);
  if (app.kind === 'cli') return claudeCode(remove);
  throw new Error('this app is set up by hand');
}

function snippetFor(app) {
  if (app.kind === 'toml') return tomlBlock();
  if (app.kind === 'cli') return `claude mcp add --scope user --transport stdio ${SERVER_NAME} -- ${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER_PATH)}`;
  return JSON.stringify({ [app.key || 'mcpServers']: { [SERVER_NAME]: entryFor(app) } }, null, 2);
}

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function runSetup(argv, remove) {
  const out = (s = '') => process.stdout.write(s + '\n');
  const yes = argv.includes('--yes') || argv.includes('-y');
  const wanted = argv.filter((a) => !a.startsWith('-'));
  out(`\nHTML → Figma  ·  ${remove ? 'disconnect AI apps' : 'connect your AI apps'}  ·  v${VERSION}\n`);
  if (parseInt(process.versions.node, 10) < 18) {
    out(`This needs Node.js 18 or newer (you have ${process.versions.node}). Get it from https://nodejs.org and run this again.`);
    process.exitCode = 1; return;
  }
  let apps;
  if (wanted.length) {
    apps = wanted.map((w) => APPS.find((a) => a.id === w)).filter(Boolean);
    const unknown = wanted.filter((w) => !APPS.some((a) => a.id === w));
    if (unknown.length) out(`Unknown app name(s): ${unknown.join(', ')}. Known: ${APPS.map((a) => a.id).join(', ')}\n`);
  } else {
    apps = APPS.filter((a) => a.kind !== 'manual' && detect(a));
  }
  if (!apps.length) {
    out('No supported AI apps were found on this computer.');
    out('Install one (for example Claude Desktop from https://claude.ai/download), then run this again —');
    out(`or open the plugin in Figma and use "Connect AI app" to copy the settings by hand.`);
    return;
  }
  out((wanted.length ? 'Apps:' : 'Found these AI apps on this computer:'));
  apps.forEach((a, i) => out(`  ${i + 1}. ${a.name}`));
  out();
  if (!yes) {
    const a = await ask(`${remove ? 'Disconnect' : 'Connect'} HTML → Figma ${apps.length > 1 ? 'to all of them' : 'to it'}? [Y/n, or numbers like 1 3] `);
    if (/^n/i.test(a)) { out('Nothing changed.'); return; }
    const picks = (a.match(/\d+/g) || []).map((n) => apps[parseInt(n, 10) - 1]).filter(Boolean);
    if (picks.length) apps = picks;
  }
  const restarts = [];
  for (const app of apps) {
    try {
      const where = apply(app, remove);
      out(`  ✓ ${app.name}${where === 'nothing to remove' ? ' — wasn\'t connected' : ''}`);
      if (!remove && app.restart) restarts.push(`${app.name}: ${app.restart}`);
    } catch (e) {
      out(`  ✗ ${app.name} — ${e.message}`);
      out(`      You can paste these settings by hand instead:\n${snippetFor(app).replace(/^/gm, '        ')}`);
    }
  }
  if (remove) { out('\nDone.'); return; }
  out('\nAlmost there:');
  restarts.forEach((r) => out(`  • ${r}`));
  out('  • In Figma (desktop app): Plugins → Development → HTML to Figma Importer.');
  out('    When the plugin shows "AI connected", ask your AI app something like');
  out('    "Turn this landing page into a Figma design."');
  out(`\n(The settings point to this folder: ${path.dirname(path.dirname(SERVER_PATH))} — keep it where it is.`);
  out(' If you move it, just run the installer again.)\n');
}

async function runCli(cmd, argv) {
  if (cmd === 'setup') return runSetup(argv, false);
  if (cmd === 'remove' || cmd === 'uninstall') return runSetup(argv, true);
  if (cmd === 'config') {
    const app = APPS.find((a) => a.id === argv[0]);
    if (!app) { process.stdout.write(`Usage: config <app>. Apps: ${APPS.map((a) => a.id).join(', ')}\n`); return; }
    process.stdout.write(snippetFor(app) + '\n');
    if (app.kind !== 'cli') process.stdout.write(`\n${app.where || `File: ${app.file()}`}\n`);
    return;
  }
  if (cmd === 'status') {
    const res = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 2000 }, (r) => {
        let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
      }).on('error', () => resolve(null));
    });
    if (!res) process.stdout.write(`No AI app is running the bridge right now (nothing on port ${PORT}). Open your AI app first.\n`);
    else process.stdout.write(`Bridge v${res.version} is running. Figma plugin: ${res.pluginConnected ? `connected (${(res.plugin && res.plugin.fileName) || 'a file'})` : 'not open'}.\n`);
    return;
  }
  if (cmd === '--version' || cmd === 'version') { process.stdout.write(VERSION + '\n'); return; }
  process.stdout.write('Commands: setup, remove, config <app>, status, version. Without a command it runs as an MCP server.\n');
}

/* Uploads: HTML and assets sent by the AI in parts (kept in memory for a while). */
const uploads = new Map(); // id -> { files: Map(name -> Buffer), bytes, touched }
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

function cleanName(n) {
  const name = String(n || 'index.html').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').trim();
  if (!name || name.split('/').some((seg) => seg === '..' || seg === '')) throw new ToolError(`Invalid file_name "${n}". Use a relative path like "index.html" or "img/logo.png".`);
  return name;
}

function decodeContent(content, encoding) {
  const m = /^data:([^,]*?)(;base64)?,/i.exec(content);
  if (m) {
    const body = content.slice(m[0].length);
    return m[2] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
  }
  return encoding === 'base64' ? Buffer.from(content.replace(/\s+/g, ''), 'base64') : Buffer.from(content, 'utf8');
}

function sweepUploads() {
  for (const [id, u] of uploads) if (Date.now() - u.touched > UPLOAD_TTL_MS) uploads.delete(id);
}

const kb = (n) => `${n < 10240 ? (n / 1024).toFixed(1) : Math.round(n / 1024)} KB`;

function toolUpload(args) {
  sweepUploads();
  if (typeof args.content !== 'string') throw new ToolError('`content` is required.');
  let id = args.upload_id, up = id && uploads.get(id);
  if (id && !up) throw new ToolError(`Upload "${id}" not found (it expires after 2 hours, or the AI app restarted). Start again without upload_id.`);
  if (!up) {
    id = 'up_' + crypto.randomBytes(6).toString('hex');
    up = { files: new Map(), bytes: 0, touched: Date.now() };
    uploads.set(id, up);
  }
  const name = cleanName(args.file_name);
  const data = decodeContent(args.content, args.encoding);
  const prev = up.files.get(name);
  const next = args.append && prev ? Buffer.concat([prev, data]) : data;
  const bytes = up.bytes - (prev ? prev.length : 0) + next.length;
  if (bytes > MAX_UPLOAD_BYTES) throw new ToolError(`Upload too large (over ${MAX_UPLOAD_BYTES / 1048576} MB).`);
  up.files.set(name, next); up.bytes = bytes; up.touched = Date.now();
  const list = [...up.files].map(([n, b]) => `${n} (${kb(b.length)})`).join(', ');
  return { content: [{ type: 'text', text:
    `upload_id: ${id}\nFiles so far: ${list}.\n` +
    `Send more parts with upload_file_for_import({upload_id: "${id}", file_name, content, append: true}), ` +
    `or import with import_html_to_figma({upload_id: "${id}"}).` }] };
}

function pickEntry(names, wanted) {
  if (wanted) {
    const w = cleanName(wanted);
    if (!names.includes(w)) throw new ToolError(`No uploaded file named "${w}". Uploaded: ${names.join(', ')}.`);
    return w;
  }
  const htmls = names.filter((n) => /\.html?$/i.test(n));
  if (!htmls.length) throw new ToolError(`No .html file in this upload (got ${names.join(', ')}). Upload the page as "index.html".`);
  return htmls.find((n) => /(^|\/)index\.html?$/i.test(n)) || htmls[0];
}

async function toolImport(args, progress) {
  const sources = ['path', 'html', 'url', 'upload_id'].filter((k) => typeof args[k] === 'string' && args[k].trim());
  if (sources.length !== 1) throw new ToolError('Provide exactly one of `html`, `upload_id`, `path` or `url`.');
  if (args.files && sources[0] !== 'html') throw new ToolError('`files` can only be used together with `html`.');
  const payload = {
    options: {
      devices: args.devices && args.devices.length ? args.devices : ['desktop'],
      autoLayout: args.auto_layout || 'flex',
      cropScreen: !!args.crop_to_screen,
      sizes: args.screen_sizes || null,
      textMode: args.text_layers || 'paragraph',
      scripts: args.run_scripts !== false,
      flatten: args.remove_empty_wrappers !== false,
      freeze: args.freeze_animations !== false,
      wait: Number.isFinite(args.wait_ms) ? args.wait_ms : 400,
      baseUrl: args.base_url || '',
      preview: args.preview !== false,
    },
  };
  let sourceText;
  if (sources[0] === 'path') {
    const p = path.resolve(args.path.replace(/^~(?=$|\/)/, process.env.HOME || ''));
    if (!/\.html?$/i.test(p)) throw new ToolError(`\`path\` must point to an .html or .htm file (got ${p}).`);
    if (!fs.existsSync(p)) throw new ToolError(`File not found on the user's computer: ${p}. ` +
      '`path` only works for files on the computer running Figma. If the HTML is in your own workspace or sandbox, ' +
      'send the code itself instead: import_html_to_figma({html}) for short pages, or upload_file_for_import in parts ' +
      'for long ones (plus any images/CSS it uses), then import_html_to_figma({upload_id}).');
    const bundle = collectFiles(p);
    payload.files = bundle.files; payload.entry = bundle.entry;
    payload.options.name = args.name || path.basename(p).replace(/\.html?$/i, '');
    sourceText = `${p} (${bundle.count} file${bundle.count > 1 ? 's' : ''}, ${(bundle.bytes / 1024).toFixed(0)} KB)`;
  } else if (sources[0] === 'url') {
    let u;
    try { u = new URL(args.url); } catch (e) { throw new ToolError('`url` is not a valid URL.'); }
    if (!/^https?:$/.test(u.protocol)) throw new ToolError('`url` must be http or https.');
    progress && progress('Fetching page…');
    const res = await fetch(u, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (html-to-figma MCP)' } });
    if (!res.ok) throw new ToolError(`Fetching ${u} failed: HTTP ${res.status}`);
    payload.html = await res.text();
    payload.options.baseUrl = args.base_url || res.url || u.href;
    payload.options.name = args.name || u.hostname;
    sourceText = u.href;
  } else if (sources[0] === 'upload_id') {
    sweepUploads();
    const up = uploads.get(args.upload_id);
    if (!up) throw new ToolError(`Upload "${args.upload_id}" not found (it expires after 2 hours, or the AI app restarted). Upload the files again.`);
    up.touched = Date.now();
    const entry = pickEntry([...up.files.keys()], args.entry);
    payload.files = {};
    for (const [n, b] of up.files) payload.files[n] = b.toString('base64');
    payload.entry = entry;
    payload.options.name = args.name || entry.split('/').pop().replace(/\.html?$/i, '');
    sourceText = `uploaded ${entry} (${up.files.size} file${up.files.size > 1 ? 's' : ''}, ${kb(up.bytes)})`;
  } else if (args.files && Object.keys(args.files).length) {
    payload.files = { 'index.html': Buffer.from(args.html, 'utf8').toString('base64') };
    for (const [n, c] of Object.entries(args.files)) {
      if (typeof c !== 'string') throw new ToolError(`files["${n}"] must be a string.`);
      payload.files[cleanName(n)] = decodeContent(c, 'text').toString('base64');
    }
    payload.entry = 'index.html';
    payload.options.name = args.name || 'HTML';
    sourceText = `HTML code with ${Object.keys(args.files).length} asset file(s)`;
  } else {
    if (!/[<>]/.test(args.html) && /\.html?$/i.test(args.html.trim())) {
      throw new ToolError('`html` looks like a file name, not HTML code. Pass the file\'s contents in `html`, or its path on the user\'s computer in `path`.');
    }
    payload.html = args.html;
    payload.options.name = args.name || 'HTML';
    sourceText = 'HTML code';
  }

  if (!(await waitForPlugin(3000))) throw new ToolError(notConnectedText());

  const result = await callPlugin('import', payload, progress);
  const content = [];
  const lines = [`Imported ${sourceText} into Figma${result.fileName ? ` file "${result.fileName}"` : ''}${result.page ? `, page "${result.page}"` : ''}.`];
  for (const f of result.frames || []) {
    lines.push(`- Frame "${f.name}" — node ID ${f.id}, ${Math.round(f.width)}×${Math.round(f.height)}` +
      `${f.autoLayout ? `, ${f.autoLayout} Auto Layout frame${f.autoLayout > 1 ? 's' : ''}` : ''}${f.url ? ` — ${f.url}` : ''}`);
  }
  lines.push(`${result.layers} layers created.${result.errors ? ` ${result.errors} layer(s) could not be created and were skipped.` : ''}`);
  if (result.substitutions && result.substitutions.length) lines.push(`Font substitutions (font not installed in Figma): ${result.substitutions.join(', ')}.`);
  if (result.warnings && result.warnings.length) lines.push(...result.warnings.map((w) => 'Note: ' + w));
  content.push({ type: 'text', text: lines.join('\n') });
  for (const pv of result.previews || []) content.push({ type: 'image', data: pv.data, mimeType: 'image/png' });
  return { content };
}

/* ================================================================== */
/* MCP over stdio (JSON-RPC 2.0, newline-delimited)                     */
/* ================================================================== */

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': {
        const v = params && SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
        return reply(id, {
          protocolVersion: v,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'html-to-figma', title: 'HTML to Figma', version: VERSION },
          instructions: 'Turns HTML into editable Figma designs via the "HTML to Figma Importer" plugin running in Figma desktop. ' +
            'Use import_html_to_figma with a local file path, an HTML string, or a URL. If it reports the plugin is not connected, ' +
            'ask the user to open the plugin in Figma (Plugins → Development → HTML to Figma Importer). If the user needs to ' +
            'install or connect it on a computer, the START-HERE.md file in the plugin folder has the full guided steps.',
        });
      }
      case 'ping': return reply(id, {});
      case 'tools/list': return reply(id, { tools: TOOLS });
      case 'tools/call': {
        const name = params && params.name, args = (params && params.arguments) || {};
        const token = params && params._meta && params._meta.progressToken;
        let step = 0;
        const progress = token === undefined ? null : (message) =>
          send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } });
        try {
          let result;
          if (name === 'import_html_to_figma') result = await toolImport(args, progress);
          else if (name === 'upload_file_for_import') result = toolUpload(args);
          else if (name === 'figma_bridge_status') result = await toolStatus();
          else return replyError(id, -32602, `Unknown tool: ${name}`);
          return reply(id, result);
        } catch (err) {
          // Tool failures are reported to the model as results, so it can explain or retry.
          return reply(id, { content: [{ type: 'text', text: err.message || String(err) }], isError: true });
        }
      }
      default:
        if (!isRequest) return; // notifications (initialized, cancelled, …)
        if (method === 'resources/list') return reply(id, { resources: [] });
        if (method === 'prompts/list') return reply(id, { prompts: [] });
        return replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (isRequest) replyError(id, -32603, err.message || String(err));
  }
}

function startMcp() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return replyError(null, -32700, 'Parse error'); }
    if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
  });
  rl.on('close', () => process.exit(0));
  startBridge();
  log(`v${VERSION} ready (MCP on stdio, plugin bridge on port ${PORT})`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd) runCli(cmd, rest).catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 1; });
else startMcp();
