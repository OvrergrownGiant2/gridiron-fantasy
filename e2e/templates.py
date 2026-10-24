"""E2E: create a league from each quick-start template and confirm it is playable.
Usage: python3 e2e/templates.py http://localhost:8787 out_dir"""
import os, re, sys
from playwright.sync_api import sync_playwright
base = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8787'
out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/e2e'; os.makedirs(out, exist_ok=True)
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'))
    page = b.new_page(viewport={'width': 390, 'height': 844})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '/#/login'); page.fill('#login-id', 'demo'); page.fill('#login-pw', 'demo1234'); page.click('button[type=submit]')
    page.wait_for_selector('text=Your leagues', timeout=20000)
    cases = [('High Score Challenge', None, 'Create and start'), ('Head-to-Head Duel', None, 'Create and start'), ('League', 'friends', 'Create league')]
    for title, variant, button in cases:
        page.goto(base + '/#/leagues/new'); page.wait_for_selector('text=Pick a game mode')
        page.click(f'[role=radio]:has-text("{title}")')
        page.fill('#qc-name', f'E2E {title}'); page.fill('#qc-team', 'Testers')
        page.screenshot(path=f'{out}/tpl-{title.split()[0].lower()}.png', full_page=True)
        page.click(f'button:has-text("{button}")')
        if button == 'Create and start':
            page.wait_for_url(re.compile(r'.*/team$'), timeout=60000); page.wait_for_selector('text=Starters', timeout=30000)
            print(title, '-> roster ready')
        else:
            page.wait_for_url(re.compile(r'.*/draft$'), timeout=30000); page.wait_for_selector('text=open seats', timeout=30000)
            print(title, '-> draft room with invite code')
        page.screenshot(path=f'{out}/tpl-{title.split()[0].lower()}-after.png')
    b.close()
print('page errors:', errors)
