"""Two AI apps at once: server A (hub) + server B (relay) -> plugin in a Figma-like sandbox -> mock main thread.
Then A exits and B must take over the port, with the plugin reconnecting on its own."""
import json, os, re, queue, subprocess, tempfile, threading, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_VERSION = re.search(r"PLUGIN_VERSION = '([\d.]+)'", open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'code.js')).read()).group(1)
PLUGIN = os.path.abspath(os.path.join(HERE, '..'))
SERVER = os.path.join(PLUGIN, 'mcp-server', 'html-to-figma-mcp.mjs')
PORT = '3177'

class Client:
    def __init__(self, name):
        self.name = name
        self.p = subprocess.Popen(['node', SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  env={**os.environ, 'HTML_TO_FIGMA_PORT': PORT}, text=True, bufsize=1)
        self.q, self.err, self.seq = queue.Queue(), [], 0
        threading.Thread(target=lambda: [self.q.put(json.loads(l)) for l in self.p.stdout], daemon=True).start()
        threading.Thread(target=lambda: [self.err.append(l.rstrip()) for l in self.p.stderr], daemon=True).start()
        self.rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': name, 'version': '1'}})
    def rpc(self, method, params=None, pump=None, timeout=120):
        self.seq += 1; my = self.seq
        self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': my, 'method': method, 'params': params or {}}) + '\n'); self.p.stdin.flush()
        t0 = time.time()
        while time.time() - t0 < timeout:
            try: m = self.q.get(timeout=0.05)
            except queue.Empty:
                if pump: pump()
                continue
            if m.get('id') == my: return m
        raise TimeoutError(method)
    def text(self, name, args=None, pump=None):
        r = self.rpc('tools/call', {'name': name, 'arguments': args or {}}, pump=pump)['result']
        return ('ERROR: ' if r.get('isError') else '') + '\n'.join(c['text'] for c in r['content'] if c['type'] == 'text')

A = Client('app-A'); time.sleep(0.5)
B = Client('app-B'); time.sleep(1.0)
print('A:', [l for l in A.err if 'bridge' in l][-1:])
print('B:', [l for l in B.err if 'bridge' in l or 'sharing' in l][-1:])

host = os.path.join(HERE, 'out', 'host-multi.html')
open(host, 'w').write(f"""<!doctype html><body style="margin:0">
<iframe id="ui" sandbox="allow-scripts" src="file://{PLUGIN}/ui.html" style="width:340px;height:760px;border:0"></iframe>
<script>
const ui = document.getElementById('ui');
const toB64 = (u8) => {{ let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }};
ui.onload = () => {{
  ui.contentWindow.postMessage({{ pluginMessage: {{ type: 'settings', value: {{ optPort: '{PORT}', optBridge: true }} }} }}, '*');
}};
window.addEventListener('message', async (e) => {{
  if (e.source !== ui.contentWindow) return;
  const m = e.data && e.data.pluginMessage; if (!m) return;
  if (m.type === 'get-file-info') {{
    ui.contentWindow.postMessage({{ pluginMessage: {{ type: 'file-info', info: {{ fileName: 'Acme — Marketing site', page: 'Landing v2' }} }} }}, '*');
    ui.contentWindow.postMessage({{ pluginMessage: {{ type: 'version', version: '{PLUGIN_VERSION}' }} }}, '*');
  }}
  if (m.type === 'save-settings') window.__saved = m.value;
  if (m.type !== 'import') return;
  for (const p of m.pages) {{ const imgs = {{}}; for (const [k, v] of Object.entries(p.images || {{}})) imgs[k] = toB64(v); p.images = imgs; }}
  const reply = JSON.parse(await window.runMain(JSON.stringify(m)));
  for (const msg of reply.posted) ui.contentWindow.postMessage({{ pluginMessage: msg }}, '*');
}});
</script></body>""")

def run_main(msg_json):
    f = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False); f.write(msg_json); f.close()
    return subprocess.run(['node', os.path.join(HERE, 'mock-figma.js'), '--message', f.name], capture_output=True, text=True).stdout.strip().splitlines()[-1]

poster = open(os.path.join(HERE, 'pages', 'poster', 'index.html')).read()
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 340, 'height': 760}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.expose_function('runMain', run_main)
    pg.goto('file://' + host)
    pump = lambda: pg.wait_for_timeout(50)
    fr = pg.frame_locator('#ui')
    t0 = time.time()
    while 'AI connected' not in fr.locator('#bridgePill').inner_text() and time.time() - t0 < 15: pump()
    print('pill:', fr.locator('#bridgePill').inner_text())

    print('\nstatus via B (relay):\n ', B.text('figma_bridge_status', pump=pump).replace('\n', '\n  '))
    print('\nimport via B:', B.text('import_html_to_figma', {'html': poster, 'devices': ['canvas'], 'preview': False}, pump=pump).splitlines()[1])
    print('import via A:', A.text('import_html_to_figma', {'html': poster, 'devices': ['mobile'], 'preview': False}, pump=pump).splitlines()[1])

    # Connect panel: path should be auto-filled from the server's welcome
    fr.locator('#openConnect').click(); pump()
    fr.locator('#connApp').select_option('cursor'); pump()
    print('\nconnect panel path:', fr.locator('#connServerPath').input_value())
    print('connect panel status:', fr.locator('#connStatus').inner_text())
    pg.screenshot(path=os.path.join(HERE, 'out', 'connect-panel.png'))
    fr.locator('#connApp').select_option('chatgpt'); pump()
    print('chatgpt snippet:\n ', fr.locator('#connSnippet').inner_text().replace('\n', '\n  '))
    fr.locator('#connBack').click()

    # A quits (its AI app closed): B should take over, the plugin should reconnect by itself.
    A.p.terminate(); A.p.wait()
    t0 = time.time()
    while not any('listening' in l for l in B.err) and time.time() - t0 < 10: pump()
    print('\nafter A quit, B:', [l for l in B.err if 'listening' in l][-1:])
    t0 = time.time()
    while time.time() - t0 < 8:
        pump()
        if 'connected' in B.text('figma_bridge_status', pump=pump).split('\n')[1]: break
    print('import via B after takeover:', B.text('import_html_to_figma', {'html': poster, 'devices': ['desktop'], 'preview': False}, pump=pump).splitlines()[1])
    print('page errors:', errs)
    b.close()
B.p.terminate()
