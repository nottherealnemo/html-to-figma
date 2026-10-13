// HTML to Figma Importer — main thread.
// Receives a layer tree measured from the rendered HTML (see ui.html) and builds Figma nodes.

// Bump on every release (and match mcp-server/html-to-figma-mcp.mjs). See CHANGELOG.md.
const PLUGIN_VERSION = '1.7.1';

figma.showUI(__html__, { width: 340, height: 640, themeColors: true, title: `HTML to Figma v${PLUGIN_VERSION}` });
figma.ui.postMessage({ type: 'version', version: PLUGIN_VERSION });

// Restore the user's last-used settings.
figma.clientStorage.getAsync('settings').then((value) => {
  if (value) figma.ui.postMessage({ type: 'settings', value: value });
}).catch(() => {});

// Tell the UI (and through it, the Claude bridge) which file/page imports land in.
function sendFileInfo() {
  let fileKey = null;
  try { fileKey = figma.fileKey || null; } catch (e) { /* only available to private plugins */ }
  figma.ui.postMessage({ type: 'file-info', info: { fileName: figma.root.name, page: figma.currentPage.name, fileKey: fileKey } });
  figma.ui.postMessage({ type: 'version', version: PLUGIN_VERSION });
}
sendFileInfo();
figma.on('currentpagechange', sendFileInfo);

function nodeUrl(id) {
  let key = null;
  try { key = figma.fileKey; } catch (e) { /* not available */ }
  return key ? `https://www.figma.com/design/${key}/?node-id=${encodeURIComponent(id.replace(':', '-'))}` : null;
}

async function previewOf(node) {
  // Keep previews light: at most 800px wide and 3000px tall.
  const scale = Math.min(1, 800 / node.width, 3000 / node.height);
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: Math.max(0.05, scale) } });
  return figma.base64Encode(bytes);
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'save-settings') {
    figma.clientStorage.setAsync('settings', msg.value).catch(() => {});
    return;
  }
  if (msg.type === 'get-file-info') { sendFileInfo(); return; }
  if (msg.type !== 'import') return;
  const requestId = msg.requestId || null;
  try {
    const result = await importPages(msg.pages);
    const warn = result.errors ? ` (${result.errors} layer${result.errors > 1 ? 's' : ''} skipped)` : '';
    const subs = result.substitutions.length ? ` Fonts substituted: ${result.substitutions.slice(0, 4).join(', ')}${result.substitutions.length > 4 ? '…' : ''}.` : '';
    const al = msg.pages.reduce((a, p) => a + ((p.stats && p.stats.autoLayout) || 0), 0);
    const alText = al ? ` ${al} frame${al > 1 ? 's' : ''} use Auto Layout.` : '';
    const text = `Imported ${result.layers} layers into ${msg.pages.length} frame${msg.pages.length > 1 ? 's' : ''}${warn}.${alText}${subs}`;
    const frames = result.roots.map((r, i) => ({
      id: r.id, name: r.name, width: r.width, height: r.height,
      autoLayout: (msg.pages[i].stats && msg.pages[i].stats.autoLayout) || 0, url: nodeUrl(r.id),
    }));
    const previews = [];
    if (msg.preview) {
      for (const r of result.roots.slice(0, 4)) {
        try { previews.push({ id: r.id, data: await previewOf(r) }); } catch (e) { /* skip preview */ }
      }
    }
    figma.ui.postMessage({
      type: 'done', requestId: requestId, text: text,
      result: {
        frames: frames, layers: result.layers, errors: result.errors, substitutions: result.substitutions,
        fileName: figma.root.name, page: figma.currentPage.name, previews: previews, pluginVersion: PLUGIN_VERSION,
      },
    });
    figma.notify(`Imported ${msg.pages.length} frame${msg.pages.length > 1 ? 's' : ''} from HTML${requestId ? ' (via AI)' : ''} · v${PLUGIN_VERSION}`);
  } catch (err) {
    console.error(err);
    figma.ui.postMessage({ type: 'error', requestId: requestId, text: 'Import failed: ' + (err && err.message ? err.message : String(err)) });
  }
};

