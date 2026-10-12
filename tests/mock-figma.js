// Strict mock of the Figma plugin API: runs code.js against an extracted tree,
// validates every value Figma would reject, then renders the resulting node
// tree back to HTML so it can be compared with the original page.
//
// usage: node mock-figma.js tree.json out.html
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const path = require('path');

const MESSAGE_MODE = process.argv[2] === '--message';
const [, , treePath, outPath] = MESSAGE_MODE ? [null, null, null, null] : process.argv;
const incoming = MESSAGE_MODE ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
const tree = MESSAGE_MODE ? { root: incoming.pages[0].root, images: {} } : JSON.parse(fs.readFileSync(treePath, 'utf8'));
const posted = [];
const problems = [];
const fail = (msg) => { problems.push(msg); throw new Error(msg); };

const FONTS = {
  'Inter': ['Thin', 'Extra Light', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black',
    'Thin Italic', 'Light Italic', 'Italic', 'Medium Italic', 'Semi Bold Italic', 'Bold Italic', 'Black Italic'],
  'Roboto Mono': ['Regular', 'Medium', 'Bold', 'Italic'],
  'Times New Roman': ['Regular', 'Bold', 'Italic', 'Bold Italic'],
  'Arial': ['Regular', 'Bold', 'Italic'],
};
const loaded = new Set();
const images = {};

function checkColor(c, withAlpha, where) {
  const keys = Object.keys(c).sort().join(',');
  const want = withAlpha ? 'a,b,g,r' : 'b,g,r';
  if (keys !== want) fail(`${where}: color keys ${keys}, expected ${want}`);
  for (const k of Object.keys(c)) if (!(c[k] >= 0 && c[k] <= 1)) fail(`${where}: color.${k}=${c[k]} out of range`);
}
function checkPaints(paints, where) {
  if (!Array.isArray(paints)) fail(`${where}: paints not array`);
  for (const p of paints) {
    if (p.type === 'SOLID') { checkColor(p.color, false, where); if (p.opacity != null && !(p.opacity >= 0 && p.opacity <= 1)) fail(where + ' opacity'); }
    else if (p.type.startsWith('GRADIENT')) {
      if (!Array.isArray(p.gradientStops) || p.gradientStops.length < 2) fail(where + ' stops');
      p.gradientStops.forEach((s) => { checkColor(s.color, true, where); if (!(s.position >= 0 && s.position <= 1)) fail(where + ' stop pos'); });
      const t = p.gradientTransform;
      if (!t || t.length !== 2 || t.some((r) => r.length !== 3 || r.some((v) => !isFinite(v)))) fail(where + ' transform');
    } else if (p.type === 'IMAGE') { if (!images[p.imageHash]) fail(where + ' unknown image hash'); }
    else fail(where + ' unknown paint ' + p.type);
    const allowed = { SOLID: ['type', 'color', 'opacity'], IMAGE: ['type', 'imageHash', 'scaleMode'] };
    const ok = allowed[p.type] || ['type', 'gradientStops', 'gradientTransform'];
    for (const k of Object.keys(p)) if (!ok.includes(k)) fail(`${where}: unexpected paint key ${k}`);
  }
}
function checkNum(v, where) { if (typeof v !== 'number' || !isFinite(v)) fail(`${where}: bad number ${v}`); }

