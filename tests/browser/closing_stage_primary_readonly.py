"""Read-only check: the rental closing stage shows exactly ONE primary action and the
shared file upload stays visible and functional there.

Every HTTP request is fulfilled with synthetic data or aborted; nothing is written.
"""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
import rental_folio_readonly as fixture

APP = fixture.APP
ROOT = Path('test-results/closing-stage-primary')

# The brand red of the primary button: a saturated red background, not white nor transparent.
IS_PRIMARY = """element => {
  const match = getComputedStyle(element).backgroundColor.match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
  if (!match) return false;
  const [, red, green, blue] = match.map(Number);
  return red > 150 && green < 90 && blue < 100;
}"""


def protect(route):
    request = route.request
    url = urlparse(request.url)
    resource = url.path.split('/')[-1]
    if '/rest/v1/rpc/' in url.path and resource in ['contract_list', 'contract_acceptance_list']:
        route.fulfill(json=[])
        return
    fixture.protect(route)


def primary_buttons(page):
    """Visible buttons whose own background is the brand red (the primary style)."""
    return page.evaluate("""() => {
      const visible = element => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden'
          && style.display !== 'none' && Number(style.opacity) > 0;
      };
      const isPrimary = element => {
        const match = getComputedStyle(element).backgroundColor.match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
        if (!match) return false;
        const [, red, green, blue] = match.map(Number);
        return red > 150 && green < 90 && blue < 100;
      };
      return Array.from(document.querySelectorAll('main button'))
        .filter(visible)
        .filter(isPrimary)
        .map(button => button.textContent.trim());
    }""")


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    public_url = next(line.split('=', 1)[1].strip().strip('"')
                      for line in Path('.env.local').read_text(encoding='utf8').splitlines()
                      if line.startswith('NEXT_PUBLIC_SUPABASE_URL='))
    storage_key = 'sb-' + urlparse(public_url).hostname.split('.')[0] + '-auth-token'
    session = {'access_token': 'synthetic-token-never-sent-to-server', 'refresh_token': 'synthetic-refresh',
               'expires_at': 4102444800, 'expires_in': 3600, 'token_type': 'bearer',
               'user': {'id': fixture.USER_ID, 'email': 'fixture@example.invalid',
                        'aud': 'authenticated', 'role': 'authenticated', 'app_metadata': {}, 'user_metadata': {}}}
    fixture.mode.update(finance=False, fail=False, denied=set())
    now = datetime.now(timezone.utc)
    fixture.booking.update(starts_at=(now - timedelta(days=2)).isoformat(),
                           ends_at=(now + timedelta(days=5)).isoformat(),
                           status='Confirmada', rental_state='Entregado', total=350, daily_rate=50)
    expect.set_options(timeout=30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        try:
            page.goto(APP + '/alquileres/folio/?id=' + fixture.FIXTURE_ID, wait_until='networkidle')
            expect(page.get_by_role('heading', level=1, name=re.compile('ALQ-99001'))).to_be_visible()
            page.get_by_role('region', name='Fases del folio').get_by_role(
                'button', name=re.compile('^Finalizado:')).click()
            expect(page.get_by_role('region', name='Cierre del alquiler')).to_be_visible()
            # The upload is still there and still reachable: the demotion is visual only.
            upload = page.get_by_role('button', name='Guardar archivo en este expediente', exact=True)
            expect(upload).to_be_visible()
            expect(upload).to_be_enabled()
            expect(upload).to_have_attribute('type', 'submit')
            upload_background = upload.evaluate('element => getComputedStyle(element).backgroundColor')
            assert not upload.evaluate(IS_PRIMARY), upload_background
            # The contract version lives in a collapsed panel: open it before counting.
            page.evaluate('document.querySelectorAll("main details").forEach(node => node.open = true)')
            # Exactly one primary action on the closing stage: the contract version.
            primaries = primary_buttons(page)
            assert primaries == ['Guardar versión de contrato'], primaries
            page.screenshot(path=str(ROOT / 'closing-stage.png'), full_page=True)
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    print(json.dumps({'passed': True, 'primaries': primaries, 'realApiRequests': 0, 'realBusinessWrites': 0}))


if __name__ == '__main__':
    main()
