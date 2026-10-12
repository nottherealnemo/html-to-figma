import sys
from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops
src, out, ref, w = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': w, 'height': 900})
    import os; pg.goto('file://' + os.path.abspath(src)); pg.wait_for_timeout(300)
    pg.screenshot(path=out, full_page=True); b.close()
a = Image.open(ref).convert('RGB'); c = Image.open(out).convert('RGB')
h = max(a.height, c.height)
side = Image.new('RGB', (a.width + c.width + 20, h), 'red'); side.paste(a, (0, 0)); side.paste(c, (a.width + 20, 0))
side.save(out.replace('.png', '-side.png'))
c2 = c.crop((0, 0, a.width, a.height)) if c.height >= a.height else c
diff = ImageChops.difference(a.crop((0,0,c2.width,c2.height)), c2).convert('L')
px = sum(1 for v in diff.getdata() if v > 40)
print('size ref', a.size, 'rebuilt', c.size, 'pixels differing >40:', px, f'({100*px/(c2.width*c2.height):.2f}%)')
