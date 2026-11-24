"""Verify Inicio against authorized live reads; never submit a business command."""
import json
import re
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
from showcase_acceptance import assert_fits as assert_html_fits
from targeted_polish_readonly import READS, query

APP = 'http://127.0.0.1:3030'
ROOT = Path('test-results/inicio')


def assert_fits(page, context):
    # SVG text exposes glyph metrics as scrollWidth/clientWidth, not HTML scroll containers.
    # Check all HTML surfaces as before, plus the actual SVG viewport against its host.
    assert_html_fits(page, context, 'main *:not(svg *), [role=dialog] *:not(svg *)')
    assert page.locator('[data-chart="apache-echarts"]').evaluate_all("""elements => elements.every(el => {
      const svg=el.querySelector('svg');if(!svg)return true;
      const host=el.getBoundingClientRect(),box=svg.getBoundingClientRect();
      return box.width<=host.width+2&&box.right<=innerWidth+2&&box.left>=-2;
    })"""), context + ': SVG viewport overflow'


def snapshot():
    tables = query("select jsonb_agg(tablename order by tablename) from pg_tables where schemaname='public'")
    pieces = [f"select '{table}' name,count(*) n,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) hash from public.\"{table}\" t" for table in tables]
    return query("select jsonb_object_agg(name,jsonb_build_object('count',n,'hash',hash)) from (" + ' union all '.join(pieces) + ') s')


def dollars(value):
    return '${:,.2f}'.format(Decimal(str(value)))


def dashboard_chart_expectations(diary, period):
    """Charts the dashboard can show for the data that actually exists.

    The cash chart needs real movement inside the selected period, the fleet chart needs at
    least one rental-fleet vehicle and the workshop chart needs work orders still in progress.
    The count is therefore derived from the data, never hard-coded.
    """
    rows = [row for row in (diary or {}).get('rows', []) if period[0] <= row['date'] <= period[1]]
    movement = sum(float(row.get('inflow') or 0) + float(row.get('outflow') or 0) for row in rows)
    fleet = query("select jsonb_build_object('n',count(*)) from public.vehicles where in_rental_fleet")['n']
    jobs = query("select jsonb_build_object('n',count(*)) from public.work_orders "
                 "where status not in ('Presupuesto','Entregado')")['n']
    return {'cash': int(bool(movement)), 'fleet': int(bool(fleet)), 'workshop': int(bool(jobs)),
            'fleetVehicles': fleet, 'workshopJobs': jobs}


def wait_cash_loaded(page):
    """Wait until the authorized cash read resolved, so the totals and the cash chart are real."""
    expect(page.locator('[data-value="income"]')).not_to_have_text('—', timeout=45000)


def wait_charts_resized(page):
    """Wait until every ECharts SVG matches its host width after a viewport change.

    The chart resizes through a ResizeObserver, so the overflow assertion must run once the
    chart has settled; otherwise it measures the previous layout instead of the current one.
    """
    page.wait_for_function("""() => Array.from(document.querySelectorAll('[data-chart="apache-echarts"]')).every(el=>{
      const svg=el.querySelector('svg');
      return !svg||Math.abs(svg.getBoundingClientRect().width-el.clientWidth)<=1;})""", timeout=30000)


