import re
from pathlib import Path
from playwright.sync_api import sync_playwright

config = dict(l.split('=', 1) for l in Path('.env.local').read_text(encoding='utf-8').splitlines()
              if l and not l.startswith('#') and '=' in l)
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1440, 'height': 1000})
    pg.set_default_timeout(30000)
    pg.goto('http://127.0.0.1:3030/inicio')
    pg.get_by_role('heading', name='Ingresar al sistema').wait_for(timeout=120000)
    pg.locator('input[type=email]').fill(config['AJ_LOCAL_OWNER_EMAIL'])
    pg.locator('input[type=password]').fill(config['AJ_LOCAL_OWNER_PASSWORD'])
    pg.get_by_role('button', name='Ingresar', exact=True).click()
    pg.wait_for_timeout(5000)
    pg.goto('http://127.0.0.1:3030/alquileres/folio/?id=2ae2893b-c5f5-4cab-96b1-1b670001caac&seccion=Gastos')
    pg.wait_for_load_state('networkidle')
    pg.wait_for_timeout(4000)
    rel = pg.locator('section[aria-label^="Liberaci"]')
    print('release section visible:', rel.is_visible())
    print('reviewed note count:', rel.get_by_text(re.compile('ya fue confirmada')).count())
    print('reviewed keeps form hidden:', rel.get_by_role('button', name=re.compile('Confirmar entrega')).count())
    print('stage says finalizado:', 'Alquiler finalizado' in pg.locator('main').inner_text())
    print('pending wording:', pg.locator('main').inner_text().count('pendiente de liberar'))
    pg.screenshot(path='test-results/release-inline/20-post-release-section.png', full_page=True)
    b.close()