let idSeq = 1;
class BaseNode {
  constructor(type) { this.type = type; this.id = String(idSeq++); this.name = type; this.children = []; this._x = 0; this._y = 0; this.width = 100; this.height = 100; this.opacity = 1; this.parent = null; }
  get x() { return this._x; } set x(v) { checkNum(v, this.name + '.x'); this._x = v; }
  get y() { return this._y; } set y(v) { checkNum(v, this.name + '.y'); this._y = v; }
  appendChild(c) { if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c); c.parent = this; this.children.push(c); }
  resize(w, h) { if (w < 0.01 || h < 0.01) fail(`${this.name}: resize too small ${w}x${h}`); this.width = w; this.height = h; }
  resizeWithoutConstraints(w, h) { this.resize(w, h); }
  rescale(s) { this.width *= s; this.height *= s; }
}
const ENUMS = {
  layoutMode: ['NONE', 'HORIZONTAL', 'VERTICAL'], primaryAxisSizingMode: ['FIXED', 'AUTO'], counterAxisSizingMode: ['FIXED', 'AUTO'],
  primaryAxisAlignItems: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'], counterAxisAlignItems: ['MIN', 'CENTER', 'MAX', 'BASELINE'],
  layoutWrap: ['NO_WRAP', 'WRAP'], layoutAlign: ['INHERIT', 'STRETCH', 'MIN', 'CENTER', 'MAX'], layoutPositioning: ['AUTO', 'ABSOLUTE'],
};
for (const [prop, vals] of Object.entries(ENUMS)) {
  Object.defineProperty(BaseNode.prototype, prop, {
    get() { return this['_' + prop] || vals[0]; },
    set(v) {
      if (!vals.includes(v)) fail(`${this.name}.${prop} = ${v}`);
      if (prop === 'layoutPositioning' && v === 'ABSOLUTE' && !(this.parent && this.parent.layoutMode !== 'NONE')) fail('absolute child outside auto layout');
      if (prop === 'layoutWrap' && v === 'WRAP' && this.layoutMode !== 'HORIZONTAL') fail('wrap needs horizontal');
      this['_' + prop] = v;
    },
  });
}
for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
  Object.defineProperty(BaseNode.prototype, prop, {
    get() { return this['_' + prop] || 0; },
    set(v) { checkNum(v, prop); if (v < 0) fail(`${this.name}.${prop} negative ${v}`); this['_' + prop] = v; },
  });
}
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
BaseNode.prototype.exportAsync = async function (opts) {
  if (!opts || opts.format !== 'PNG' || !opts.constraint || !(opts.constraint.value > 0)) fail('bad export settings');
  return new Uint8Array(TINY_PNG);
};
class FrameNode extends BaseNode {
  constructor() { super('FRAME'); this._fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; this.strokes = []; this._effects = []; this.clipsContent = true; this.strokeWeight = 1; }
  get fills() { return this._fills; } set fills(v) { checkPaints(v, this.name + '.fills'); this._fills = v; }
  get effects() { return this._effects; }
  set effects(v) {
    for (const e of v) {
      if (/SHADOW/.test(e.type)) {
        checkColor(e.color, true, this.name + ' shadow');
        const req = ['type', 'color', 'offset', 'radius', 'visible', 'blendMode'];
        for (const k of req) if (!(k in e)) fail(`${this.name}: shadow missing ${k}`);
      } else if (!/BLUR/.test(e.type)) fail('bad effect');
    }
    this._effects = v;
  }
}
const WIDEN_K = process.env.WIDEN ? 1.06 : 1;
class TextNode extends BaseNode {
  constructor() { super('TEXT'); this._chars = ''; this.ranges = []; this._font = null; this._tar = 'NONE'; this.textAlignHorizontal = 'LEFT'; this.textAlignVertical = 'TOP'; }
  // Imitate Figma's text engine: hugging text takes its natural width; fixed-width text wraps if too narrow.
  get textAutoResize() { return this._tar; }
  set textAutoResize(v) { this._tar = v; this._reflow(); }
  resize(w, h) { super.resize(w, h); this._reflow(); }
  _reflow() {
    if (!this._nw) return;
    if (this._tar === 'WIDTH_AND_HEIGHT' && this._lines === 1) { this.width = this._nw; this.height = this._bh; }
    else if (this._tar === 'HEIGHT' && this._lines === 1) { this.height = this._bh * (this._nw > this.width + 0.5 ? 2 : 1); }
  }
  get fontName() { return this._font; }
  set fontName(f) { if (!loaded.has(f.family + '/' + f.style)) fail(`font not loaded: ${f.family} ${f.style}`); this._font = f; }
  get characters() { return this._chars; }
  set characters(s) { if (!this._font) fail('characters before font'); this._chars = s; this.name = s.slice(0, 40); }
  _range(s, e, k, v) {
    if (!(s >= 0 && e <= this._chars.length && s < e)) fail(`bad range ${s}-${e} of ${this._chars.length}`);
    this.ranges.push({ s, e, k, v });
  }
  setRangeFontName(s, e, f) { if (!loaded.has(f.family + '/' + f.style)) fail(`range font not loaded: ${f.family} ${f.style}`); this._range(s, e, 'font', f); }
  setRangeFontSize(s, e, v) { checkNum(v, 'fontSize'); this._range(s, e, 'size', v); }
  setRangeFills(s, e, v) { checkPaints(v, 'text fills'); this._range(s, e, 'fills', v); }
  setRangeLineHeight(s, e, v) { this._range(s, e, 'lh', v); }
  setRangeLetterSpacing(s, e, v) { this._range(s, e, 'ls', v); }
  setRangeTextDecoration(s, e, v) { this._range(s, e, 'deco', v); }
  setRangeTextCase(s, e, v) { this._range(s, e, 'case', v); }
  setRangeHyperlink(s, e, v) { this._range(s, e, 'link', v); }
}
class SvgNode extends FrameNode { constructor(svg) { super(); this.svg = svg; this._fills = []; } }

