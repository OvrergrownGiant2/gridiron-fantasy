"""E2E: the Refresh league button is shown only to the league creator and works."""
import os, re, sys
from playwright.sync_api import sync_playwright
base = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8787'
def run(user, pw):
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'))
        page = b.new_page(viewport={'width': 1280, 'height': 900})
        page.goto(base + '/#/login'); page.fill('#login-id', user); page.fill('#login-pw', pw); page.click('button[type=submit]')
        page.wait_for_selector('text=Your leagues', timeout=20000)
        lid = page.evaluate("""async () => (await (await fetch('/api/leagues.mine', {method:'POST', headers:{'content-type':'application/json','x-gridiron-client':'web'}, body:'{}'})).json()).data.find(l => l.name === 'Friends & Family').id""")
        page.goto(f'{base}/#/league/{lid}/hub'); page.wait_for_selector('text=Standings', timeout=20000); page.wait_for_timeout(1000)
        visible = page.locator('button:has-text("Refresh league")').count() > 0
        msg = None
        if visible:
            page.click('button:has-text("Refresh league")')
            page.wait_for_selector('text=/League refreshed|Scores recalculated|Could not reach/', timeout=60000)
            msg = page.locator('[aria-live=polite]').inner_text()
        b.close()
        return visible, msg
print('demo (creator):', run('demo', 'demo1234'))
print('alex (member):', run('alex', 'alex1234'))