def assert_dashboard_charts(page, expected):
    """Each dashboard chart is asserted inside its own region, against the data it represents."""
    cash = page.get_by_role('region', name='El movimiento de tu caja', exact=True)
    fleet = page.get_by_role('region', name='Tu flota, de un vistazo', exact=True)
    workshop = page.get_by_role('region', name='¿Cómo va el taller?', exact=True)
    expect(cash.locator('[data-chart="apache-echarts"] svg')).to_have_count(expected['cash'])
    expect(fleet.locator('[data-chart="apache-echarts"] svg')).to_have_count(expected['fleet'])
    expect(workshop.locator('[data-chart="apache-echarts"] svg')).to_have_count(expected['workshop'])
    expect(page.locator('[data-chart="apache-echarts"] svg')).to_have_count(
        expected['cash'] + expected['fleet'] + expected['workshop'])


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    before = snapshot()
    (ROOT / 'before-ui.json').write_text(json.dumps(before, indent=2), encoding='utf8')
    env = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf8').splitlines()
               if '=' in line and not line.startswith('#'))
    errors, warnings, blocked, requests, cash_reads, held = [], [], [], [], {}, []
    mode = {'hold_month': False, 'fail_cash': False, 'finance_allowed': True}
    initial_period = {}
    evidence = {}
    expect.set_options(timeout=30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1080}, reduced_motion='reduce')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: warnings.append(message.text)
                if message.type in ['warning', 'error'] and 'ECharts' in message.text else None)

        def protect(route):
            request = route.request
            url = urlparse(request.url)
            if url.hostname != '127.0.0.1' or url.port not in [3030, 55321]:
                blocked.append(url.netloc + url.path)
                route.abort()
                return
            if url.port != 55321 or '/rest/v1/' not in url.path:
                route.continue_()
                return
            rpc = url.path.split('/rpc/')[-1]
            if request.method in ['GET', 'HEAD', 'OPTIONS']:
                route.continue_()
                return
            if rpc not in READS:
                blocked.append(rpc)
                route.abort()
                return
            requests.append(rpc)
            payload = request.post_data_json
            if rpc == 'has_permission' and payload['permission'] in ['expenses.read', 'expenses.write'] and not mode['finance_allowed']:
                route.fulfill(json=False)
                return
            if rpc == 'cash_diary':
                if mode['fail_cash']:
                    route.fulfill(status=503, json={'message': 'Simulated read outage; no database change'})
                    return
                response = route.fetch()
                assert response.status == 200
                result = response.json()
                key = (payload['from_date'], payload['to_date'])
                cash_reads[key] = result
                if not initial_period:
                    initial_period.update({'from': key[0], 'to': key[1]})
                if mode['hold_month'] and key[0] == initial_period['from']:
                    held.append((route, response))
                else:
                    route.fulfill(response=response)
                return
            if rpc == 'receivables_at':
                response = route.fetch()
                assert response.status == 200
                documents = response.json()
                evidence['balance'] = sum(Decimal(str(doc['balance'])) for doc in documents if Decimal(str(doc['balance'])) > 0)
                route.fulfill(response=response)
                return
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
                raise AssertionError('Unable to open the authenticated workspace; check local API health.') from None
            page.wait_for_load_state('networkidle')
            wait_cash_loaded(page)
            month = (initial_period['from'], initial_period['to'])
            diary = cash_reads[month]
            # The number of charts depends on the data: movement, fleet and open work orders.
            expected_charts = dashboard_chart_expectations(diary, month)
            assert_dashboard_charts(page, expected_charts)
            evidence['dashboardCharts'] = expected_charts
            today = date.fromisoformat(initial_period['to'])
            week = ((today - timedelta(days=6)).isoformat(), today.isoformat())
            expect(page.locator('[data-value="income"]')).to_have_text(dollars(diary['income']))
            expect(page.locator('[data-value="outgoing"]')).to_have_text(dollars(diary['outgoing']))
            expect(page.locator('[data-value="net"]')).to_have_text(dollars(diary['netMovement']))
            expect(page.locator('[data-value="receivable"]')).to_have_text(dollars(evidence['balance']))
            evidence['totalsMatchAuthorizedRPC'] = True
            nav = page.get_by_role('navigation', name='Navegación principal', exact=True)
            # The sidebar exposes the current module list, including the rentals module.
            expect(nav.get_by_role('link')).to_have_text(
                ['Inicio', 'Clientes', 'Vehículos', 'Calendario', 'Alquileres', 'Taller', 'Presupuestos', 'Cobros', 'Libro diario'])
            fleet = page.get_by_role('region', name='Tu flota, de un vistazo', exact=True)
            workshop = page.get_by_role('region', name='¿Cómo va el taller?', exact=True)
            cash = page.get_by_role('region', name='El movimiento de tu caja', exact=True)

            # An actual ECharts SVG responds to pointer interaction with exact count/value tooltips.
            chart = fleet.locator('[data-chart="apache-echarts"]')
            chart.scroll_into_view_if_needed()
            box = chart.bounding_box()
            page.mouse.move(box['x'] + box['width'] / 2 + min(box['width'], box['height']) * .39,
                            box['y'] + box['height'] / 2)
            expect(chart.locator('svg')).to_contain_text('vehículos (')
            page.mouse.click(box['x'] + box['width'] / 2 + min(box['width'], box['height']) * .39,
                             box['y'] + box['height'] / 2)
            expect(fleet.locator('button[aria-pressed="true"]')).to_have_count(1)
            expect(fleet.get_by_role('link').filter(has=page.locator('strong')).first).to_be_visible()
            evidence['interactiveSVGTooltipAndDrilldown'] = True

            # Every category has a keyboard-operable alternative to the ring.
            available = fleet.get_by_role('button', name=re.compile(r'^Disponibles'))
            available.focus()
            page.keyboard.press('Enter')
            if available.get_attribute('aria-pressed') != 'true':
                page.keyboard.press('Enter')
            expect(available).to_have_attribute('aria-pressed', 'true')
            counts = fleet.locator('button strong').all_text_contents()
            total = int(page.locator('[data-value="available"] small').inner_text().split('/')[-1])
            assert sum(map(int, counts)) == total

            # Local workshop filters preserve the global KPI and change the real detail list only.
            global_jobs = page.locator('[data-value="workshop"]').inner_text()
            for area in ['Pintura', 'Mecánica', 'Todas']:
                workshop.get_by_label('Área del taller', exact=True).select_option(area)
                if area != 'Todas':
                    job_links = workshop.locator('a[href*="/taller/ingreso/"]')
                    for text in job_links.all_text_contents():
                        assert area in text
                expect(page.locator('[data-value="workshop"]')).to_have_text(global_jobs)
            workshop.get_by_role('button', name=re.compile(r'^En proceso')).click()
            expect(workshop.get_by_role('button', name=re.compile(r'^En proceso'))).to_have_attribute('aria-pressed', 'true')
            workshop.get_by_role('button', name=re.compile(r'^En proceso')).click()

            # A period change must never show the totals of the previous period, even out of order.
            with page.expect_response(lambda response: response.url.endswith('/rpc/cash_diary') and
                                      response.request.post_data_json.get('from_date') == week[0]):
                cash.get_by_role('button', name='7 días', exact=True).click()
            page.wait_for_load_state('networkidle')
            week_income = dollars(cash_reads[week]['income'])
            expect(cash.locator('[data-value="income"]')).to_have_text(week_income)
            mode['hold_month'] = True
            cash.get_by_role('button', name='Este mes', exact=True).click()
            expect(cash.locator('[data-value="income"]')).to_have_text('—')
            cash.get_by_role('button', name='7 días', exact=True).click()
            expect(cash.locator('[data-value="income"]')).to_have_text(week_income)
            assert held, 'Expected a delayed month response'
            mode['hold_month'] = False
            for route, response in held:
                route.fulfill(response=response)
            held.clear()
            expect(cash.locator('[data-value="income"]')).to_have_text(week_income)
            evidence['outOfOrderReadCannotReplaceSelectedPeriod'] = True

            # Show stale same-period data with an explicit warning on outages; recover without a write.
            mode['fail_cash'] = True
            page.get_by_role('button', name='Actualizar datos', exact=True).click()
            expect(cash.get_by_role('alert')).to_contain_text('lectura anterior')
            expect(cash.locator('[data-value="income"]')).to_have_text(week_income)
            mode['fail_cash'] = False
            cash.get_by_role('button', name='Reintentar', exact=True).click()
            expect(cash.get_by_role('alert')).to_have_count(0)
            evidence['readErrorAndRetryVerified'] = True

            # Empty real periods stay empty. No illustrative chart or invented movement is displayed.
            cash.get_by_role('button', name='Personalizado', exact=True).click()
            cash.get_by_label('Desde', exact=True).fill('2010-01-01')
            cash.get_by_label('Hasta', exact=True).fill('2010-01-01')
            cash.get_by_role('button', name='Aplicar', exact=True).click()
            expect(cash).to_contain_text('Sin entradas ni salidas en este período')
            expect(cash.locator('[data-chart="apache-echarts"]')).to_have_count(0)
            expect(page.locator('[data-value="receivable"]')).to_have_text(dollars(evidence['balance']))
            cash.get_by_label('Hasta', exact=True).fill((today + timedelta(days=1)).isoformat())
            expect(cash.get_by_role('button', name='Aplicar', exact=True)).to_be_disabled()
            evidence['emptyRangeAndFutureRangeVerified'] = True

            cash.get_by_role('button', name='Este mes', exact=True).click()
            expect(cash.locator('[data-value="income"]')).to_have_text(dollars(diary['income']))
            if workshop.locator('details').evaluate('(element) => element.open'):
                workshop.locator('details > summary').click()
            if fleet.locator('button[aria-pressed="true"]').count():
                fleet.locator('button[aria-pressed="true"]').click()
            for width in [1440, 1024, 768, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                wait_charts_resized(page)
                assert_fits(page, f'Inicio ECharts {width}px')
                page.evaluate('window.scrollTo(0,0)')
                page.screenshot(path=str(ROOT / f'inicio-{width}.png'), full_page=True)
                cash.get_by_role('button', name='Personalizado', exact=True).click()
                cash.get_by_label('Desde', exact=True).fill(month[0])
                assert_fits(page, f'Inicio custom picker {width}px')
                cash.locator('summary').click()
                assert_fits(page, f'Inicio chart values {width}px')
                cash.locator('summary').click()
                cash.get_by_role('button', name='Este mes', exact=True).click()
                print('PASS: Inicio, filters and expanded chart detail fit at', width)

            # Follow existing contextual links; assert the current module list and four fleet tabs.
            page.set_viewport_size({'width': 1440, 'height': 1000})
            cash.get_by_role('link', name='Ver diario', exact=True).click()
            expect(page.get_by_role('heading', name='Libro diario', exact=True)).to_be_visible()
            expect(page.get_by_label('Desde', exact=True)).to_have_value(month[0])
            expect(page.get_by_label('Hasta', exact=True)).to_have_value(month[1])
            page.goto(APP + '/vehiculos/', wait_until='networkidle')
            expect(page.get_by_role('tablist', name='Estado de la flota').get_by_role('tab')).to_have_count(4)
            for width in [390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                for path in ['clientes', 'vehiculos', 'calendario', 'taller', 'presupuestos', 'cobros', 'libro-diario']:
                    page.goto(APP + '/' + path + '/', wait_until='networkidle')
                    assert_fits(page, f'Unchanged {path} {width}px')

            # Simulate restricted frontend permissions only; server role enforcement is in the SQL suite.
            mode['finance_allowed'] = False
            start = len(requests)
            page.goto(APP + '/inicio/', wait_until='networkidle')
            expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
            expect(page.locator('[data-value="receivable"]')).to_have_count(0)
            expect(page.get_by_role('region', name='El movimiento de tu caja', exact=True)).to_have_count(0)
            assert not {'cash_diary', 'receivables_at'}.intersection(requests[start:])
            evidence['frontendWithholdsFinancialReadsWithoutPermission'] = True
            assert_fits(page, 'Inicio restricted permission at 320px')
            assert not blocked, blocked
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.json').write_text(json.dumps({'errors': errors, 'echartsWarnings': warnings, 'blocked': blocked}, indent=2), encoding='utf8')
            raise
        finally:
            browser.close()
    after = snapshot()
    (ROOT / 'after-ui.json').write_text(json.dumps(after, indent=2), encoding='utf8')
    assert after == before, 'Public data changed during read-only UI verification; do not restore it automatically: ' + \
        ', '.join(table for table in before if before[table] != after.get(table))
    evidence.update({'unchangedPublicTables': len(before), 'realBusinessWrites': 0, 'browserErrors': errors,
                     'echartsWarnings': warnings, 'widths': [1440, 1024, 768, 390, 320]})
    evidence['balance'] = str(evidence['balance'])
    (ROOT / 'verification.json').write_text(json.dumps(evidence, indent=2), encoding='utf8')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