const page = new BaseNode('PAGE');
page.name = 'Landing v2';
const figma = {
  showUI() {},
  clientStorage: { _s: {}, async getAsync(k) { return this._s[k]; }, async setAsync(k, v) { this._s[k] = v; } },
  ui: { postMessage(m) { if (MESSAGE_MODE) posted.push(m); else if (m.type !== 'progress') console.log('[ui]', m.type, m.text); }, onmessage: null },
  root: { name: 'Acme — Marketing site' }, fileKey: 'AbC123TestKey', on() {},
  base64Encode(bytes) { return Buffer.from(bytes).toString('base64'); },
  notify(m) { console.log('[notify]', m); },
  currentPage: page,
  viewport: { scrollAndZoomIntoView() {} },
  async listAvailableFontsAsync() {
    return Object.entries(FONTS).flatMap(([family, styles]) => styles.map((style) => ({ fontName: { family, style } })));
  },
  async loadFontAsync(f) {
    if (!FONTS[f.family] || !FONTS[f.family].includes(f.style)) throw new Error('no such font ' + f.family + ' ' + f.style);
    loaded.add(f.family + '/' + f.style);
  },
  createFrame() { return new FrameNode(); },
  createText() {
    // Stand in for Figma's text measurement: use the size the browser measured, in build order.
    const t = new TextNode(); const sz = textSizes.shift();
    if (sz) { t.width = sz[0]; t.height = sz[1]; t._lines = sz[2]; t._bh = sz[1]; t._nw = (sz[3] || sz[0]) * WIDEN_K; }
    return t;
  },
  createImage(bytes) {
    if (!(bytes instanceof Uint8Array)) fail('createImage needs Uint8Array');
    const sig = bytes.slice(0, 4).toString('hex');
    if (!/^89504e47|^ffd8ff|^47494638/.test(Buffer.from(bytes.slice(0, 4)).toString('hex'))) fail('createImage: unsupported format ' + sig);
    const hash = crypto.createHash('sha1').update(bytes).digest('hex');
    images[hash] = Buffer.from(bytes);
    return { hash };
  },
  createNodeFromSvg(svg) {
    if (!/^<svg/.test(svg.trim())) fail('not svg');
    const n = new SvgNode(svg);
    const w = svg.match(/<svg[^>]*\swidth="([\d.]+)"/), h = svg.match(/<svg[^>]*\sheight="([\d.]+)"/);
    n.width = w ? +w[1] : 100; n.height = h ? +h[1] : 100;
    return n;
  },
};

