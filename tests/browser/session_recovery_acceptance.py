"""Read-only session recovery: persisted login, API outages, renewal and local sign-out."""
import copy
import json
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


def main() -> None:
    config = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf-8').splitlines()
                  if '=' in line and not line.startswith('#'))
    assert config['NEXT_PUBLIC_SUPABASE_URL'] == 'http://127.0.0.1:55321', 'AJ local only.'
    expect.set_options(timeout=30000)
    mutations: list[str] = []
    errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        def track(page) -> None:
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: mutations.append(urlsplit(request.url).path) if re.search(
                r'/rpc/(execute_|record_|issue_|save_|collect_|pay_|stage_|publish_|review_)', request.url) else None)

        def dashboard(page) -> None:
            expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
            expect(page.get_by_role('navigation', name='Navegación principal').get_by_role('link')).to_have_count(8)
            expect(page.locator('.business-metric small')).to_have_text(' / 27')
            page.wait_for_load_state('networkidle')
            assert not page.get_by_text('No se pudo cargar la sesión operativa.', exact=False).count()

        page = None
        try:
            context = browser.new_context(reduced_motion='reduce')
            page = context.new_page()
            track(page)
            page.goto('http://127.0.0.1:3030/inicio/', wait_until='networkidle')
            page.locator('#aj-login-email').fill(config['AJ_LOCAL_OWNER_EMAIL'])
            page.locator('#aj-login-password').fill(config['AJ_LOCAL_OWNER_PASSWORD'])
            page.locator('button[type=submit]').click()
            dashboard(page)
            page.reload(wait_until='networkidle')
            dashboard(page)
            saved = context.storage_state()
            context.close()
            print('PASS: real sign-in and saved-session reload load permissions and business data.')

            cases = [
                ('permissions-unavailable', '**/rest/v1/rpc/has_permission', 503,
                 {'code': 'PGRST002', 'message': 'Schema cache temporarily unavailable'}),
                ('data-unavailable', '**/rest/v1/vehicles?*', 503,
                 {'code': 'PGRST000', 'message': 'Database temporarily unavailable'}),
                ('rejected-access-token', '**/rest/v1/rpc/has_permission', 401,
                 {'code': 'PGRST303', 'message': 'JWT is not accepted'}),
            ]
            for label, pattern, status, body in cases:
                context = browser.new_context(storage_state=saved, viewport={'width': 320, 'height': 740},
                                              reduced_motion='reduce')
                page = context.new_page()
                track(page)
                blocked = {'value': True}
                renewals: list[str] = []

                def unavailable(route) -> None:
                    if blocked['value'] and route.request.method != 'OPTIONS':
                        route.fulfill(status=status, json=body)
                    else:
                        route.continue_()

                page.route(pattern, unavailable)
                page.on('request', lambda request: renewals.append('refresh') if
                        '/auth/v1/token?grant_type=refresh_token' in request.url else None)
                page.goto('http://127.0.0.1:3030/inicio/', wait_until='networkidle')
                expect(page.get_by_role('alert').filter(has_text='No se pudo cargar la sesión operativa.')).to_be_visible()
                expect(page.get_by_role('navigation', name='Navegación principal')).to_have_count(0)
                expect(page.get_by_role('button', name='Reintentar', exact=True)).to_be_visible(timeout=1500)
                expect(page.get_by_role('button', name='Volver a ingresar', exact=True)).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                page.screenshot(path=f'test-results/session-recovery-{label}-320.png', full_page=True)
                blocked['value'] = False
                page.get_by_role('button', name='Reintentar', exact=True).click()
                dashboard(page)
                assert renewals, 'Manual recovery did not renew the saved session.'
                saved = context.storage_state()
                context.close()
                print(f'PASS: {label} recovers on retry, without exposing an empty workspace or writing records.')

            expired = copy.deepcopy(saved)
            for origin in expired['origins']:
                for item in origin['localStorage']:
                    if re.fullmatch(r'sb-.+-auth-token', item['name']):
                        value = json.loads(item['value'])
                        value['expires_at'] = int(time.time()) - 60
                        item['value'] = json.dumps(value)
            context = browser.new_context(storage_state=expired, reduced_motion='reduce')
            page = context.new_page()
            track(page)
            page.goto('http://127.0.0.1:3030/inicio/', wait_until='networkidle')
            dashboard(page)
            saved = context.storage_state()
            context.close()
            print('PASS: saved session with expired metadata renews before loading the workspace.')

            invalid = copy.deepcopy(saved)
            for origin in invalid['origins']:
                for item in origin['localStorage']:
                    if re.fullmatch(r'sb-.+-auth-token', item['name']):
                        value = json.loads(item['value'])
                        value['expires_at'] = int(time.time()) - 60
                        value['refresh_token'] = 'invalid-local-recovery-test'
                        item['value'] = json.dumps(value)
            context = browser.new_context(storage_state=invalid, reduced_motion='reduce')
            page = context.new_page()
            track(page)
            page.goto('http://127.0.0.1:3030/inicio/', wait_until='networkidle')
            expect(page.locator('#aj-login-email')).to_be_visible()
            expect(page.get_by_role('navigation', name='Navegación principal')).to_have_count(0)
            context.close()
            print('PASS: an unusable saved refresh token returns to sign-in, not a blocked workspace.')

            context = browser.new_context(storage_state=saved, reduced_motion='reduce')
            page = context.new_page()
            track(page)
            logout_requests: list[str] = []
            page.on('request', lambda request: logout_requests.append(request.url) if
                    urlsplit(request.url).path == '/auth/v1/logout' else None)

            def still_unavailable(route) -> None:
                if route.request.method == 'OPTIONS':
                    route.continue_()
                else:
                    route.fulfill(status=503, json={'code': 'PGRST002', 'message': 'Temporarily unavailable'})

            page.route('**/rest/v1/rpc/has_permission', still_unavailable)
            page.goto('http://127.0.0.1:3030/inicio/', wait_until='networkidle')
            expect(page.get_by_role('button', name='Volver a ingresar', exact=True)).to_be_visible()
            page.get_by_role('button', name='Volver a ingresar', exact=True).click()
            expect(page.locator('#aj-login-email')).to_be_visible()
            assert not page.get_by_role('navigation', name='Navegación principal').count()
            assert logout_requests and all('scope=local' in url for url in logout_requests)
            context.close()
            assert not mutations, 'Recovery attempted a business mutation: ' + str(mutations)
            assert not errors, 'Session recovery produced browser runtime errors.'
            print('PASS: local sign-out escapes a persistent outage; no business records changed.')
        except Exception as error:
            safe = str(error).replace(config['AJ_LOCAL_OWNER_PASSWORD'], '[REDACTED]')
            safe = safe.replace(config['AJ_LOCAL_OWNER_EMAIL'], '[LOCAL USER]')
            raise RuntimeError(safe) from None
        finally:
            browser.close()


if __name__ == '__main__':
    main()
