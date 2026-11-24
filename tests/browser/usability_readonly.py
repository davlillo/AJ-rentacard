"""Check compact layouts, distinct records and expandable diary details without business writes."""
import json
import re
from pathlib import Path
from urllib.parse import urlencode, urlparse

from playwright.sync_api import expect, sync_playwright
from targeted_polish_readonly import READS, query
from inicio_echarts_readonly import snapshot, assert_fits, assert_dashboard_charts, dashboard_chart_expectations, wait_charts_resized, wait_cash_loaded

APP = 'http://127.0.0.1:3030'
ROOT = Path('test-results/usability')


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    before = snapshot()
    env = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf8').splitlines()
               if '=' in line and not line.startswith('#'))
    customer = query("select to_jsonb(c) from public.customers c where merged_into is null order by "
                     "(select count(*) from public.work_orders o where o.customer_id=c.id) desc,c.id limit 1")
    errors, blocked = [], []
    diary_reads = []
    evidence = {}
    expect.set_options(timeout=30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        page.on('pageerror', lambda error: errors.append(str(error)))

        def protect(route):
            request = route.request
            url = urlparse(request.url)
            if url.hostname != '127.0.0.1' or url.port not in [3030, 55321]:
                blocked.append(url.netloc + url.path)
                route.abort()
            elif url.port == 55321 and '/rest/v1/' in url.path and request.method not in ['GET', 'HEAD', 'OPTIONS'] and url.path.split('/rpc/')[-1] not in READS:
                blocked.append(url.path)
                route.abort()
            elif url.port == 55321 and url.path.endswith('/rpc/cash_diary') and request.method == 'POST':
                # Capture the authorized diary read so the expected chart count comes from the data.
                response = route.fetch()
                diary_reads.append((request.post_data_json, response.json()))
                route.fulfill(response=response)
            else:
                route.continue_()

        page.route(re.compile(r'^https?://'), protect)
        try:
            page.goto(APP + '/inicio/', wait_until='networkidle')
            page.locator('#aj-login-email').fill(env['AJ_LOCAL_OWNER_EMAIL'])
            page.locator('#aj-login-password').fill(env['AJ_LOCAL_OWNER_PASSWORD'])
            page.get_by_role('button', name='Ingresar', exact=True).click()
            try:
                expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible(timeout=45000)
            except AssertionError:
                if page.locator('#aj-login-password').count():
                    page.locator('#aj-login-password').fill('')
                raise AssertionError('Operational workspace unavailable; check local API health.') from None
            page.wait_for_load_state('networkidle')
            wait_cash_loaded(page)
            assert diary_reads, 'The dashboard did not read the authorized cash diary'
            period = (diary_reads[0][0]['from_date'], diary_reads[0][0]['to_date'])
            expected_charts = dashboard_chart_expectations(diary_reads[0][1], period)
            assert_dashboard_charts(page, expected_charts)
            evidence['dashboardCharts'] = expected_charts
            assert page.locator('.business-metric p').count() == 0
            assert page.get_by_text('PANORAMA DE AJ', exact=True).count() == 0
            jobs = page.get_by_role('region', name='¿Cómo va el taller?', exact=True)
            assert not jobs.locator('details').evaluate('(element) => element.open')
            evidence['compactHomeHeight1440'] = round(page.locator('.business-dashboard').bounding_box()['height'])
            for width in [1440, 1024, 768, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                wait_charts_resized(page)
                assert_fits(page, f'Compact Inicio {width}px')
                page.evaluate('window.scrollTo(0,0)')
                page.screenshot(path=str(ROOT / f'inicio-{width}.png'), full_page=True)

            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                page.goto(APP + '/clientes/expediente/?' + urlencode({'id': customer['id']}), wait_until='networkidle')
                identity = page.get_by_role('complementary', name='Datos principales del cliente').bounding_box()
                operations = page.get_by_role('region', name='Operaciones del cliente', exact=True).bounding_box()
                assert abs(identity['x'] - operations['x']) < 3
                assert abs(identity['width'] - operations['width']) < 3
                assert operations['y'] > identity['y'] + identity['height']
                assert_fits(page, f'Full-width customer profile {width}px')

                page.goto(APP + '/calendario/', wait_until='networkidle')
                month = page.get_by_role('region', name='Calendario mensual de vehículos').bounding_box()
                bookings = page.get_by_role('complementary', name='Reservas por vehículo').bounding_box()
                assert abs(month['x'] - bookings['x']) < 3
                assert abs(month['width'] - bookings['width']) < 3
                assert bookings['y'] >= month['y'] + month['height']
                assert_fits(page, f'Full-width calendar and booking cards {width}px')
                page.evaluate('window.scrollTo(0,0)')
                page.screenshot(path=str(ROOT / f'calendario-{width}.png'), full_page=True)
                page.locator('.calendar-booking-select').first.click()
                expect(page.locator('[role="gridcell"][aria-selected="true"]').first).to_be_visible()
                page.get_by_role('navigation', name='Vistas de alquileres').get_by_role('button', name='Folios', exact=True).click()
                assert_fits(page, f'Calendar reservation records {width}px')

                page.goto(APP + '/libro-diario/', wait_until='networkidle')
                expect(page.get_by_role('heading', name='Libro diario', exact=True)).to_be_visible()
                summary = page.get_by_role('region', name='Resumen del diario', exact=True)
                expect(summary.locator('article')).to_have_count(3)
                advanced = page.locator('summary').filter(has_text='Filtros y conciliación')
                assert not advanced.evaluate('(element) => element.parentElement.open')
                entries = page.locator('main article[aria-label]')
                expect(entries.first).to_be_visible()
                for entry in entries.all():
                    assert not entry.locator('details').evaluate('(element) => element.open')
                assert_fits(page, f'Clean diary {width}px')
                page.evaluate('window.scrollTo(0,0)')
                page.screenshot(path=str(ROOT / f'diario-{width}.png'), full_page=True)
                entries.first.locator('summary').click()
                assert_fits(page, f'Expanded diary event {width}px')
                advanced.click()
                expect(page.get_by_label('Cuenta o caja', exact=True)).to_be_visible()
                expect(page.get_by_label('Folio de taller o contrato de alquiler', exact=True)).to_be_visible()
                assert_fits(page, f'Expanded diary filters {width}px')
                if width == 1440:
                    with page.expect_download() as pending:
                        page.get_by_role('button', name='Exportar vista', exact=True).click()
                    pending.value.save_as(ROOT / 'diario.csv')
                    assert (ROOT / 'diario.csv').stat().st_size > 100

                for path in ['clientes', 'taller', 'presupuestos']:
                    page.goto(APP + '/' + path + '/', wait_until='networkidle')
                    # Alternating rows are compared inside each table; a module can show several.
                    for index, table in enumerate(page.locator('table:not([aria-label^="Hoja "])').all()):
                        rows = table.locator('tbody tr')
                        if rows.count() > 1:
                            backgrounds = rows.evaluate_all('(elements) => elements.slice(0,2).map(el => getComputedStyle(el).backgroundColor)')
                            assert backgrounds[0] != backgrounds[1], f'{path} table {index} lacks alternating row boundaries'
                    assert_fits(page, f'Distinct {path} table rows {width}px')
                    if path == 'taller':
                        page.evaluate('window.scrollTo(0,0)')
                        page.screenshot(path=str(ROOT / f'taller-{width}.png'), full_page=True)
                print('PASS: no blank left columns, bounded cards and simplified diary at', width)
            assert not blocked, blocked
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            raise
        finally:
            browser.close()
    after = snapshot()
    changed = [table for table in before if before[table] != after.get(table)]
    assert not changed, 'Public records changed; never reset or replace user data: ' + ', '.join(changed)
    evidence.update({'homeDescriptionsRemoved': True, 'customerAndCalendarUseFullWidth': True,
                     'distinctOperationalRows': True, 'diaryDetailsAndFiltersExpandable': True,
                     'unchangedPublicTables': len(before), 'realBusinessWrites': 0, 'browserErrors': errors,
                     'widths': [1440, 1024, 768, 390, 320]})
    (ROOT / 'verification.json').write_text(json.dumps(evidence, indent=2), encoding='utf8')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