/* ------------------------------------------------------------------ */
/* Fonts                                                               */
/* ------------------------------------------------------------------ */

const GENERIC_FONTS = {
  'sans-serif': ['Inter', 'Roboto', 'Helvetica Neue', 'Arial'],
  'system-ui': ['SF Pro Text', 'Inter', 'Segoe UI', 'Roboto'],
  '-apple-system': ['SF Pro Text', 'Inter'],
  'blinkmacsystemfont': ['SF Pro Text', 'Inter'],
  'ui-sans-serif': ['Inter', 'SF Pro Text', 'Roboto'],
  'serif': ['Times New Roman', 'Georgia', 'Noto Serif', 'Source Serif Pro', 'Merriweather'],
  'ui-serif': ['New York', 'Georgia', 'Noto Serif'],
  'monospace': ['Roboto Mono', 'SF Mono', 'Menlo', 'Source Code Pro', 'Courier New'],
  'ui-monospace': ['SF Mono', 'Roboto Mono', 'Menlo', 'Source Code Pro'],
  'cursive': ['Comic Sans MS', 'Caveat'],
  'fantasy': ['Impact', 'Bebas Neue'],
  'emoji': ['Noto Color Emoji', 'Apple Color Emoji'],
  'math': ['STIX Two Math', 'Cambria Math'],
  'helvetica': ['Helvetica', 'Helvetica Neue', 'Arial', 'Inter'],
  'segoe ui': ['Segoe UI', 'Inter'],
};
const FALLBACK_FAMILY = 'Inter';

const WEIGHT_WORDS = [
  [/(hairline|thin)/, 100], [/(extra|ultra)light/, 200], [/light/, 300],
  [/(semi|demi)bold/, 600], [/(extra|ultra)bold/, 800], [/bold/, 700],
  [/medium/, 500], [/(black|heavy)/, 900], [/(regular|normal|book|roman|plain)/, 400],
];

function styleWeight(style) {
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
  for (const [re, w] of WEIGHT_WORDS) if (re.test(s)) return w;
  return 400;
}

let fontIndex = null;
async function getFontIndex() {
  if (fontIndex) return fontIndex;
  const fonts = await figma.listAvailableFontsAsync();
  fontIndex = new Map();
  for (const f of fonts) {
    const key = f.fontName.family.toLowerCase();
    if (!fontIndex.has(key)) fontIndex.set(key, { family: f.fontName.family, styles: [] });
    fontIndex.get(key).styles.push(f.fontName.style);
  }
  return fontIndex;
}

function pickStyle(styles, weight, italic) {
  let best = null, bestScore = Infinity;
  for (const st of styles) {
    const low = st.toLowerCase();
    const isItalic = /italic|oblique/.test(low);
    let score = Math.abs(styleWeight(st) - weight);
    if (isItalic !== italic) score += 1000;
    if (/condensed|narrow|compressed|expanded|extended|wide|display|caption|subhead|small|variable/.test(low)) score += 60;
    if (/^(regular|italic|bold|bold italic)$/.test(low)) score -= 1;
    if (score < bestScore) { bestScore = score; best = st; }
  }
  return best;
}

const fontCache = new Map();
const substitutions = new Set();

