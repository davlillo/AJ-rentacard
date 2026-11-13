"""Read-only acceptance of the normal AJ workspace after its authorized replacement."""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
from showcase_acceptance import assert_fits

APP = 'http://127.0.0.1:3030'
API = 'http://127.0.0.1:55321'
ROOT = Path('test-results/local-workspace')


def go(page, route: str) -> None:
    page.goto(APP + '/' + route, wait_until='networkidle')
    expect(page.locator('main h1')).to_be_visible()


def download(page, button, filename: str, pdf: bool = False) -> bytes:
    with page.expect_download(timeout=60000) as pending:
        button.click()
    path = ROOT / filename
    pending.value.save_as(path)
    content = path.read_bytes()
    assert len(content) > 100, 'Empty download: ' + filename
    if pdf:
        assert content.startswith(b'%PDF-') and b'%%EOF' in content[-100:]
    return content


def main(phase: str) -> None:
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['workspace'] == 'aj-local-workspace-v1'
    env = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf-8').splitlines()
               if '=' in line and not line.startswith('#'))
    assert env['NEXT_PUBLIC_SUPABASE_URL'] == API
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce',
                                accept_downloads=True)
        errors: list[str] = []
        forbidden: list[str] = []
        mutations: list[str] = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def protect(route) -> None:
            parsed = urlparse(route.request.url)
            if parsed.hostname != '127.0.0.1' or parsed.port not in [3030, 55321]:
                forbidden.append(parsed.netloc + parsed.path)
                route.abort()
            else:
                route.continue_()

        page.route(re.compile(r'^https?://'), protect)
        page.on('request', lambda request: mutations.append(urlparse(request.url).path)
                if re.search(r'/rpc/(execute_|record_|issue_|save_|collect_|pay_)', request.url) else None)
        try:
            go(page, 'inicio')
            expect(page.get_by_role('heading', name='Ingresar al sistema', exact=True)).to_be_visible()
            page.get_by_label('Correo electrónico', exact=True).fill(env['AJ_LOCAL_OWNER_EMAIL'])
            page.get_by_label('Contraseña', exact=True).fill(env['AJ_LOCAL_OWNER_PASSWORD'])
            page.get_by_role('button', name='Ingresar', exact=True).click()
            expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
            page.wait_for_load_state('networkidle')
            keys = page.evaluate('Object.keys(localStorage).filter(key => key.startsWith("sb-"))')
            assert len(keys) == 1 and keys[0] != 'sb-aj-showcase-auth-token'
            expect(page.get_by_role('navigation', name='Navegación principal').get_by_role('link')).to_have_count(8)
            page.reload(wait_until='networkidle')
            expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()

            for width, height in [(1440, 1000), (768, 1024), (390, 844), (320, 740)]:
                if phase != str(width):
                    continue
                page.set_viewport_size({'width': width, 'height': height})
                for route in ['inicio', 'clientes', 'vehiculos', 'taller', 'presupuestos', 'calendario',
                              'cobros', 'libro-diario']:
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
                        page.wait_for_function("""() => [...document.querySelectorAll('.vehicle-card img')].length === 5 &&
                            [...document.querySelectorAll('.vehicle-card img')].every(i => i.complete && i.naturalWidth > 0)""")
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
                        page.locator('tbody tr').filter(has_text='P101-006').get_by_role(
                            'button', name='Ver detalle', exact=True).click()
                        expect(page.locator('.grand-total')).to_contain_text('$600.00')
                        page.get_by_text('Versiones y costos internos', exact=True).click()
                        versions = page.get_by_label('Versión del presupuesto', exact=True)
                        expect(versions.locator('option')).to_have_count(2)
                        versions.select_option(index=1)
                        expect(page.locator('.grand-total')).to_contain_text('$520.00')
                        versions.select_option(index=0)
                        page.locator('.page-heading').get_by_role('button', name='Editar presupuesto', exact=True).click()
                        expect(page.locator('.budget-line')).to_have_count(3)
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
                        expect(gantt).to_contain_text('P101-005')
                        gantt.get_by_label('Estado en el Gantt', exact=True).select_option('Todos')
                        gantt.get_by_label('Solo con compromisos', exact=True).check()
                        gantt.screenshot(path=str(ROOT / f'gantt-{width}.png'))
                        gantt.get_by_role('button', name=re.compile(r'^P101-004 · Alquilado')).click()
                        expect(page.get_by_role('dialog')).to_contain_text('Daniel Torres')
                        page.wait_for_load_state('networkidle')
                        assert_fits(page, f'{width}px Gantt rental dialog')
                        page.get_by_role('dialog').get_by_role('button', name='Cerrar', exact=True).click()
                        monthly = page.get_by_role('region', name='Calendario mensual de vehículos', exact=True)
                        monthly.get_by_role('button', name='Mes siguiente', exact=True).click()
                        expect(page.get_by_role('grid')).not_to_have_attribute('aria-label', manifest['today'][:7])
                        monthly.get_by_role('button', name='Hoy', exact=True).click()
                        expect(page.get_by_role('grid')).to_have_attribute('aria-label', manifest['today'][:7])
                    elif route == 'cobros':
                        cards = page.locator('.collection-card')
                        expect(cards.first).to_contain_text('P101-006')
                        expect(cards.first.locator('.amount-outstanding dd')).to_have_text('$400.00')
                        page.get_by_label('Buscar operación de cobro', exact=True).fill('P101-006')
                        expect(cards).to_have_count(1)
                        cards.get_by_text('Ver cargos, abonos y gastos', exact=True).click()
                        expect(cards.locator('.collection-breakdown')).to_contain_text('$200.00')
                        cards.get_by_role('button', name='Registrar abono', exact=True).click()
                        assert_fits(page, f'{width}px linked receipt form')
                        page.get_by_role('dialog').get_by_role('button', name='Cerrar', exact=True).click()
                    elif route == 'libro-diario':
                        page.get_by_role('button', name='Hoy', exact=True).click()
                        page.get_by_label('Cuenta o caja', exact=True).select_option('Caja principal')
                        expect(page.locator('main')).to_contain_text('$1,478.00')
                        page.get_by_label('Buscar en el diario', exact=True).fill('Un comprobante de materiales')
                        shared = page.get_by_role('article', name=re.compile('Un comprobante de materiales'))
                        expect(shared).to_have_count(1)
                        expect(shared.get_by_role('link')).to_have_count(3)
                        for amount in ['$75.00', '$65.00', '$40.00']:
                            expect(shared).to_contain_text(amount)
                    expect(page.locator('main')).not_to_contain_text(re.compile(r'\bDEMO\b|datos ficticios|demostraci[oó]n', re.I))
                    assert_fits(page, f'{width}px {route}')
                print(f'PASS: normal workspace, eight modules and no horizontal overflow at {width}px.')

            page.set_viewport_size({'width': 320, 'height': 740})
            if phase == 'cases':
                for index, vehicle in enumerate(manifest['vehicles']):
                    go(page, 'vehiculos/expediente/?id=' + vehicle['id'])
                    expect(page.locator('main h1')).to_contain_text(vehicle['plate'])
                    expect(page.locator('.case-overview img')).to_be_visible()
                    if index < 3:
                        page.get_by_role('button', name='Ingresos', exact=True).click()
                        expect(page.locator('main')).to_contain_text('Entregado')
                    if index < 5:
                        page.get_by_role('button', name='Alquileres', exact=True).click()
                        expect(page.locator('main')).to_contain_text('Devuelto')
                    page.get_by_role('button', name='Fotos y documentos', exact=True).click()
                    assert_fits(page, 'Vehicle history ' + vehicle['plate'])
                for order in manifest['closedJobs'] + manifest['activeJobs']:
                    go(page, 'taller/ingreso/?id=' + order)
                    for section in ['Resumen', 'Recepción', 'Presupuestos', 'Costos', 'Cargos y abonos',
                                    'Fotos y documentos', 'Tareas', 'Salida']:
                        page.get_by_role('button', name=section, exact=True).click()
                        page.wait_for_load_state('networkidle')
                        assert_fits(page, order + ' ' + section)
                print('PASS: seven vehicle histories and five workshop folios.')
            elif phase == 'downloads':
                go(page, 'presupuestos/?id=' + manifest['quotes'][0])
                download(page, page.get_by_role('button', name='Descargar PDF', exact=True), 'quote.pdf', pdf=True)
                go(page, 'vehiculos/alquiler/?id=' + manifest['currentRental'])
                page.get_by_role('button', name='Contrato', exact=True).click()
                page.get_by_text('Contratos versionados y aceptación', exact=True).click()
                expect(page.locator('main')).to_contain_text('Aceptado por Daniel Torres')
                download(page, page.get_by_role('button', name='Descargar contrato V1', exact=True), 'contract.pdf', pdf=True)
                go(page, 'libro-diario')
                download(page, page.get_by_role('button', name='Exportar vista', exact=True), 'diary.csv')
                go(page, 'vehiculos/expediente/?id=' + manifest['vehicles'][0]['id'])
                page.get_by_role('button', name='Fotos y documentos', exact=True).click()
                content = download(page, page.get_by_role('button', name='Descargar archivo', exact=True).first, 'reference.jpg')
                assert content.startswith(b'\xff\xd8')
                print('PASS: quote PDF, contract PDF, diary CSV and private vehicle image.')
            assert not errors, str(errors)
            assert not forbidden, str(forbidden)
            assert not mutations, str(mutations)
        except Exception:
            page.screenshot(path=str(ROOT / 'browser-failure.png'), timeout=5000)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    phases = ['1440', '768', '390', '320', 'cases', 'downloads']
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['all'] + phases, default='all')
    args = parser.parse_args()
    if args.phase == 'all':
        for phase in phases:
            subprocess.run([sys.executable, '-X', 'utf8', '-B', __file__, '--phase', phase], check=True)
        (ROOT / 'browser-verification.json').write_text(json.dumps({
            'passed': True, 'app': APP, 'api': API, 'modules': 8, 'widths': [1440, 768, 390, 320],
            'vehicleHistories': 7, 'workshopFolios': 5, 'downloads': 4, 'businessWrites': 0,
            'outsideWorkspaceRequests': 0, 'pageErrors': 0,
        }, indent=2), encoding='utf-8')
    else:
        main(args.phase)
