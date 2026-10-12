import sys, os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1200,'height':900}); pg.goto('file://'+os.path.abspath(sys.argv[1])); pg.wait_for_timeout(200)
    r=pg.evaluate("""[...document.querySelectorAll('.t')].filter(d=>{const c=d.dataset.chars; if(d.dataset.lines!=='1') return false;
      const bh=parseFloat(d.dataset.bh)||parseFloat(d.dataset.fs)*1.25; return d.getBoundingClientRect().height>bh*1.5}).map(d=>d.dataset.chars)""")
    print(f'wrapped single-line labels: {len(r)}', r[:12])
    if len(sys.argv)>2: pg.screenshot(path=sys.argv[2])
    b.close()