function resolveFont(index, families, weight, italic) {
  const cacheKey = families.join('|') + '/' + weight + '/' + italic;
  if (fontCache.has(cacheKey)) return fontCache.get(cacheKey);
  let entry = null;
  for (const fam of families) {
    const low = fam.toLowerCase();
    if (index.has(low)) { entry = index.get(low); break; }
    if (GENERIC_FONTS[low]) {
      for (const g of GENERIC_FONTS[low]) if (index.has(g.toLowerCase())) { entry = index.get(g.toLowerCase()); break; }
      if (entry) break;
    }
  }
  if (!entry) entry = index.get(FALLBACK_FAMILY.toLowerCase()) || index.values().next().value;
  const wanted = families[0] || '';
  if (wanted && entry.family.toLowerCase() !== wanted.toLowerCase() && !GENERIC_FONTS[wanted.toLowerCase()]) {
    substitutions.add(`${wanted} → ${entry.family}`);
  }
  const font = { family: entry.family, style: pickStyle(entry.styles, weight, italic) };
  fontCache.set(cacheKey, font);
  return font;
}

/* ------------------------------------------------------------------ */
/* Paints & effects                                                    */
/* ------------------------------------------------------------------ */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const rgb = (c) => ({ r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) });
const rgba = (c) => ({ r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a) });

// Figma's gradientTransform maps the node's unit square into gradient space,
// where the gradient runs from (0, 0.5) to (1, 0.5).
function linearGradientTransform(angleDeg, w, h) {
  const a = angleDeg * Math.PI / 180;
  const sin = Math.sin(a), cos = Math.cos(a);
  const L = Math.abs(w * sin) + Math.abs(h * cos) || 1;
  const ax = (w * sin) / L, bx = (-h * cos) / L;
  const cx = 0.5 - (ax + bx) / 2;
  const ay = -bx, by = ax;
  const cy = 0.5 - (ay + by) / 2;
  return [[ax, bx, cx], [ay, by, cy]];
}

function makePaint(p, w, h, imageHashes) {
  if (p.type === 'SOLID') {
    if (!p.color || p.color.a <= 0) return null;
    return { type: 'SOLID', color: rgb(p.color), opacity: clamp01(p.color.a) };
  }
  if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR') {
    const stops = p.stops.map((s) => ({ position: clamp01(s.position), color: rgba(s.color) }));
    if (stops.length < 2) stops.push({ position: 1, color: stops[0].color });
    let transform;
    if (p.type === 'GRADIENT_LINEAR') transform = linearGradientTransform(p.angle == null ? 180 : p.angle, w, h);
    else if (p.type === 'GRADIENT_RADIAL') {
      const k = Math.SQRT2; // farthest-corner ellipse
      transform = [[1 / k, 0, 0.5 - 0.5 / k], [0, 1 / k, 0.5 - 0.5 / k]];
    } else transform = [[1, 0, 0], [0, 1, 0]];
    return { type: p.type, gradientStops: stops, gradientTransform: transform };
  }
  if (p.type === 'IMAGE') {
    const hash = imageHashes[p.imageId];
    if (!hash) return null;
    return { type: 'IMAGE', imageHash: hash, scaleMode: p.scaleMode || 'FILL' };
  }
  return null;
}

function makePaints(list, w, h, imageHashes) {
  const out = [];
  for (const p of list || []) {
    const paint = makePaint(p, w, h, imageHashes);
    if (paint) out.push(paint);
  }
  return out;
}

function setEffects(node, effects) {
  if (!effects || !effects.length) return;
  const list = effects.map((e) => {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const eff = {
        type: e.type, color: rgba(e.color), offset: { x: e.x, y: e.y }, radius: Math.max(0, e.blur),
        spread: e.spread || 0, visible: true, blendMode: 'NORMAL',
      };
      if (e.type === 'DROP_SHADOW') eff.showShadowBehindNode = false;
      return eff;
    }
    return { type: e.type, radius: e.radius, visible: true };
  });
  try {
    node.effects = list;
  } catch (err) {
    // Newer API versions require blurType on blur effects.
    try { node.effects = list.map((e) => (/BLUR/.test(e.type) ? Object.assign({ blurType: 'NORMAL' }, e) : e)); }
    catch (err2) { node.effects = list.filter((e) => !/BLUR/.test(e.type)); }
  }
}

