"""Run the whole HTML → Figma test suite. Exit code 0 = everything passed.

    python3 tests/run_tests.py            # full suite
    python3 tests/run_tests.py --quick    # skip the MCP end-to-end tests

Needs Node 18+, Python 3 and Playwright with Chromium (pip install playwright && playwright install chromium).

What it checks, for every test page and both Auto Layout modes:
  * the strict mock of the Figma API accepts every value the plugin sets (no API errors);
  * re-running Figma's Auto Layout reproduces the browser layout (small drift only);
  * the rebuilt design matches the original page pixel-for-pixel within a few percent;
  * with Figma drawing fonts 6% wider than the browser, no one-line text wraps.
Plus the MCP server: handshake, tools, import round trip, version warnings, several AI apps at once.
"""
import os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.chdir(HERE)
os.makedirs('out', exist_ok=True)

PAGES = [('site', 1440), ('flexy', 1100), ('js', 800), ('poster', 1440), ('tight', 1100), ('card', 900)]
MAX_PIXEL_DIFF = 3.0     # % of pixels
MAX_DRIFT_PX = 4.0       # worst single-layer drift after Figma re-runs Auto Layout

failures, rows = [], []

def run(cmd, env=None, timeout=600):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env={**os.environ, **(env or {})})
    return r.stdout + r.stderr

def check(ok, what):
    if not ok:
        failures.append(what)
    return ok

# 1. Syntax of every shipped script
for f in [os.path.join(ROOT, 'code.js'), os.path.join(ROOT, 'mcp-server', 'html-to-figma-mcp.mjs')]:
    check('SyntaxError' not in run(['node', '--check', f]), f'syntax: {os.path.basename(f)}')
ui = open(os.path.join(ROOT, 'ui.html')).read()
for i, block in enumerate(re.findall(r'<script[^>]*>(.*?)</script>', ui, re.S)):
    p = os.path.join('out', f'ui-script-{i}.js'); open(p, 'w').write(block)
    check('SyntaxError' not in run(['node', '--check', p]), f'syntax: ui.html script {i}')

# 2. Fidelity, Auto Layout and wrapping on every page
for page, width in PAGES:
    for mode in ('flex', 'all'):
        tag = f'{page}/{mode}'
        out = run(['python3', 'extract.py', f'pages/{page}', 'index.html', 'out/t.json', str(width), 'paragraph', mode])
        if not check('stats' in out, f'{tag}: extraction failed\n{out[-800:]}'):
            continue
        mock = run(['node', 'mock-figma.js', 'out/t.json', 'out/t.html'])
        problems = int(re.search(r'problems: (\d+)', mock).group(1)) if 'problems:' in mock else -1
        al = int(re.search(r'auto layout frames: (\d+)', mock).group(1)) if 'auto layout frames' in mock else 0
        drifts = [float(x) for x in re.findall(r'drift ([\d.]+) \|', mock)]
        shot = run(['python3', 'shot.py', 'out/t.html', 'out/t.png', 'out/t-reference.png', str(width)])
        m = re.search(r'\(([\d.]+)%\)', shot); pct = float(m.group(1)) if m else 100.0
        run(['node', 'mock-figma.js', 'out/t.json', 'out/tw.html'], env={'WIDEN': '1'})
        wc = run(['python3', 'wrapcheck.py', 'out/tw.html'])
        wrapped = int(re.search(r'labels: (\d+)', wc).group(1)) if 'labels:' in wc else -1
        ok = all([
            check(problems == 0, f'{tag}: {problems} Figma API problems\n{mock[-600:]}'),
            check(pct <= MAX_PIXEL_DIFF, f'{tag}: {pct}% pixels differ (max {MAX_PIXEL_DIFF}%)'),
            check(max(drifts or [0]) <= MAX_DRIFT_PX, f'{tag}: layer drifts {max(drifts or [0])}px after Auto Layout'),
            check(wrapped == 0, f'{tag}: {wrapped} one-line labels wrap with wider fonts: {wc.strip()}'),
        ])
        rows.append(f'{"PASS" if ok else "FAIL"}  {tag:<14} Auto Layout frames {al:>3}  pixels off {pct:>5.2f}%  '
                    f'max drift {max(drifts or [0]):.1f}px  wrapped {wrapped}')

# 3. MCP server end to end
if '--quick' not in sys.argv:
    e2e = run(['python3', 'e2e_mcp.py'], timeout=300)
    ok = all([
        check("'version': '" in e2e or 'initialize ->' in e2e, 'mcp: no handshake\n' + e2e[-800:]),
        check('import isError -> False' in e2e, 'mcp: import failed\n' + e2e[-800:]),
        check('403 Forbidden' in e2e, 'mcp: foreign origin was not refused'),
        check('mismatch pill -> Update MCP server' in e2e, 'mcp: version mismatch not shown'),
        check('page errors -> []' in e2e, 'mcp: page errors\n' + e2e[-800:]),
    ])
    rows.append(f'{"PASS" if ok else "FAIL"}  MCP round trip, origin check, version warning')
    multi = run(['python3', 'e2e_multi.py'], timeout=300)
    ok = all([
        check('import via B:' in multi and 'import via A:' in multi, 'mcp: two apps could not share\n' + multi[-800:]),
        check('import via B after takeover:' in multi and 'ERROR' not in multi, 'mcp: takeover failed\n' + multi[-800:]),
        check('page errors: []' in multi, 'mcp multi: page errors\n' + multi[-800:]),
    ])
    rows.append(f'{"PASS" if ok else "FAIL"}  MCP with two AI apps + takeover')

print('\n'.join(rows))
if failures:
    print(f'\n{len(failures)} failure(s):')
    for f in failures:
        print(' -', f)
        if os.environ.get('GITHUB_ACTIONS'):  # also show as annotations on the GitHub run
            print('::error title=Test failure::' + f.replace('%', '%25').replace('\r', '').replace('\n', '%0A')[:4000])
    sys.exit(1)
print('\nAll tests passed.')
