"""Run the plugin's real UI extractor in headless Chromium and dump the layer tree.

usage: python3 extract.py <site_dir> <entry.html> <out.json> [width] [textMode]
"""
import base64, json, os, sys
from playwright.sync_api import sync_playwright

site, entry, out = sys.argv[1], sys.argv[2], sys.argv[3]
width = int(sys.argv[4]) if len(sys.argv) > 4 else 1440
text_mode = sys.argv[5] if len(sys.argv) > 5 else 'paragraph'
al_mode = sys.argv[6] if len(sys.argv) > 6 else 'flex'
UI = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'ui.html'))

files = {}
for root, _, names in os.walk(site):
    for n in names:
        p = os.path.join(root, n)
        rel = os.path.relpath(p, os.path.dirname(site.rstrip('/')))
        files[rel] = base64.b64encode(open(p, 'rb').read()).decode()
entry_rel = os.path.join(os.path.basename(site.rstrip('/')), entry)

JS = """
async ({files, entry, width, textMode, alMode}) => {
  const map = new Map();
  for (const [k, b64] of Object.entries(files)) {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    map.set(k, new File([bin], k.split('/').pop()));
  }
  const { Stage, Assets } = window.__H2F;
  const html = await Assets.inline(entry, map);
  const opts = { name: 'test', scripts: true, flatten: true, freeze: true, textMode, autoLayout: alMode, height: 900, wait: 200, baseUrl: '', width };
  const page = await Stage.capture(html, 'desktop', { ...opts, sizes: { desktop: [width, 900] } });
  const images = {};
  for (const [id, bytes] of Object.entries(page.images)) {
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    images[id] = btoa(s);
  }
  return { root: page.root, images, stats: page.stats };
}
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 400, 'height': 700})
    logs = []
    pg.on('console', lambda m: logs.append(m.type + ': ' + m.text))
    pg.on('pageerror', lambda e: logs.append('pageerror: ' + str(e)))
    pg.goto('file://' + UI)
    res = pg.evaluate(JS, {'files': files, 'entry': entry_rel, 'width': width, 'textMode': text_mode, 'alMode': al_mode})
    json.dump(res, open(out, 'w'))
    print('stats', res['stats'], 'images', len(res['images']))
    for l in logs: print(l)
    # Reference screenshot of the original page
    ref = b.new_page(viewport={'width': width, 'height': 900})
    ref.goto('file://' + os.path.abspath(os.path.join(site, entry)))
    ref.wait_for_timeout(300)
    ref.screenshot(path=out.replace('.json', '-reference.png'), full_page=True)
    b.close()
