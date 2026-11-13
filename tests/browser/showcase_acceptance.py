"""Exercise the isolated showcase UI; never connect to the original workspace."""
import json
import re
import argparse
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

APP = 'http://127.0.0.1:3040'
API = 'http://127.0.0.1:56321'
ROOT = Path('test-results/showcase')


def assert_fits(page, context: str, scope: str = 'main *, [role=dialog] *') -> None:
    issues = page.evaluate("""scope => {
      const issues = [];
      if (document.documentElement.scrollWidth > innerWidth + 2) issues.push('page');
      for (const el of document.querySelectorAll(scope)) {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (r.width < 4 || r.height < 4 || r.right <= 0 || s.display === 'none' ||
            s.visibility === 'hidden' || el.closest('.sr-only, [aria-hidden=true]') ||
            ['INPUT','TEXTAREA','SELECT','OPTION','SVG','PATH'].includes(el.tagName)) continue;
        if (el.scrollWidth > el.clientWidth + 3 && el.clientWidth > 0)
          issues.push(el.tagName + '.' + String(el.className).slice(0,90) + ':' + el.scrollWidth + '/' + el.clientWidth);
        if (r.right > innerWidth + 3 || r.left < -3) issues.push('outside:' + el.tagName + '.' + String(el.className).slice(0,60));
      }
      return [...new Set(issues)].slice(0,20);
    }""", scope)
    assert not issues, context + ': ' + json.dumps(issues)


def go(page, route: str) -> None:
    page.goto(APP + '/' + route, wait_until='networkidle')
    expect(page.locator('main h1')).to_be_visible()
    page.wait_for_load_state('networkidle')


def download(page, button, name: str, pdf: bool = False) -> Path:
    with page.expect_download(timeout=60000) as pending:
        button.click()
    path = ROOT / name
    pending.value.save_as(path)
    data = path.read_bytes()
    assert len(data) > 100, name + ' is empty'
    if pdf:
        assert data.startswith(b'%PDF-') and b'%%EOF' in data[-100:], name + ' is not a PDF'
    return path


def verify_downloads(page, manifest: dict) -> None:
    page.set_viewport_size({'width': 320, 'height': 740})
    go(page, 'presupuestos/?id=' + manifest['quotes'][0])
    expect(page.locator('.grand-total')).to_contain_text('$600.00')
    download(page, page.get_by_role('button', name='Descargar PDF', exact=True), 'quote.pdf', pdf=True)
    go(page, 'vehiculos/alquiler/?id=' + manifest['currentRental'])
    for section in ['Resumen', 'Salida y devolución', 'Períodos y abonos', 'Gastos', 'Fotos y documentos', 'Contrato']:
        page.get_by_role('button', name=section, exact=True).click()
        page.wait_for_load_state('networkidle')
        assert_fits(page, '320px rental ' + section)
    page.get_by_text('Contratos versionados y aceptación', exact=True).click()
    expect(page.locator('main')).to_contain_text('Aceptado por DEMO')
    download(page, page.get_by_role('button', name='Descargar contrato V1', exact=True), 'contract.pdf', pdf=True)
    go(page, 'libro-diario')
    download(page, page.get_by_role('button', name='Exportar vista', exact=True), 'diary.csv')
    go(page, 'vehiculos/expediente/?id=' + manifest['vehicles'][0]['id'])
    page.get_by_role('button', name='Fotos y documentos', exact=True).click()
    photo = download(page, page.get_by_role('button', name='Descargar archivo', exact=True).first, 'reference.jpg')
    assert photo.read_bytes().startswith(b'\xff\xd8')
    print('PASS: quote PDF, accepted rental contract PDF, diary CSV and private reference image download.')