const code = fs.readFileSync(path.join(__dirname, '..', 'code.js'), 'utf8');
const sandbox = { figma, __html__: '', console, setTimeout, Promise };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const textSizes = [];
if (!MESSAGE_MODE) (function collect(n) { if (n.type === 'text' && n.segments.some((sg) => sg.text.length)) textSizes.push([n.w, n.h, n.lines || 0, n.natW]); (n.children || []).forEach(collect); })(tree.root);
const imgBytes = {};
for (const [id, b64] of Object.entries(tree.images)) imgBytes[id] = new Uint8Array(Buffer.from(b64, 'base64'));

if (MESSAGE_MODE) {
  (async () => {
    for (const pg of incoming.pages) {
      const imgs = {}; for (const [id, b64] of Object.entries(pg.images || {})) imgs[id] = new Uint8Array(Buffer.from(b64, 'base64'));
      pg.images = imgs;
    }
    // text sizes for every page, in build order
    for (const pg of incoming.pages) (function collect(n) { if (n.type === 'text' && n.segments.some((sg) => sg.text.length)) textSizes.push([n.w, n.h, n.lines || 0, n.natW]); (n.children || []).forEach(collect); })(pg.root);
    await figma.ui.onmessage(incoming);
    process.stdout.write(JSON.stringify({ posted, problems }) + '\n');
  })().catch((e) => { process.stdout.write(JSON.stringify({ posted, problems, crash: String(e && e.stack || e) }) + '\n'); });
} else (async () => {
  await figma.ui.onmessage({ type: 'import', pages: [{ root: tree.root, images: imgBytes }] });
  const root = page.children[0];
  const count = (n) => 1 + n.children.reduce((a, c) => a + count(c), 0);
  console.log('nodes built:', count(root), 'problems:', problems.length);
  problems.slice(0, 20).forEach((p) => console.log('  !', p));
  const alFrames = []; const findAL = (n) => { if (n.layoutMode && n.layoutMode !== 'NONE') alFrames.push(n); n.children.forEach(findAL); }; findAL(root);
  // Remember importer-intended geometry, re-run Figma-style layout, and report drift.
  const intended = new Map(); const rec = (n, ox, oy) => { intended.set(n, [n.x + ox, n.y + oy, n.width, n.height]); n.children.forEach((c) => rec(c, n.x + ox, n.y + oy)); }; rec(root, 0, 0);
  hugSize(root); place(root);
  let drift = 0, worst = [];
  const chk = (n, ox, oy) => { const [ix, iy, iw, ih] = intended.get(n); const d = Math.max(Math.abs(n.x + ox - ix), Math.abs(n.y + oy - iy), Math.abs(n.width - iw), Math.abs(n.height - ih)); if (d > 1.5) { drift++; worst.push([d.toFixed(1), n.name, n.parent && n.parent.name]); } n.children.forEach((c) => chk(c, n.x + ox, n.y + oy)); };
  chk(root, 0, 0);
  console.log('auto layout frames:', alFrames.length, 'nodes drifting >1.5px after layout:', drift);
  worst.sort((a, b) => b[0] - a[0]).slice(0, 8).forEach((w) => console.log('   drift', w.join(' | ')));
  fs.writeFileSync(outPath, renderHtml(root));
})().catch((e) => { console.error(e); process.exit(1); });


