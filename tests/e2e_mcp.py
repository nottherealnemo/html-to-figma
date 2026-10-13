"""End-to-end: MCP client -> MCP server (stdio) -> WebSocket -> plugin UI (sandboxed, null origin,
like Figma) -> main thread (code.js in the strict mock) -> back to the MCP client."""
import json, os, re, queue, subprocess, sys, tempfile, threading, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_VERSION = re.search(r"PLUGIN_VERSION = '([\d.]+)'", open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'code.js')).read()).group(1)
PLUGIN = os.path.abspath(os.path.join(HERE, '..'))
SERVER = os.path.join(PLUGIN, 'mcp-server', 'html-to-figma-mcp.mjs')
PORT = '3155'

srv = subprocess.Popen(['node', SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       env={**os.environ, 'HTML_TO_FIGMA_PORT': PORT}, text=True, bufsize=1)
out_q, err_lines = queue.Queue(), []
threading.Thread(target=lambda: [out_q.put(json.loads(l)) for l in srv.stdout], daemon=True).start()
threading.Thread(target=lambda: [err_lines.append(l.rstrip()) for l in srv.stderr], daemon=True).start()

seq = 0
def rpc(method, params=None, pump=None, timeout=120):
    global seq
    seq += 1; my = seq
    srv.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': my, 'method': method, 'params': params or {}}) + '\n'); srv.stdin.flush()
    t0, progress = time.time(), []
    while time.time() - t0 < timeout:
        try: m = out_q.get(timeout=0.05)
        except queue.Empty:
            if pump: pump()
            continue
        if m.get('method') == 'notifications/progress': progress.append(m['params']['message']); continue
        if m.get('id') == my: return m, progress
    raise TimeoutError(method)

def notify(method):
    srv.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': method}) + '\n'); srv.stdin.flush()

def text_of(res): return '\n'.join(c['text'] for c in res['result']['content'] if c['type'] == 'text')

# --- MCP handshake ---
init, _ = rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'e2e', 'version': '1'}})
print('initialize ->', init['result']['protocolVersion'], init['result']['serverInfo'])
notify('notifications/initialized')
tools, _ = rpc('tools/list')
print('tools ->', [t['name'] for t in tools['result']['tools']])
st, _ = rpc('tools/call', {'name': 'figma_bridge_status', 'arguments': {}})
print('status before plugin ->', text_of(st).splitlines()[1][:60])
bad, _ = rpc('tools/call', {'name': 'import_html_to_figma', 'arguments': {'html': '<p>x</p>'}}, timeout=10)
print('import before plugin -> isError', bad['result'].get('isError'), '|', text_of(bad)[:70])

