"""Navigate full customer profiles against real reads without saving any business operation."""
import json
import re
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlencode, urlparse

from playwright.sync_api import expect, sync_playwright
from targeted_polish_readonly import READS, query
from inicio_echarts_readonly import snapshot, dollars, assert_fits

APP = 'http://127.0.0.1:3030'
ROOT = Path('test-results/customer-profile')


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    before = snapshot()
    env = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf8').splitlines()
               if '=' in line and not line.startswith('#'))
    customer = query("select to_jsonb(c) from public.customers c where merged_into is null order by "
                     "(select count(*) from public.work_orders o where o.customer_id=c.id) desc,c.id limit 1")
    facts = query("select jsonb_build_object('orders',(select count(*) from public.work_orders where customer_id='" + customer['id'] + "'),"
                  "'rentals',(select count(*) from public.reservations where customer_id='" + customer['id'] + "'))")
    errors, blocked, reads, documents = [], [], [], []
    restricted = False
    expect.set_options(timeout=30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1080})
        page.on('pageerror', lambda error: errors.append(str(error)))

        def protect(route):
            request = route.request
            url = urlparse(request.url)
            if url.hostname != '127.0.0.1' or url.port not in [3030, 55321]:
                blocked.append(url.netloc + url.path)
                route.abort()
                return
            if url.port != 55321 or '/rest/v1/' not in url.path or request.method in ['GET', 'HEAD', 'OPTIONS']:
                route.continue_()
                return
            rpc = url.path.split('/rpc/')[-1]
            if rpc not in READS:
                blocked.append(rpc)
                route.abort()
                return
            reads.append(rpc)
            if restricted and rpc == 'has_permission' and request.post_data_json['permission'] in ['expenses.read', 'expenses.write', 'customers.write', 'customers.merge']:
                route.fulfill(json=False)
            elif rpc == 'receivables_at':
                response = route.fetch()
                documents[:] = response.json()
                route.fulfill(response=response)
            else:
                route.continue_()

        page.route(re.compile(r'^https?://'), protect)
        try:
            page.goto(APP + '/clientes/?' + urlencode({'buscar': customer['name']}), wait_until='networkidle')
            page.locator('#aj-login-email').fill(env['AJ_LOCAL_OWNER_EMAIL'])
            page.locator('#aj-login-password').fill(env['AJ_LOCAL_OWNER_PASSWORD'])
            page.get_by_role('button', name='Ingresar', exact=True).click()
            try:
                expect(page.get_by_role('heading', name='Clientes', exact=True)).to_be_visible(timeout=45000)
            except AssertionError:
                if page.locator('#aj-login-password').count():
                    page.locator('#aj-login-password').fill('')
                raise AssertionError('The customer directory is not available; check local API health.') from None
            page.get_by_role('link', name=customer['name'], exact=True).click()
            expect(page).to_have_url(re.compile(r'/clientes/expediente/\?id='))
            expect(page.locator('main h1')).to_have_text(customer['name'])
            expect(page.get_by_role('dialog')).to_have_count(0)
            pipeline = page.get_by_role('region', name='Operaciones del cliente', exact=True)
            expect(pipeline.get_by_role('group', name='Tipo de operación del cliente').get_by_role('button', name=re.compile(r'^Taller'))).to_contain_text(str(facts['orders']))
            stage_buttons = pipeline.locator('[aria-label="Etapas de taller"] button')
            assert sum(int(value) for value in stage_buttons.locator('strong').all_text_contents()) == facts['orders']
            pipeline.get_by_role('button', name=re.compile(r'^Alquileres')).click()
            assert sum(int(value) for value in pipeline.locator('[aria-label="Etapas de alquiler"] button strong').all_text_contents()) == facts['rentals']
            pipeline.get_by_role('button', name=re.compile(r'^Taller')).click()
            pipeline.get_by_role('button', name=re.compile(r'Diagnóstico')).click()
            for text in pipeline.locator('article').all_text_contents():
                assert 'Diagnóstico' in text
            pipeline.get_by_role('button', name='Ver todas las etapas', exact=True).click()

            nav = page.get_by_role('navigation', name='Secciones del cliente', exact=True)
            for width in [1440, 1024, 768, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                for section in ['Operaciones', 'Vehículos', 'Datos y documentos', 'Cobros']:
                    nav.get_by_role('link', name=section, exact=True).click()
                    expect(nav.get_by_role('link', name=section, exact=True)).to_have_attribute('aria-current', 'page')
                    expect(page.get_by_role('dialog')).to_have_count(0)
                    page.wait_for_load_state('networkidle')
                    assert_fits(page, f'Customer {section} {width}px')
                    if section in ['Operaciones', 'Datos y documentos']:
                        page.evaluate('window.scrollTo(0,0)')
                        page.screenshot(path=str(ROOT / f'{"pipeline" if section == "Operaciones" else "data"}-{width}.png'), full_page=True)
                print('PASS: full-page customer sections fit at', width)

            expected_balance = sum(Decimal(str(document['balance'])) for document in documents
                                   if document['current_customer_id'] == customer['id'] and Decimal(str(document['balance'])) > 0)
            expect(page.get_by_role('region', name='Cobros y saldos del cliente').locator('strong').first).to_have_text(dollars(expected_balance))
            nav.get_by_role('link', name='Datos y documentos', exact=True).click()
            name = page.get_by_label('Nombre o razón social', exact=True)
            name.fill('Unsaved profile verification')
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            page.wait_for_load_state('networkidle')
            expect(name).to_have_value('Unsaved profile verification')
            expect(page.get_by_label(re.compile(r'de DUI$')).first).to_be_visible()
            expect(page.get_by_label(re.compile(r'de Licencia$')).first).to_be_visible()
            page.get_by_text('Opciones avanzadas: fusionar una ficha duplicada', exact=True).click()
            expect(page.get_by_role('button', name='Confirmar fusión', exact=True)).to_be_disabled()
            assert_fits(page, 'Customer expanded merge and private documents at 320px')
            # Reload the link directly; URL-based sections and ID survive without a modal.
            page.reload(wait_until='networkidle')
            expect(page.get_by_label('Nombre o razón social', exact=True)).to_have_value(customer['name'])
            expect(nav.get_by_role('link', name='Datos y documentos')).to_have_attribute('aria-current', 'page')
            page.get_by_role('link', name='Volver a clientes', exact=True).click()
            expect(page.get_by_role('heading', name='Clientes', exact=True)).to_be_visible()
            page.get_by_placeholder('Buscar nombre, teléfono o documento…', exact=True).fill(customer['name'])
            page.get_by_role('link', name='Ver cliente ' + customer['name'], exact=True).click()
            expect(page.locator('main h1')).to_have_text(customer['name'])
            expect(page.get_by_role('dialog')).to_have_count(0)

            restricted = True
            start = len(reads)
            page.reload(wait_until='networkidle')
            expect(page.locator('main h1')).to_have_text(customer['name'])
            expect(nav.get_by_role('link', name='Cobros', exact=True)).to_have_count(0)
            nav.get_by_role('link', name='Datos y documentos', exact=True).click()
            expect(page.get_by_role('button', name='Guardar cambios del cliente', exact=True)).to_have_count(0)
            expect(page.locator('input[type=file]')).to_have_count(0)
            assert not {'receivables_at', 'customer_document_list'}.intersection(reads[start:])
            expect(page.get_by_role('navigation', name='Navegación principal').get_by_role('link', name='Clientes', exact=True)).to_have_attribute('aria-current', 'page')
            assert_fits(page, 'Customer restricted frontend permissions at 320px')
            page.goto(APP + '/clientes/expediente/?id=not-a-customer', wait_until='networkidle')
            expect(page.get_by_role('heading', name='Cliente no disponible', exact=True)).to_be_visible()
            assert not blocked, blocked
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            raise
        finally:
            browser.close()
    after = snapshot()
    assert after == before, 'Public data changed; do not reset, replace or discard user records'
    evidence = {'fullPageProfile': True, 'noProfileModal': True, 'linkedStagesMatchLiveData': True,
                'financialBalanceMatchesCanonicalCustomer': True, 'draftSurvivesRefresh': True,
                'frontendPermissionChecks': True, 'unchangedPublicTables': len(before), 'realBusinessWrites': 0,
                'widths': [1440, 1024, 768, 390, 320], 'browserErrors': errors}
    (ROOT / 'verification.json').write_text(json.dumps(evidence, indent=2), encoding='utf8')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
