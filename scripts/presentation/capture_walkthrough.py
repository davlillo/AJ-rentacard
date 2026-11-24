"""Capture the literal menu-order walkthrough without saving any business records."""
import json
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path('test-results/presentation/walkthrough')
ROOT.mkdir(parents=True, exist_ok=True)
env = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf8').splitlines()
           if '=' in line and not line.startswith('#'))
manifest = json.loads(Path('test-results/local-workspace/manifest.json').read_text(encoding='utf8'))
blocked = []
screens = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')

    def protect(route):
        url = route.request.url
        if not url.startswith(('http://127.0.0.1:3030/', 'http://127.0.0.1:55321/')):
            route.abort()
        elif '/rpc/' in url and re.search(r'/rpc/(execute_|record_|save_|issue_|deliver_|stage_|review_|link_)', url):
            blocked.append(url.split('/rpc/')[1])
            route.abort()
        else:
            route.continue_()

    def go(route):
        page.goto('http://127.0.0.1:3030/' + route, wait_until='networkidle')
        expect(page.locator('main h1')).to_be_visible()

    def capture(name, locator=None):
        page.wait_for_load_state('networkidle')
        if locator is None:
            page.screenshot(path=str(ROOT / (name + '.png')))
        else:
            locator.screenshot(path=str(ROOT / (name + '.png')))
        screens.append(name)

    page.route('**/*', protect)
    try:
        go('inicio/')
        page.locator('#aj-login-email').fill(env['AJ_LOCAL_OWNER_EMAIL'])
        page.locator('#aj-login-password').fill(env['AJ_LOCAL_OWNER_PASSWORD'])
        page.get_by_role('button', name='Ingresar', exact=True).click()
        expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
        capture('01-inicio')

        go('clientes/')
        capture('02-clientes')
        page.get_by_role('button', name='Ver cliente Miguel Castillo', exact=True).click()
        capture('02-ficha-miguel', page.get_by_role('dialog'))
        page.get_by_role('dialog').get_by_role('button', name='Cerrar', exact=True).click()
        page.get_by_role('button', name='Nuevo cliente', exact=True).click()
        capture('02-nuevo-cliente', page.get_by_role('dialog'))
        page.get_by_role('dialog').get_by_role('button', name='Cancelar', exact=True).click()

        go('vehiculos/')
        capture('03-vehiculos')
        page.locator('.vehicle-card').filter(has_text='P101-004').get_by_role('link', name='Ver expediente').click()
        expect(page.locator('.rental-operation h2')).to_contain_text('ALQ-00006')
        vehicle_url = page.url
        capture('03-expediente', page.locator('.rental-operation'))
        page.locator('.rental-operation').get_by_role('button', name='Cobrar saldo · $100.00', exact=True).click()
        expect(page.get_by_role('dialog').locator('fieldset')).to_be_enabled()
        expect(page.get_by_role('dialog').get_by_label('Destino del abono', exact=True).locator('option:checked')).to_contain_text('saldo $100.00')
        expect(page.get_by_role('dialog').get_by_text('Consultando cargos y recibos…', exact=True)).not_to_be_visible()
        capture('03-cobro-alquiler', page.get_by_role('dialog'))
        page.get_by_role('dialog').get_by_role('button', name='Cerrar', exact=True).click()
        page.get_by_role('link', name='Registrar devolución', exact=True).click()
        expect(page.get_by_role('button', name='Registrar devolución de alquiler', exact=True)).to_be_visible()
        capture('03-devolucion', page.locator('main .panel').first)
        page.goto(vehicle_url, wait_until='networkidle')
        history = page.locator('.vehicle-rentals details')
        history.locator('summary').click()
        history.get_by_role('link', name='Abrir alquiler →').first.click()
        page.get_by_role('button', name='Limpieza', exact=True).click()
        expect(page.locator('main')).to_contain_text('Limpieza revisada')
        capture('03-limpieza', page.locator('main .panel').first)

        go('calendario/')
        capture('04-calendario')
        capture('04-gantt', page.get_by_role('region', name='Planificación Gantt de vehículos', exact=True))
        page.get_by_role('button', name='Nueva reserva', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label('Cliente de reserva', exact=True).select_option(manifest['customers'][0])
        dialog.get_by_label('Vehículo de reserva', exact=True).select_option(manifest['vehicles'][0]['id'])
        dialog.get_by_label('Inicio de reserva', exact=True).fill('2026-11-13T09:00')
        dialog.get_by_label('Fin de reserva', exact=True).fill('2026-11-15T09:00')
        dialog.get_by_label('Tarifa diaria de reserva (USD)', exact=True).fill('40')
        capture('04-reserva', dialog)
        dialog.get_by_role('button', name='Cerrar', exact=True).click()

        go('taller/')
        capture('05-taller')
        page.get_by_label('Estado de los trabajos', exact=True).select_option('Entregados')
        capture('05-entregados')
        go('taller/ingreso/?id=' + manifest['activeJobs'][0])
        capture('05-trabajo')

        go('presupuestos/')
        capture('06-presupuestos')
        page.locator('tbody tr').filter(has_text='P101-006').get_by_role('button', name='Ver detalle', exact=True).click()
        expect(page.locator('.grand-total')).to_contain_text('$600.00')
        capture('06-detalle')

        go('cobros/')
        capture('07-cobros')
        page.get_by_label('Buscar operación de cobro', exact=True).fill('P101-006')
        card = page.locator('.collection-card')
        expect(card).to_have_count(1)
        card.get_by_role('button', name='Registrar abono', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.locator('fieldset')).to_be_enabled()
        target = dialog.get_by_label('Destino del abono', exact=True)
        target.select_option(target.locator('option').filter(has_text='CAR-00009').get_attribute('value'))
        dialog.get_by_label('Importe del abono (USD)', exact=True).fill('100')
        dialog.get_by_label('Cuenta o caja receptora', exact=True).fill('Caja principal')
        dialog.get_by_label('Referencia del pago', exact=True).fill('Abono parcial del Sentra')
        capture('07-abono', dialog)
        dialog.get_by_role('button', name='Cerrar', exact=True).click()

        go('libro-diario/')
        page.get_by_role('button', name='Hoy', exact=True).click()
        page.get_by_label('Cuenta o caja', exact=True).select_option('Caja principal')
        capture('08-diario')
        page.get_by_label('Buscar en el diario', exact=True).fill('Un comprobante de materiales')
        capture('08-compartido', page.get_by_role('article', name=re.compile('Un comprobante de materiales')))
        page.get_by_label('Buscar en el diario', exact=True).fill('')
        page.get_by_role('button', name='Registrar cobro', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.locator('fieldset')).to_be_enabled()
        dialog.get_by_label('Cliente del cobro', exact=True).select_option(manifest['customers'][5])
        dialog.get_by_label('Folio de taller o contrato del cobro (opcional)', exact=True).select_option('order:' + manifest['activeJobs'][0])
        target = dialog.get_by_label('Destino del abono', exact=True)
        target.select_option(target.locator('option').filter(has_text='CAR-00009').get_attribute('value'))
        capture('08-cobro', dialog)
        dialog.get_by_role('button', name='Cerrar', exact=True).click()
        assert not blocked, str(blocked)
    finally:
        browser.close()

(ROOT / 'capture-verification.json').write_text(json.dumps({'screens': screens, 'screenCount': len(screens),
    'businessWrites': 0, 'blockedWriteRequests': blocked}, indent=2), encoding='utf8')
print(json.dumps({'screensCaptured': len(screens), 'businessWrites': 0}))