# --- a fake WebSocket client with a real web origin must be refused ---
import socket, base64
s = socket.create_connection(('127.0.0.1', int(PORT)))
s.send(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: https://evil.example\r\n'
        'Sec-WebSocket-Key: ' + base64.b64encode(os.urandom(16)).decode() + '\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
print('foreign origin ->', s.recv(100).decode().splitlines()[0]); s.close()

# --- Figma stand-in: host page + sandboxed plugin UI ---
host = os.path.join(HERE, 'out', 'host.html')
open(host, 'w').write(f"""<!doctype html><body>
<iframe id="ui" sandbox="allow-scripts" src="file://{PLUGIN}/ui.html" style="width:340px;height:640px"></iframe>
<script>
const ui = document.getElementById('ui');
const toB64 = (u8) => {{ let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }};
ui.onload = () => {{
  ui.contentWindow.postMessage({{ pluginMessage: {{ type: 'settings', value: {{ optPort: '{PORT}', optBridge: true }} }} }}, '*');
  ui.contentWindow.postMessage({{ pluginMessage: {{ type: 'file-info', info: {{ fileName: 'Acme — Marketing site', page: 'Landing v2' }} }} }}, '*');
  ui.contentWindow.postMessage({{ pluginMessage: {{ type: 'version', version: new URLSearchParams(location.search).get('pv') || '{PLUGIN_VERSION}' }} }}, '*');
}};
window.addEventListener('message', async (e) => {{
  if (e.source !== ui.contentWindow) return;
  const m = e.data && e.data.pluginMessage; if (!m || m.type !== 'import') return;
  for (const p of m.pages) {{ const imgs = {{}}; for (const [k, v] of Object.entries(p.images || {{}})) imgs[k] = toB64(v); p.images = imgs; }}
  const reply = JSON.parse(await window.runMain(JSON.stringify(m)));
  window.__problems = reply.problems; window.__crash = reply.crash;
  for (const msg of reply.posted) ui.contentWindow.postMessage({{ pluginMessage: msg }}, '*');
}});
</script></body>""")

def run_main(msg_json):
    f = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False); f.write(msg_json); f.close()
    return subprocess.run(['node', os.path.join(HERE, 'mock-figma.js'), '--message', f.name], capture_output=True, text=True).stdout.strip().splitlines()[-1]

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.expose_function('runMain', run_main)
    pg.goto('file://' + host)
    pump = lambda: pg.wait_for_timeout(50)
    t0 = time.time()
    while not any('plugin connected' in l for l in err_lines) and time.time() - t0 < 15: pump()
    print('plugin connected ->', any('plugin connected' in l for l in err_lines))
    st, _ = rpc('tools/call', {'name': 'figma_bridge_status', 'arguments': {}}, pump=pump)
    print('status ->', ' | '.join(text_of(st).splitlines()[1:]))

    res, prog = rpc('tools/call', {'name': 'import_html_to_figma', '_meta': {'progressToken': 7},
        'arguments': {'path': os.path.join(HERE, 'pages', 'site', 'index.html'), 'devices': ['desktop', 'mobile'], 'auto_layout': 'flex'}}, pump=pump)
    r = res['result']
    print('import isError ->', r.get('isError', False))
    print(text_of(res))
    print('images returned ->', sum(1 for c in r['content'] if c['type'] == 'image'))
    print('progress ->', prog[:3], '…', prog[-1:] if prog else '')

    res2, _ = rpc('tools/call', {'name': 'import_html_to_figma', 'arguments': {'html': open(os.path.join(HERE, 'pages', 'poster', 'index.html')).read(), 'devices': ['canvas'], 'preview': False}}, pump=pump)
    print('canvas from html ->', text_of(res2).splitlines()[1])

    # --- HTML sent as code (the AI's files are not on this computer) ---
    site = os.path.join(HERE, 'pages', 'site')
    def layers(t): return t.split('layers created')[0].split('\n')[-1].strip()
    path_layers = layers(text_of(res))
    tools_now = [t['name'] for t in rpc('tools/list')[0]['result']['tools']]
    print('upload tool listed ->', 'upload_file_for_import' in tools_now)
    html = open(os.path.join(site, 'index.html')).read()
    up_id = None
    for i in range(0, len(html), 1000):  # long HTML in parts
        a = {'file_name': 'index.html', 'content': html[i:i + 1000], 'append': i > 0}
        if up_id: a['upload_id'] = up_id
        r, _ = rpc('tools/call', {'name': 'upload_file_for_import', 'arguments': a})
        up_id = text_of(r).split('upload_id: ')[1].split()[0]
    rpc('tools/call', {'name': 'upload_file_for_import', 'arguments': {'upload_id': up_id, 'file_name': 'css/style.css', 'content': open(os.path.join(site, 'css', 'style.css')).read()}})
    assets = {}
    for f in os.listdir(os.path.join(site, 'img')):
        raw = open(os.path.join(site, 'img', f), 'rb').read()
        if f.endswith('.svg'): assets['img/' + f] = raw.decode()
        else:
            assets['img/' + f] = 'data:image/' + {'jpg': 'jpeg'}.get(f.rsplit('.', 1)[1], f.rsplit('.', 1)[1]) + ';base64,' + base64.b64encode(raw).decode()
        rpc('tools/call', {'name': 'upload_file_for_import', 'arguments': {'upload_id': up_id, 'file_name': 'img/' + f,
            'content': base64.b64encode(raw).decode(), 'encoding': 'base64'}})
    r, _ = rpc('tools/call', {'name': 'import_html_to_figma', 'arguments': {'upload_id': up_id, 'devices': ['desktop', 'mobile'], 'preview': False}}, pump=pump)
    print('upload import ->', r['result'].get('isError', False), '|', text_of(r).splitlines()[0])
    print('upload layers match path import ->', layers(text_of(r)) == path_layers, layers(text_of(r)), path_layers)
    assets['css/style.css'] = open(os.path.join(site, 'css', 'style.css')).read()
    r, _ = rpc('tools/call', {'name': 'import_html_to_figma', 'arguments': {'html': html, 'files': assets, 'devices': ['desktop', 'mobile'], 'preview': False}}, pump=pump)
    print('html+files import ->', r['result'].get('isError', False), '|', text_of(r).splitlines()[0])
    print('html+files layers match path import ->', layers(text_of(r)) == path_layers)
    import http.server, functools
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(HERE, 'pages')))
    httpd.RequestHandlerClass.log_message = lambda *a: None
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    r, _ = rpc('tools/call', {'name': 'import_html_to_figma', 'arguments': {'url': f'http://127.0.0.1:{httpd.server_port}/site/index.html', 'devices': ['desktop', 'mobile'], 'preview': False}}, pump=pump)
    print('url import ->', r['result'].get('isError', False), '|', text_of(r).splitlines()[0])
    print('url layers match path import ->', layers(text_of(r)) == path_layers, layers(text_of(r)))
    httpd.shutdown()
    r, _ = rpc('tools/call', {'name': 'import_html_to_figma', 'arguments': {'path': '/home/sandbox/not-here/page.html'}})
    print('missing path hint ->', 'upload_file_for_import' in text_of(r))
    print('mock problems ->', pg.evaluate('window.__problems'), pg.evaluate('window.__crash'), '| page errors ->', errs)
    fr = pg.frame_locator('#ui')
    print('header version ->', fr.locator('#ver').inner_text(), '| pill ->', fr.locator('#bridgePill').inner_text())
    pg.screenshot(path=os.path.join(HERE, 'out', 'host.png'))
    # Simulate an older plugin talking to this server: the pill should ask for an update.
    pg.goto('file://' + host + '?pv=0.9.0'); t0 = time.time()
    while time.time() - t0 < 6: pump()
    print('mismatch pill ->', fr.locator('#bridgePill').inner_text())
    st, _ = rpc('tools/call', {'name': 'figma_bridge_status', 'arguments': {}}, pump=pump)
    print('mismatch status ->', ' | '.join(text_of(st).splitlines()[1:]))
    b.close()
srv.terminate()