function applyBox(node, data, imageHashes) {
  node.fills = makePaints(data.fills, data.w, data.h, imageHashes);
  if (data.strokes && data.strokes.color && data.strokes.color.a > 0) {
    const s = data.strokes;
    node.strokes = [{ type: 'SOLID', color: rgb(s.color), opacity: clamp01(s.color.a) }];
    node.strokeAlign = 'INSIDE';
    if (s.top === s.right && s.right === s.bottom && s.bottom === s.left) node.strokeWeight = s.top;
    else {
      node.strokeTopWeight = s.top; node.strokeRightWeight = s.right;
      node.strokeBottomWeight = s.bottom; node.strokeLeftWeight = s.left;
    }
    const wgt = Math.max(s.top, s.right, s.bottom, s.left);
    if (s.style === 'dashed') node.dashPattern = [wgt * 3, wgt * 2];
    else if (s.style === 'dotted') node.dashPattern = [wgt, wgt];
  }
  if (data.radius) {
    node.topLeftRadius = data.radius[0]; node.topRightRadius = data.radius[1];
    node.bottomRightRadius = data.radius[2]; node.bottomLeftRadius = data.radius[3];
  }
  setEffects(node, data.effects);
  if (data.opacity != null && data.opacity < 1) node.opacity = data.opacity;
}

/* ------------------------------------------------------------------ */
/* Node builders                                                       */
/* ------------------------------------------------------------------ */

const MIN = 0.01;
const r2 = (v) => Math.round(v * 100) / 100;

function place(node, data, ox, oy) {
  node.x = r2(data.x - ox);
  node.y = r2(data.y - oy);
}

function buildFrame(data, ox, oy, ctx) {
  const f = figma.createFrame();
  f.name = data.name || 'frame';
  f.resizeWithoutConstraints(Math.max(MIN, r2(data.w)), Math.max(MIN, r2(data.h)));
  place(f, data, ox, oy);
  applyBox(f, data, ctx.imageHashes);
  f.clipsContent = !!data.clip;
  return f;
}

function buildText(data, ox, oy, ctx) {
  const segs = data.segments.filter((s) => s.text.length);
  if (!segs.length) return null;
  const t = figma.createText();
  const fonts = segs.map((s) => ctx.fontFor(s.style));
  t.fontName = fonts[0];
  t.characters = segs.map((s) => s.text).join('');
  let pos = 0;
  segs.forEach((s, i) => {
    const start = pos, end = pos + s.text.length;
    pos = end;
    const st = s.style;
    t.setRangeFontName(start, end, fonts[i]);
    t.setRangeFontSize(start, end, Math.max(1, st.size));
    const fill = makePaint(st.fill, data.w, data.h, ctx.imageHashes);
    t.setRangeFills(start, end, fill ? [fill] : []);
    t.setRangeLineHeight(start, end, st.lineHeight ? { unit: 'PIXELS', value: st.lineHeight } : { unit: 'AUTO' });
    if (st.letterSpacing) t.setRangeLetterSpacing(start, end, { unit: 'PIXELS', value: st.letterSpacing });
    if (st.decoration && st.decoration !== 'NONE') t.setRangeTextDecoration(start, end, st.decoration);
    if (st.textCase && st.textCase !== 'ORIGINAL') t.setRangeTextCase(start, end, st.textCase);
    if (st.href) { try { t.setRangeHyperlink(start, end, { type: 'URL', value: st.href }); } catch (e) { /* ignore */ } }
  });
  t.textAlignHorizontal = data.align || 'LEFT';
  if (data.autoWidth) {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  } else if (data.fixedHeight) {
    t.textAutoResize = 'NONE';
    t.resize(Math.max(1, r2(data.w)), Math.max(1, r2(data.h)));
    t.textAlignVertical = data.valign || 'TOP';
    if (data.truncate) {
      try { t.textTruncation = 'ENDING'; t.maxLines = 1; } catch (e) { /* older API */ }
    }
  } else {
    t.resize(Math.max(1, r2(data.w)), Math.max(1, r2(data.h)));
    t.textAutoResize = 'HEIGHT';
  }
  place(t, data, ox, oy);
  // Safety net: the browser drew this on one line. If Figma's font metrics make it wrap, let it grow instead.
  if (data.lines === 1 && !data.fixedHeight && t.textAutoResize === 'HEIGHT') {
    const st = segs[0].style;
    const oneLine = st.lineHeight || st.size * 1.45;
    if (t.height > oneLine * 1.5) {
      const before = t.width;
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
      const grew = t.width - before;
      if (data.align === 'CENTER') t.x = r2(t.x - grew / 2);
      else if (data.align === 'RIGHT') t.x = r2(t.x - grew);
      ctx.unwrapped = (ctx.unwrapped || 0) + 1;
    }
  }
  return t;
}

