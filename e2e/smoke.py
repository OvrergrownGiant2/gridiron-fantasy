"""End-to-end smoke test: signs in as the seeded demo user and visits every main page.
Usage: python3 e2e/smoke.py http://localhost:8787 out_dir"""
import sys, json, re
from playwright.sync_api import sync_playwright

base = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8787'
out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/e2e'
import os; os.makedirs(out, exist_ok=True)
errors = []
results = []

def run(width, height, scheme, tag):
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'))
        ctx = b.new_context(viewport={'width': width, 'height': height}, color_scheme=scheme, device_scale_factor=1)
        page = ctx.new_page()
        page.on('console', lambda m: m.type == 'error' and errors.append(f'[{tag}] console: {m.text}'))
        page.on('pageerror', lambda e: errors.append(f'[{tag}] pageerror: {e}'))
        page.goto(base + '/#/login')
        page.fill('#login-id', 'demo'); page.fill('#login-pw', 'demo1234')
        page.click('button[type=submit]')
        page.wait_for_url(re.compile(r'.*#/$'), timeout=15000)
        page.wait_for_selector('text=Your leagues', timeout=15000)
        page.screenshot(path=f'{out}/{tag}-dashboard.png', full_page=True)
        leagues = page.evaluate("""async () => (await (await fetch('/api/leagues.mine', {method:'POST', headers:{'content-type':'application/json','x-gridiron-client':'web'}, body:'{}'})).json()).data""")
        lid = [l for l in leagues if l['name'].startswith('Friends')][0]['id']
        for sec in ['team', 'matchups', 'players', 'waivers', 'trades', 'hub', 'chat', 'draft', 'commissioner']:
            page.goto(f'{base}/#/league/{lid}/{sec}')
            page.wait_for_timeout(1800)
            overflow = page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')
            results.append((tag, sec, 'H-OVERFLOW' if overflow else 'ok'))
            page.screenshot(path=f'{out}/{tag}-{sec}.png', full_page=False)
        for path in ['/#/leagues', '/#/leagues/new', '/#/notifications', '/#/settings']:
            page.goto(base + path); page.wait_for_timeout(1200)
            overflow = page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')
            results.append((tag, path, 'H-OVERFLOW' if overflow else 'ok'))
            page.screenshot(path=f"{out}/{tag}-{path.split('/')[-1] or 'x'}.png")
        b.close()

run(1366, 900, 'light', 'desk')
run(390, 844, 'dark', 'mob')
for r in results: print(*r)
print('ERRORS:', len(errors))
for e in errors[:30]: print(e)
