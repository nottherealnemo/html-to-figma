import base64, json, os, sys
from playwright.sync_api import sync_playwright
UI = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'ui.html'))
JS = """
async ({files, entry, device, crop}) => {
  const map = new Map();
  for (const [k, b64] of Object.entries(files)) map.set(k, new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], k.split('/').pop()));
  const { Stage, Assets } = window.__H2F;
  const html = await Assets.inline(entry, map);
  const opts = { name: 'test', scripts: true, flatten: true, freeze: true, textMode: 'paragraph', autoLayout: (window.__AL || 'flex'), wait: 100, baseUrl: '',
    cropScreen: crop, sizes: { desktop: [1440, 900], tablet: [768, 1024], mobile: [390, 844] } };
  const page = await Stage.capture(html, device, opts);
  const images = {};
  for (const [id, bytes] of Object.entries(page.images)) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); images[id] = btoa(s); }
  return { root: page.root, images, stats: page.stats };
}"""
site, device, crop, out = sys.argv[1], sys.argv[2], sys.argv[3] == '1', sys.argv[4]
files = {}
for root, _, names in os.walk(site):
    for n in names:
        p = os.path.join(root, n); files[os.path.relpath(p, os.path.dirname(site.rstrip('/')))] = base64.b64encode(open(p, 'rb').read()).decode()
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('file://' + UI)
    pg.evaluate("window.__AL = '%s'" % os.environ.get('AL', 'flex'))
    r = pg.evaluate(JS, {'files': files, 'entry': os.path.basename(site.rstrip('/')) + '/index.html', 'device': device, 'crop': crop})
    json.dump(r, open(out, 'w'))
    R = r['root']; print(f"{site:6} {device:8} crop={int(crop)} -> '{R['name']}'  origin=({R['x']:.0f},{R['y']:.0f}) size={R['w']:.0f}x{R['h']:.0f}  AL={r['stats']['autoLayout']}", errs or '')
    b.close()