/* ---------- independent Figma Auto Layout engine (for verification) ---------- */
const isAL = (n) => n.layoutMode && n.layoutMode !== 'NONE';
const flowKids = (n) => n.children.filter((c) => c.layoutPositioning !== 'ABSOLUTE');
function hugSize(n) {
  n.children.forEach(hugSize);
  if (!isAL(n)) return;
  const H = n.layoutMode === 'HORIZONTAL';
  const kids = flowKids(n);
  const pm = H ? n.paddingLeft + n.paddingRight : n.paddingTop + n.paddingBottom;
  const pc = H ? n.paddingTop + n.paddingBottom : n.paddingLeft + n.paddingRight;
  const main = (c) => (H ? c.width : c.height), cross = (c) => (H ? c.height : c.width);
  if (n.primaryAxisSizingMode === 'AUTO' && n.layoutWrap !== 'WRAP') {
    const v = pm + kids.reduce((a, c) => a + main(c), 0) + n.itemSpacing * Math.max(0, kids.length - 1);
    if (H) n.width = v; else n.height = v;
  }
  if (n.counterAxisSizingMode === 'AUTO') {
    let v;
    if (n.layoutWrap === 'WRAP') v = pc + rowsOf(n).reduce((a, r) => a + r.h, 0) + n.counterAxisSpacing * (rowsOf(n).length - 1);
    else v = pc + Math.max(0, ...kids.filter((c) => c.layoutAlign !== 'STRETCH').map(cross));
    if (H) n.height = v; else n.width = v;
  }
}
function rowsOf(n) {
  const inner = n.width - n.paddingLeft - n.paddingRight, rows = [];
  let cur = null;
  for (const c of flowKids(n)) {
    if (!cur || (cur.items.length && cur.used + n.itemSpacing + c.width > inner + 0.01)) { cur = { items: [], used: -n.itemSpacing, h: 0 }; rows.push(cur); }
    cur.items.push(c); cur.used += n.itemSpacing + c.width; cur.h = Math.max(cur.h, c.height);
  }
  return rows;
}
function place(n) {
  if (isAL(n)) {
    const H = n.layoutMode === 'HORIZONTAL';
    const kids = flowKids(n);
    const P = H ? [n.paddingLeft, n.paddingRight, n.paddingTop, n.paddingBottom] : [n.paddingTop, n.paddingBottom, n.paddingLeft, n.paddingRight];
    const innerM = (H ? n.width : n.height) - P[0] - P[1], innerC = (H ? n.height : n.width) - P[2] - P[3];
    const setM = (c, v) => { if (H) c.width = v; else c.height = v; }, setC = (c, v) => { if (H) c.height = v; else c.width = v; };
    const getM = (c) => (H ? c.width : c.height), getC = (c) => (H ? c.height : c.width);
    const setPos = (c, m, cr) => { if (H) { c.x = m; c.y = cr; } else { c.y = m; c.x = cr; } };
    const lines = n.layoutWrap === 'WRAP' ? rowsOf(n) : [{ items: kids }];
    let crossCursor = P[2];
    for (const line of lines) {
      const growers = line.items.filter((c) => c.layoutGrow === 1);
      const fixed = line.items.filter((c) => c.layoutGrow !== 1).reduce((a, c) => a + getM(c), 0);
      const gapsTotal = n.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 0 : n.itemSpacing * (line.items.length - 1);
      growers.forEach((c) => setM(c, (innerM - fixed - gapsTotal) / growers.length));
      if (n.layoutWrap !== 'WRAP') line.items.forEach((c) => { if (c.layoutAlign === 'STRETCH') { setC(c, innerC); if (c instanceof TextNode && c._lines === 1 && c._nw > c.width + 0.5) c.height = c._bh * 2; } });
      const total = line.items.reduce((a, c) => a + getM(c), 0);
      let gap = n.itemSpacing, cursor = P[0];
      if (n.primaryAxisAlignItems === 'SPACE_BETWEEN') gap = line.items.length > 1 ? (innerM - total) / (line.items.length - 1) : 0;
      else { const used = total + gap * (line.items.length - 1); if (n.primaryAxisAlignItems === 'CENTER') cursor += (innerM - used) / 2; if (n.primaryAxisAlignItems === 'MAX') cursor += innerM - used; }
      const lineC = n.layoutWrap === 'WRAP' ? Math.max(...line.items.map(getC)) : innerC;
      for (const c of line.items) {
        const free = lineC - getC(c);
        const off = n.counterAxisAlignItems === 'CENTER' ? free / 2 : n.counterAxisAlignItems === 'MAX' ? free : 0;
        if (n.counterAxisAlignItems === 'BASELINE') { if (H) c.x = cursor; else c.y = cursor; }
        else setPos(c, cursor, crossCursor + off);
        cursor += getM(c) + gap;
      }
      crossCursor += lineC + (n.counterAxisSpacing || 0);
    }
  }
  n.children.forEach(place);
}

