"""Read-only check: the workshop "Fotos y documentos" section keeps exactly ONE primary
action (the shared file upload) and that upload is still visible and functional.

Every HTTP request is fulfilled with synthetic data or aborted; nothing is written.
"""
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
import workshop_pipeline_readonly as fixture

APP = fixture.APP
ROOT = Path('test-results/workshop-documents-primary')

IS_PRIMARY = """element => {
  const match = getComputedStyle(element).backgroundColor.match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
  if (!match) return false;
  const [, red, green, blue] = match.map(Number);
  return red > 150 && green < 90 && blue < 100;
}"""


def primary_buttons(page):
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
    session = {'access_token': 'synthetic-never-forwarded', 'refresh_token': 'synthetic-refresh',
               'expires_at': 4102444800, 'expires_in': 3600, 'token_type': 'bearer',
               'user': {'id': fixture.USER, 'email': 'fixture@example.invalid',
                        'aud': 'authenticated', 'role': 'authenticated',
                        'app_metadata': {}, 'user_metadata': {}}}
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        page.route(re.compile(r'^https?://'), fixture.protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        try:
            fixture.go(page, 'Fotos y documentos')
            upload = page.get_by_role('button', name='Guardar archivo en este expediente', exact=True)
            expect(upload).to_be_visible()
            expect(upload).to_be_enabled()
            expect(upload).to_have_attribute('type', 'submit')
            # The workshop scope keeps the upload as its single primary action.
            primaries = primary_buttons(page)
            assert primaries == ['Guardar archivo en este expediente'], primaries
            page.screenshot(path=str(ROOT / 'workshop-documents.png'), full_page=True)
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    print(json.dumps({'passed': True, 'primaries': primaries, 'realApiRequests': 0, 'realBusinessWrites': 0}))


if __name__ == '__main__':
    main()