function buildSvg(data, ox, oy, ctx) {
  let n;
  try {
    n = figma.createNodeFromSvg(data.svg);
  } catch (e) {
    ctx.errors++;
    n = figma.createFrame();
    n.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
  }
  n.name = data.name || 'svg';
  if (Math.abs(n.width - data.w) > 0.5 || Math.abs(n.height - data.h) > 0.5) {
    try { n.rescale(Math.max(MIN, data.w) / Math.max(MIN, n.width)); } catch (e) { /* ignore */ }
  }
  if ('clipsContent' in n) n.clipsContent = false;
  if (data.opacity != null && data.opacity < 1) n.opacity = data.opacity;
  place(n, data, ox, oy);
  return n;
}

async function buildTree(data, parent, ox, oy, ctx) {
  let node = null;
  try {
    if (data.type === 'frame') node = buildFrame(data, ox, oy, ctx);
    else if (data.type === 'text') node = buildText(data, ox, oy, ctx);
    else if (data.type === 'svg') node = buildSvg(data, ox, oy, ctx);
  } catch (err) {
    ctx.errors++;
    console.warn('Skipped layer', data.name || data.type, err);
    return;
  }
  if (!node) return;
  parent.appendChild(node);
  ctx.layers++;
  if (ctx.layers % 250 === 0) {
    figma.ui.postMessage({ type: 'progress', text: `Building layers… ${ctx.layers}` });
    await new Promise((r) => setTimeout(r, 0));
  }
  if (data.type === 'frame' && data.children) {
    const built = [];
    for (const child of data.children) {
      const c = await buildTree(child, node, data.x, data.y, ctx);
      if (c) built.push([c, child]);
    }
    if (data.autoLayout) {
      try { applyAutoLayout(node, data, built); }
      catch (err) { ctx.errors++; console.warn('Auto Layout skipped for', data.name, err); }
    }
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Auto Layout                                                         */
/* ------------------------------------------------------------------ */

// Turns a frame into an Auto Layout frame using settings fitted in the UI
// (which already verified they reproduce the HTML layout).
function applyAutoLayout(frame, data, built) {
  const al = data.autoLayout;
  const w = frame.width, h = frame.height;
  frame.layoutMode = al.mode;
  frame.primaryAxisSizingMode = 'FIXED';
  frame.counterAxisSizingMode = 'FIXED';
  frame.resizeWithoutConstraints(w, h);
  if (al.wrap) {
    frame.layoutWrap = 'WRAP';
    frame.counterAxisSpacing = al.counterSpacing;
  }
  frame.paddingTop = al.pad[0];
  frame.paddingRight = al.pad[1];
  frame.paddingBottom = al.pad[2];
  frame.paddingLeft = al.pad[3];
  frame.itemSpacing = al.spacing;
  frame.primaryAxisAlignItems = al.justify;
  frame.counterAxisAlignItems = al.align;
  frame.strokesIncludedInLayout = false;

  for (const [node, childData] of built) {
    const lc = childData.layoutChild || {};
    if (lc.absolute) {
      node.layoutPositioning = 'ABSOLUTE';
      node.x = r2(childData.x - data.x);
      node.y = r2(childData.y - data.y);
      continue;
    }
    // Never stretch or grow a one-line label: it must hug its text so it can't wrap.
    const oneLine = node.type === 'TEXT' && childData.lines === 1;
    if (lc.grow && !oneLine) node.layoutGrow = 1;
    if (lc.stretch && !oneLine) node.layoutAlign = 'STRETCH';
  }

  if (al.hugMain) frame.primaryAxisSizingMode = 'AUTO';
  if (al.hugCross) frame.counterAxisSizingMode = 'AUTO';
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

function collectStyles(node, out) {
  if (node.type === 'text') for (const s of node.segments) out.push(s.style);
  if (node.children) for (const c of node.children) collectStyles(c, out);
  return out;
}

async function importPages(pages) {
  substitutions.clear();
  const index = await getFontIndex();
  const ctx = { layers: 0, errors: 0, imageHashes: {}, fontFor: null };

  // 1. Resolve & load every font up front (text edits require loaded fonts).
  figma.ui.postMessage({ type: 'progress', text: 'Loading fonts…' });
  const styleFont = new Map();
  const toLoad = new Map();
  for (const page of pages) {
    for (const st of collectStyles(page.root, [])) {
      const key = st.families.join('|') + '/' + st.weight + '/' + st.italic;
      if (styleFont.has(key)) continue;
      const font = resolveFont(index, st.families, st.weight, st.italic);
      styleFont.set(key, font);
      toLoad.set(font.family + '/' + font.style, font);
    }
  }
  const fallback = { family: 'Inter', style: 'Regular' };
  toLoad.set('Inter/Regular', fallback);
  const failed = new Set();
  await Promise.all([...toLoad.values()].map((f) =>
    figma.loadFontAsync(f).catch(() => { failed.add(f.family + '/' + f.style); })));
  ctx.fontFor = (st) => {
    const f = styleFont.get(st.families.join('|') + '/' + st.weight + '/' + st.italic) || fallback;
    return failed.has(f.family + '/' + f.style) ? fallback : f;
  };

  // 2. Images
  figma.ui.postMessage({ type: 'progress', text: 'Adding images…' });
  pages.forEach((page, pi) => {
    for (const id of Object.keys(page.images || {})) {
      try { ctx.imageHashes[pi + ':' + id] = figma.createImage(page.images[id]).hash; }
      catch (e) { ctx.errors++; }
    }
  });

  // 3. Place frames to the right of existing content.
  let startX = 0, startY = 0;
  const existing = figma.currentPage.children;
  if (existing.length) {
    startX = Math.max(...existing.map((n) => n.x + n.width)) + 200;
    startY = Math.min(...existing.map((n) => n.y));
  }

  const roots = [];
  let x = startX;
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const scoped = Object.assign({}, ctx, { imageHashes: {}, layers: 0, errors: 0 });
    for (const id of Object.keys(page.images || {})) scoped.imageHashes[id] = ctx.imageHashes[pi + ':' + id];
    const rootData = Object.assign({}, page.root, { x: 0, y: 0 });
    const root = buildFrame(rootData, -x, -startY, scoped);
    figma.currentPage.appendChild(root);
    // Children are in page coordinates; the root may be cropped (Canvas) to start elsewhere.
    for (const child of rootData.children) await buildTree(child, root, page.root.x || 0, page.root.y || 0, scoped);
    ctx.layers += scoped.layers + 1;
    ctx.errors += scoped.errors;
    roots.push(root);
    x += root.width + 120;
  }

  figma.currentPage.selection = roots;
  figma.viewport.scrollAndZoomIntoView(roots);
  return { layers: ctx.layers, errors: ctx.errors, substitutions: [...substitutions], roots: roots };
}