def main(phase: str) -> None:
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['workspace'] == 'aj-rentacar-showcase-v1'
    assert len(manifest['vehicles']) == 7
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True, reduced_motion='reduce')
        page.set_default_timeout(30000)
        errors: list[str] = []
        forbidden: list[str] = []
        mutations: list[str] = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def protect(route) -> None:
            url = route.request.url
            parsed = urlparse(url)
            if parsed.hostname not in ['127.0.0.1', 'localhost'] or parsed.port not in [3040, 56321]:
                forbidden.append(parsed.scheme + '://' + parsed.netloc + parsed.path)
                route.abort()
            else:
                route.continue_()

        page.route(re.compile(r'^https?://'), protect)
        page.on('request', lambda request: mutations.append(urlparse(request.url).path)
                if re.search(r'/rpc/(execute_|record_|issue_|save_|collect_|pay_)', request.url) else None)
        try:
            page.goto(APP + '/inicio', wait_until='networkidle')
            expect(page.get_by_role('heading', name='Ingresar al sistema', exact=True)).to_be_visible()
            expect(page.locator('main')).not_to_contain_text(re.compile(r'datos ficticios|demostraci[oó]n', re.IGNORECASE))
            assert page.get_by_label('Contraseña', exact=True).count() == 0
            # The hero intentionally clips aria-hidden artwork; inspect the usable
            # login panel and the document, not decorative off-canvas image bounds.
            assert_fits(page, 'showcase login', 'section[aria-labelledby="aj-login-title"] *')
            with page.expect_response(lambda response: response.url == API + '/showcase/session') as sign_in:
                page.get_by_role('button', name='Ingresar', exact=True).click()
            assert sign_in.value.status == 200
            expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
            page.wait_for_load_state('networkidle')
            keys = page.evaluate('Object.keys(localStorage).filter(key => key.startsWith("sb-"))')
            assert keys == ['sb-aj-showcase-auth-token'], 'Showcase session is not isolated'
            nav = page.get_by_role('navigation', name='Navegación principal', exact=True)
            expect(nav.get_by_role('link')).to_have_count(8)
            page.reload(wait_until='networkidle')
            expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
            expect(page.get_by_role('region', name='Entorno de demostración')).to_have_count(0)
            expect(page.get_by_role('button', name='Recorrido de presentación', exact=True)).to_have_count(0)

            for width, height in [(1440, 1000), (768, 1024), (390, 844), (320, 740)]:
                if phase != str(width):
                    continue
                page.set_viewport_size({'width': width, 'height': height})
                for route in ['inicio', 'clientes', 'vehiculos', 'taller', 'presupuestos', 'calendario', 'cobros', 'libro-diario']:
                    go(page, route)
                    if route == 'inicio':
                        expect(page.locator('.business-metric')).to_have_count(4)
                        expect(page.locator('main')).to_contain_text('$500.00')
                    elif route == 'clientes':
                        expect(page.locator('tbody tr')).to_have_count(7)
                    elif route == 'vehiculos':
                        tabs = page.get_by_role('tablist', name='Estado de la flota')
                        expect(tabs.get_by_role('tab')).to_have_count(4)
                        expect(page.locator('.vehicle-card')).to_have_count(5)
                        for label, count in [('Disponibles', 3), ('Alquilados', 1), ('Reservados', 1)]:
                            tabs.get_by_role('tab', name=re.compile('^' + label)).click()
                            expect(page.locator('.vehicle-card')).to_have_count(count)
                            assert_fits(page, f'{width}px fleet {label}')
                        tabs.get_by_role('tab', name=re.compile('^Toda la flota')).click()
                        expect(page.locator('.vehicle-card')).to_have_count(5)
                        page.wait_for_function("""() => [...document.querySelectorAll('.vehicle-card img')].length === 5 &&
                          [...document.querySelectorAll('.vehicle-card img')].every(image => image.complete && image.naturalWidth > 0)""")
                        page.get_by_role('button', name='Agregar vehículo', exact=True).click()
                        assert_fits(page, f'{width}px vehicle form')
                        page.get_by_role('button', name='Cancelar', exact=True).click()
                    elif route == 'taller':
                        expect(page.locator('tbody').first.locator('tr')).to_have_count(2)
                        page.get_by_label('Estado de los trabajos', exact=True).select_option('Entregados')
                        expect(page.locator('tbody').first.locator('tr')).to_have_count(3)
                        page.get_by_role('button', name='Tareas', exact=True).click()
                        page.get_by_label('Trabajo para las tareas', exact=True).select_option(manifest['activeJobs'][0])
                        expect(page.locator('main')).to_contain_text('Instalar kit de frenos')
                    elif route == 'presupuestos':
                        expect(page.locator('tbody tr')).to_have_count(5)
                        row = page.locator('tbody tr').filter(has_text='DEMO-106')
                        row.get_by_role('button', name='Ver detalle', exact=True).click()
                        expect(page.locator('.grand-total')).to_contain_text('$600.00')
                        page.get_by_text('Versiones y costos internos', exact=True).click()
                        versions = page.get_by_label('Versión del presupuesto', exact=True)
                        expect(versions.locator('option')).to_have_count(2)
                        versions.select_option(index=1)
                        expect(page.locator('.grand-total')).to_contain_text('$520.00')
                        versions.select_option(index=0)
                        expect(page.locator('.grand-total')).to_contain_text('$600.00')
                        page.locator('.page-heading').get_by_role('button', name='Editar presupuesto', exact=True).click()
                        expect(page.locator('.budget-line')).to_have_count(3)
                        page.get_by_role('button', name='Agregar mano de obra', exact=True).click()
                        page.get_by_label('Descripción 4', exact=True).fill('Unsaved demonstration addition')
                        page.get_by_label('Precio unitario 4', exact=True).fill('25')
                        expect(page.locator('.grand-total')).to_contain_text('$625.00')
                        assert_fits(page, f'{width}px complete quote editor')
                        page.get_by_role('button', name='Cancelar', exact=True).click()
                    elif route == 'calendario':
                        expect(page.get_by_role('gridcell')).to_have_count(42)
                        gantt = page.get_by_role('region', name='Planificación Gantt de vehículos', exact=True)
                        expect(gantt.get_by_role('listitem')).to_have_count(2)
                        gantt.get_by_label('Solo con compromisos', exact=True).uncheck()
                        expect(gantt.get_by_role('listitem')).to_have_count(5)
                        gantt.get_by_label('Estado en el Gantt', exact=True).select_option('Reservado')
                        expect(gantt.get_by_role('listitem')).to_have_count(1)
                        expect(gantt).to_contain_text('DEMO-105')
                        gantt.get_by_label('Estado en el Gantt', exact=True).select_option('Todos')
                        gantt.get_by_label('Solo con compromisos', exact=True).check()
                        gantt.screenshot(path=str(ROOT / f'gantt-{width}.png'))
                        gantt.get_by_role('button', name=re.compile(r'^DEMO-104 · Alquilado')).click()
                        expect(page.get_by_role('dialog')).to_contain_text('DEMO · Daniel Torres')
                        page.wait_for_load_state('networkidle')
                        assert_fits(page, f'{width}px Gantt rental dialog')
                        page.get_by_role('dialog').get_by_role('button', name='Cerrar', exact=True).click()
                        monthly = page.get_by_role('region', name='Calendario mensual de vehículos', exact=True)
                        monthly.get_by_role('button', name='Mes siguiente', exact=True).click()
                        expect(page.get_by_role('grid')).to_have_attribute('aria-label', '2026-12')
                        expect(gantt).to_contain_text('1 dic')
                        monthly.get_by_role('button', name='Hoy', exact=True).click()
                        expect(page.get_by_role('grid')).to_have_attribute('aria-label', manifest['today'][:7])
                    elif route == 'cobros':
                        cards = page.locator('.collection-card')
                        expect(cards.first).to_contain_text('DEMO-106')
                        expect(cards.first.locator('.amount-outstanding dd')).to_have_text('$400.00')
                        expect(cards.nth(1)).to_contain_text('DEMO-107')
                        page.get_by_label('Buscar operación de cobro', exact=True).fill('DEMO-106')
                        expect(cards).to_have_count(1)
                        cards.get_by_text('Ver cargos, abonos y gastos', exact=True).click()
                        expect(cards.locator('.collection-breakdown')).to_contain_text('$200.00')
                        cards.get_by_role('button', name='Registrar abono', exact=True).click()
                        expect(page.get_by_role('dialog')).to_contain_text('Cobros y anticipos')
                        assert_fits(page, f'{width}px linked receipt form')
                        page.get_by_role('dialog').get_by_role('button', name='Cerrar', exact=True).click()
                    elif route == 'libro-diario':
                        page.get_by_role('button', name='Hoy', exact=True).click()
                        page.get_by_label('Cuenta o caja', exact=True).select_option('Caja DEMO')
                        expect(page.locator('main')).to_contain_text('$1,478.00')
                        page.get_by_label('Buscar en el diario', exact=True).fill('Un comprobante de materiales')
                        shared = page.get_by_role('article', name=re.compile('Un comprobante de materiales'))
                        expect(shared).to_have_count(1)
                        expect(shared.get_by_role('link')).to_have_count(3)
                        for amount in ['$75.00', '$65.00', '$40.00']:
                            expect(shared).to_contain_text(amount)
                    assert_fits(page, f'{width}px {route}')
                print(f'PASS: eight modules, fleet filters, connected money and no horizontal overflow at {width}px.')

            page.set_viewport_size({'width': 320, 'height': 740})
            for index, vehicle in enumerate(manifest['vehicles'] if phase == 'cases' else []):
                go(page, 'vehiculos/expediente/?id=' + vehicle['id'])
                expect(page.locator('main h1')).to_contain_text(vehicle['plate'])
                expect(page.locator('.case-overview img')).to_be_visible()
                if index < 3:
                    expect(page.locator('.case-money').first).to_contain_text('Costo presupuestado')
                    expect(page.locator('.case-money').first).to_contain_text(['$75.00', '$65.00', '$40.00'][index])
                    page.get_by_role('button', name='Ingresos', exact=True).click()
                    expect(page.locator('main')).to_contain_text('Entregado')
                if index < 5:
                    page.get_by_role('button', name='Alquileres', exact=True).click()
                    expect(page.locator('main')).to_contain_text('Devuelto')
                page.get_by_role('button', name='Fotos y documentos', exact=True).click()
                expect(page.get_by_role('heading', name='Fotos y documentos', exact=True)).to_be_visible()
                assert_fits(page, '320px permanent history ' + vehicle['plate'])

            for job_id in (manifest['closedJobs'] + manifest['activeJobs'] if phase == 'cases' else []):
                go(page, 'taller/ingreso/?id=' + job_id)
                for section in ['Resumen', 'Recepción', 'Presupuestos', 'Costos', 'Cargos y abonos', 'Fotos y documentos', 'Tareas', 'Salida']:
                    page.get_by_role('button', name=section, exact=True).click()
                    page.wait_for_load_state('networkidle')
                    assert_fits(page, '320px workshop ' + job_id + ' ' + section)
            if phase == 'cases':
                print('PASS: seven permanent histories and all eight sections of three closed and two active workshop folios.')
            if phase == 'downloads':
                verify_downloads(page, manifest)
            assert not errors, str(errors)
            assert not forbidden, 'Attempted requests outside showcase: ' + str(forbidden)
            assert not mutations, 'Read-only acceptance attempted business mutations: ' + str(mutations)
        except Exception:
            try:
                page.screenshot(path=str(ROOT / 'browser-failure.png'), timeout=5000)
            except Exception as capture_error:
                print('Failure screenshot unavailable: ' + type(capture_error).__name__)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    phases = ['1440', '768', '390', '320', 'cases', 'downloads']
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['all'] + phases, default='all')
    args = parser.parse_args()
    if args.phase == 'all':
        # Release Playwright's request/response history between phases on constrained
        # developer machines instead of retaining every image and script response.
        for phase in phases:
            subprocess.run([sys.executable, '-X', 'utf8', '-B', __file__, '--phase', phase], check=True)
        (ROOT / 'browser-verification.json').write_text(json.dumps({
            'passed': True, 'widths': [1440, 768, 390, 320], 'modules': 8, 'vehicles': 7,
            'workshopFolios': 5, 'downloads': 4, 'businessWrites': 0,
            'originalRequests': 0, 'pageErrors': 0,
        }, indent=2), encoding='utf-8')
    else:
        main(args.phase)