/* ---------- render the Figma node tree back to HTML ---------- */
function css(c, a = 1) { return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${(c.a == null ? 1 : c.a) * a})`; }
function invert(t) {
  const [[a, b, c], [d, e, f]] = t; const det = a * e - b * d;
  return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det]];
}
const apply = (m, x, y) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
function paintCss(p, w, h) {
  if (p.type === 'SOLID') { const c = css(p.color, p.opacity == null ? 1 : p.opacity); return `linear-gradient(${c},${c})`; }
  if (p.type === 'IMAGE') return `url(data:image;base64,${images[p.imageHash].toString('base64')})`;
  const stops = (pos) => p.gradientStops.map((s) => `${css(s.color)} ${(pos(s.position) * 100).toFixed(2)}%`).join(',');
  if (p.type === 'GRADIENT_LINEAR') {
    const inv = invert(p.gradientTransform);
    const [sx, sy] = apply(inv, 0, 0.5), [ex, ey] = apply(inv, 1, 0.5);
    const dx = (ex - sx) * w, dy = (ey - sy) * h;
    const ang = Math.atan2(dx, -dy);
    const L = Math.abs(w * Math.sin(ang)) + Math.abs(h * Math.cos(ang));
    const len = Math.hypot(dx, dy);
    // project handle start onto CSS gradient line (centered on box)
    const ux = Math.sin(ang), uy = -Math.cos(ang);
    const t0 = ((sx * w - w / 2) * ux + (sy * h - h / 2) * uy) / L + 0.5;
    return `linear-gradient(${(ang * 180 / Math.PI).toFixed(2)}deg,${stops((q) => t0 + q * len / L)})`;
  }
  if (p.type === 'GRADIENT_RADIAL') return `radial-gradient(farthest-corner,${stops((q) => q)})`;
  return `conic-gradient(${stops((q) => q)})`;
}
function bgSize(p) { return p.type === 'IMAGE' ? (p.scaleMode === 'FIT' ? 'contain' : p.scaleMode === 'TILE' ? 'auto' : 'cover') : '100% 100%'; }
const WEIGHTS = { 'Thin': 100, 'Extra Light': 200, 'Light': 300, 'Regular': 400, 'Medium': 500, 'Semi Bold': 600, 'Bold': 700, 'Extra Bold': 800, 'Black': 900 };
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function renderHtml(root) {
  // WIDEN=1 imitates Figma drawing the font slightly wider than the browser did.
  const widen = process.env.WIDEN ? '.t span{letter-spacing:var(--wls)!important}' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}div,span{box-sizing:border-box}${widen}</style></head><body>${renderNode(root)}</body></html>`;
}
function renderNode(n) {
  const base = `position:absolute;left:${n.x}px;top:${n.y}px;opacity:${n.opacity};`;
  if (n instanceof SvgNode) return `<div style="${base}width:${n.width}px;height:${n.height}px">${n.svg}</div>`;
  if (n.type === 'TEXT') {
    const st = [base];
    if (n.textAutoResize === 'WIDTH_AND_HEIGHT' || n.maxLines === 1) st.push(`white-space:pre;${n.maxLines === 1 ? 'text-overflow:ellipsis;' : ''}`);
    else st.push(`width:${n.width}px;white-space:pre-wrap;overflow-wrap:break-word;`);
    if (n.textAutoResize === 'NONE') st.push(`height:${n.height}px;display:flex;flex-direction:column;justify-content:${n.textAlignVertical === 'CENTER' ? 'center' : 'flex-start'};overflow:hidden;`);
    st.push(`text-align:${{ LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[n.textAlignHorizontal]};`);
    // split characters by range boundaries
    const cuts = new Set([0, n.characters.length]); n.ranges.forEach((r) => { cuts.add(r.s); cuts.add(r.e); });
    const pts = [...cuts].sort((a, b) => a - b);
    let html = '';
    const firstLh = n.ranges.find((r) => r.k === 'lh');
    for (let i = 0; i < pts.length - 1; i++) {
      const s = pts[i], e = pts[i + 1];
      const props = {}; n.ranges.forEach((r) => { if (r.s <= s && r.e >= e) props[r.k] = r.v; });
      const f = props.font || n.fontName;
      const sty = [`font-family:'${f.family}';font-weight:${WEIGHTS[f.style.replace(' Italic', '').replace('Italic', 'Regular')] || 400};font-style:${/Italic/.test(f.style) ? 'italic' : 'normal'}`,
        `font-size:${props.size}px`];
      if (props.lh && props.lh.unit === 'PIXELS') sty.push(`line-height:${props.lh.value}px`); else sty.push('line-height:normal');
      if (props.ls) sty.push(`letter-spacing:${props.ls.value}px`);
      if (props.deco) sty.push(`text-decoration:${props.deco === 'UNDERLINE' ? 'underline' : 'line-through'}`);
      if (props.case) sty.push(`text-transform:${{ UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[props.case]}`);
      const fill = props.fills && props.fills[0];
      if (fill && fill.type === 'SOLID') sty.push(`color:${css(fill.color, fill.opacity)}`);
      else if (fill) sty.push(`background:${paintCss(fill, n.width, n.height)};-webkit-background-clip:text;color:transparent`);
      html += `<span style="${sty.join(';')}">${esc(n.characters.slice(s, e))}</span>`;
    }
    const firstSize = n.ranges.find((r) => r.k === 'size');
    const lh = (firstLh && firstLh.v.unit === 'PIXELS' ? `line-height:${firstLh.v.value}px;` : 'line-height:normal;') + `font-size:${firstSize ? firstSize.v : 16}px;font-family:'${n.fontName.family}';`;
    // Widen the drawn text by exactly as much as the layer grew (natural width × 1.06).
    const wls = n._nw ? ((n._nw - n._nw / WIDEN_K) / Math.max(1, n.characters.replace(/\n/g, '').length / Math.max(1, n._lines || 1))) : 0;
    st.push(`--wls:${wls.toFixed(3)}px;`);
    return `<div class="t" data-lines="${n._lines || 0}" data-bh="${n._bh || 0}" data-chars="${esc(n.characters).replace(/"/g, '&quot;')}" data-fs="${firstSize ? firstSize.v : 16}" style="${st.join('')}${lh}">${n.textAutoResize === 'NONE' ? `<div>${html}</div>` : html}</div>`;
  }
  const st = [base, `width:${n.width}px;height:${n.height}px;`];
  const fills = n.fills.slice().reverse();
  if (fills.length) { st.push(`background:${fills.map((p) => paintCss(p, n.width, n.height) + (p.type === 'IMAGE' ? ' center/' + bgSize(p) + (p.scaleMode === 'TILE' ? ' repeat' : ' no-repeat') : '')).join(',')};`); }
  if (n.strokes && n.strokes.length) {
    const c = css(n.strokes[0].color, n.strokes[0].opacity);
    const sides = n.strokeTopWeight != null ? [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight] : [n.strokeWeight, n.strokeWeight, n.strokeWeight, n.strokeWeight];
    st.push(`border-style:${n.dashPattern ? 'dashed' : 'solid'};border-color:${c};border-width:${sides.map((s) => s + 'px').join(' ')};`);
  }
  if (n.topLeftRadius != null) st.push(`border-radius:${n.topLeftRadius}px ${n.topRightRadius}px ${n.bottomRightRadius}px ${n.bottomLeftRadius}px;`);
  const shadows = n.effects.filter((e) => /SHADOW/.test(e.type)).reverse().map((e) => `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.offset.x}px ${e.offset.y}px ${e.radius}px ${e.spread}px ${css(e.color)}`);
  if (shadows.length) st.push(`box-shadow:${shadows.join(',')};`);
  if (n.clipsContent) st.push('overflow:hidden;');
  return `<div title="${esc(n.name)}" style="${st.join('')}">${n.children.map(renderNode).join('')}</div>`;
}
