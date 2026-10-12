// Estimate the size of Plugin-API code needed to draw a layer tree directly (as Claude would via use_figma),
// written compactly: shared helper functions + one call per layer with only its non-default properties.
const fs = require('fs');
const tree = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).root;
const r = (v) => Math.round(v * 10) / 10;
const col = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('') + (c.a < 1 ? Math.round(c.a * 100) : '');
const lines = [];
let id = 0, layers = 0, svgChars = 0;
function paint(p) {
  if (p.type === 'SOLID') return `"${col(p.color)}"`;
  if (p.type && p.type.startsWith('GRADIENT')) return `{g:"${p.type[9]}",a:${r(p.angle || 0)},s:[${p.stops.map((s) => `[${r(s.position)},"${col(s.color)}"]`).join(',')}]}`;
  return '"img"';
}
function emit(n, parent, ox, oy) {
  const v = 'n' + (id++); layers++;
  if (n.type === 'text') {
    const segs = n.segments.map((s) => `[${JSON.stringify(s.text)},"${s.style.families[0]}",${s.style.weight},${s.style.size},"${col(s.style.fill.color || { r: 0, g: 0, b: 0, a: 1 })}"${s.style.lineHeight ? ',' + r(s.style.lineHeight) : ''}]`);
    lines.push(`T(${parent},${r(n.x - ox)},${r(n.y - oy)},${n.autoWidth ? 0 : r(n.w)},[${segs.join(',')}]${n.align && n.align !== 'LEFT' ? `,"${n.align[0]}"` : ''});`);
    return;
  }
  if (n.type === 'svg') { svgChars += n.svg.length; lines.push(`S(${parent},${r(n.x - ox)},${r(n.y - oy)},${JSON.stringify(n.svg)});`); return; }
  const props = [];
  if (n.fills && n.fills.length) props.push(`f:[${n.fills.map(paint).join(',')}]`);
  if (n.strokes) props.push(`s:["${col(n.strokes.color)}",${r(n.strokes.top)}]`);
  if (n.radius && n.radius.some((x) => x)) props.push(`r:${n.radius.every((x) => x === n.radius[0]) ? r(n.radius[0]) : '[' + n.radius.map(r) + ']'}`);
  if (n.effects && n.effects.length) props.push(`e:[${n.effects.map((e) => `[${r(e.x || 0)},${r(e.y || 0)},${r(e.blur || e.radius || 0)},"${e.color ? col(e.color) : ''}"]`)}]`);
  if (n.clip) props.push('c:1');
  const al = n.autoLayout;
  if (al) props.push(`al:["${al.mode[0]}",${al.spacing},[${al.pad.map(r)}],"${al.justify}","${al.align}",${al.hugMain ? 1 : 0},${al.hugCross ? 1 : 0}${al.wrap ? ',' + al.counterSpacing : ''}]`);
  const lc = n.layoutChild;
  if (lc && (lc.grow || lc.stretch || lc.absolute)) props.push(`lc:"${lc.grow ? 'g' : ''}${lc.stretch ? 's' : ''}${lc.absolute ? 'a' : ''}"`);
  lines.push(`const ${v}=F(${parent},${JSON.stringify(n.name || '')},${r(n.x - ox)},${r(n.y - oy)},${r(n.w)},${r(n.h)},{${props.join(',')}});`);
  (n.children || []).forEach((c) => emit(c, v, n.x, n.y));
}
emit(tree, 'page', tree.x || 0, tree.y || 0);
// Helpers Claude would write once (font loading, frames, text, svg, auto layout)
const helpers = 1800;
const code = lines.join('\n');
console.log(JSON.stringify({ layers, codeChars: code.length + helpers, svgChars, nonSvgCodeChars: code.length + helpers - svgChars }));
