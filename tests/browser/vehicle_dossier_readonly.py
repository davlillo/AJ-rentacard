"""Verify the real dossier UI using synthetic HTTP; never forward business or Auth requests."""
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

APP = 'http://127.0.0.1:3030'
ROOT = Path('test-results/vehicle-dossier')
USER = '00000000-0000-4000-8000-000000009901'
CUSTOMER = {'id': 'synthetic-customer', 'name': 'Synthetic dossier customer', 'phone': '',
            'email': '', 'document': '', 'type': 'Personal', 'version': 1}
VEHICLE = {'id': 'synthetic-vehicle', 'plate': 'SYNTHETIC-ONLY', 'brand': 'Toyota', 'model': 'Corolla',
           'km': 12000, 'year': 2026, 'color': 'Blanco', 'version': 1, 'status': 'Disponible',
           'in_rental_fleet': True, 'inRentalFleet': True, 'daily': 45, 'ownership': 'Propio',
           'category': 'Sedán', 'registered_holder': 'Synthetic holder', 'commercial_line': 'Sedán'}
RENTALS = [
    {'id': 'rental-1', 'folio_number': 99001, 'status': 'Confirmada', 'rental_state': 'Devuelto'},
    {'id': 'rental-2', 'folio_number': 99002, 'status': 'Cancelada', 'rental_state': 'Preparado'},
    {'id': 'rental-3', 'folio_number': 99003, 'status': 'Borrador', 'rental_state': 'Preparado'},
]
for index, rental in enumerate(RENTALS):
    rental.update(vehicle_id=VEHICLE['id'], customer_id=CUSTOMER['id'], customer_snapshot=CUSTOMER,
                  vehicle_snapshot=VEHICLE, starts_at=f'2026-11-{14-index}T12:00:00Z',
                  ends_at=f'2026-11-{15-index}T12:00:00Z', daily_rate=45, total=45,
                  cleaning_minutes=30, version=1, created_at='2026-11-01T12:00:00Z',
                  actual_departure_at='2026-11-14T12:00:00Z' if index == 0 else None,
                  actual_return_at='2026-11-15T12:00:00Z' if index == 0 else None)
ORDERS = [
    {'id': 'OT-99001', 'service': 'Synthetic oil service', 'status': 'Entregado', 'internal_job': True},
    {'id': 'OT-99002', 'service': 'Synthetic quote only', 'status': 'Presupuesto', 'internal_job': False},
]
for order in ORDERS:
    order.update(vehicle_id=VEHICLE['id'], vehicleId=VEHICLE['id'], customer_id=CUSTOMER['id'],
                 customerId=CUSTOMER['id'], occurred_at='2026-11-10T12:00:00Z',
                 created_at='2026-11-09T12:00:00Z', pending_fields=[], area='Mecánica', hours=1,
                 estimate=0, paid=0, due='2026-11-16', technician='', version=1)
FILES = [
    {'id': 'public-file', 'purpose': 'Soporte', 'financial': False, 'name': 'Synthetic vehicle evidence.pdf'},
    {'id': 'private-file', 'purpose': 'Soporte', 'financial': True, 'name': 'PRIVATE-FINANCIAL-EVIDENCE.pdf'},
]
for record in FILES:
    record.update(vehicle_id=VEHICLE['id'], order_id=None, reservation_id=None, mime='application/pdf',
                  size=10, created_at='2026-11-14T12:00:00Z')
INSPECTIONS = [
    {'id': 'stored-departure', 'reservation_id': 'rental-1', 'kind': 'Salida', 'km': 12000, 'fuel': 90,
     'condition': 'Stored departure condition', 'accessories': 'Spare wheel', 'evidence': 'Existing evidence',
     'occurred_at': '2026-11-14T12:00:00Z', 'created_by': USER},
    {'id': 'stored-return', 'reservation_id': 'rental-1', 'kind': 'Retorno', 'km': 11999, 'fuel': None,
     'condition': 'Existing wrong reading stays untouched', 'accessories': '',
     'evidence': 'Historic return', 'occurred_at': '2026-11-15T12:00:00Z', 'created_by': USER},
]
STATE = {'denied': set(), 'server_finance': True, 'hold': False, 'fail': False}
HELD, BLOCKED, ERRORS, READS = [], [], [], []


def amounts(charged, paid, balance):
    return {'documents': [{'id': 'grouped-document', 'amount': 99999, 'scope_amount': charged,
                           'scope_balance': balance, 'grouped': True, 'description': 'Synthetic grouped charge',
                           'issued_on': '2026-11-14', 'due_on': '2026-11-30'}],
            'applications': [{'id': 'applied', 'document_id': 'grouped-document', 'payment_id': 'receipt',
                              'kind': 'Aplicacion', 'amount': 88888, 'scope_amount': paid + 5,
                              'effective_on': '2026-11-15', 'reason': 'Synthetic scoped application'},
                             {'id': 'reversed', 'document_id': 'grouped-document', 'payment_id': 'receipt',
                              'kind': 'Reversion', 'amount': 9999, 'scope_amount': 5,
                              'effective_on': '2026-11-16', 'reason': 'Synthetic scoped reversal'}],
            'expenses': [{'id': 'expense', 'amount': 77777, 'scope_amount': 19, 'shared': True,
                          'date': '2026-11-16', 'concept': 'Synthetic shared expense', 'account': 'Cash'}],
            'payments': [{'amount': 88888}], 'advances': [{'available_amount': 66666}],
            'costs': [], 'quotes': []}


def case_file(scope=None):
    rental = next((row for row in RENTALS if row['id'] == scope), None)
    order = next((row for row in ORDERS if row['id'] == scope), None)
    values = {'rental-1': (31, 7, 23), 'rental-2': (52, 12, 39),
              'rental-3': (0, 0, 0), 'OT-99001': (71, 17, 49), 'OT-99002': (0, 0, 0)}
    result = {'vehicle': VEHICLE, 'financialAccess': STATE['server_finance'],
              'reservations': [rental] if rental else ([] if scope else RENTALS),
              'orders': [order] if order else ([] if scope else ORDERS),
              'commitments': [], 'files': FILES,
              'inspections': [{'id': 'workshop-review', 'order_id': 'OT-99001', 'km': 11000, 'fuel': 70,
                               'condition': 'Stored workshop condition', 'accessories': 'Keys',
                               'created_at': '2026-11-10T12:00:00Z'}]}
    result.update(amounts(*values.get(scope, (1234, 215, 777))))
    return copy.deepcopy(result)


def protect(route):
    request, url = route.request, urlparse(route.request.url)
    if url.hostname == '127.0.0.1' and url.port == 3030:
        if request.method in ['GET', 'HEAD']:
            route.continue_()
        else:
            BLOCKED.append(url.path)
            route.abort()
        return
    # Strict allowlist. No route.fetch / continue for any API or Auth request.
    if request.method == 'OPTIONS':
        route.fulfill(status=204, headers={'access-control-allow-origin': '*',
                      'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
        return
    resource = url.path.split('/')[-1]
    if '/auth/v1/' in url.path:
        route.fulfill(json={'user': {'id': USER, 'email': 'fixture@example.invalid'}})
    elif '/rest/v1/rpc/' in url.path:
        body = request.post_data_json
        if resource in ['has_permission', 'has_task_access']:
            route.fulfill(json=body.get('permission', 'tasks.read') not in STATE['denied'])
        elif resource == 'workshop_assignees':
            route.fulfill(json=[])
        elif resource in ['vehicle_case_file', 'rental_case_file']:
            scope = body.get('reservation_id') or body.get('order_id')
            READS.append((resource, scope))
            if STATE['hold'] and scope == 'rental-1':
                HELD.append(route)
            elif STATE['fail'] and scope:
                route.fulfill(status=503, json={'message': 'SYNTHETIC_FAILURE'})
            else:
                route.fulfill(json=case_file(scope))
        elif resource == 'vehicle_file_content':
            assert body['file_id'] == 'public-file'
            route.fulfill(json={'mime': 'application/pdf', 'name': 'Synthetic.pdf', 'base64': 'U3ludGhldGlj'})
        else:
            BLOCKED.append(resource)
            route.abort()
    elif '/rest/v1/' in url.path and request.method == 'GET':
        READS.append((resource, None))
        records = {'customers': [CUSTOMER], 'vehicles': [VEHICLE], 'work_orders': ORDERS,
                   'reservations': [], 'rental_inspections': INSPECTIONS, 'vehicle_files': []}
        route.fulfill(json=records.get(resource, []))
    else:
        BLOCKED.append(url.path)
        route.abort()


def go(page, section='summary'):
    page.goto(APP + '/vehiculos/expediente/?id=' + VEHICLE['id'] + '&seccion=' + section,
              wait_until='networkidle')
    expect(page.get_by_test_id('vehicle-dossier')).to_be_visible()


def tab(page, label):
    return page.get_by_role('navigation', name='Secciones del expediente').get_by_role('button', name=label, exact=True)


def fit(page):
    page.evaluate('window.scrollTo(0, 0)')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'
    for button in page.locator('[data-testid=vehicle-dossier] button:visible').all():
        assert button.bounding_box()['height'] >= (44 if page.viewport_size['width'] <= 600 else 36) - 0.1


def check_detail(page, label, row, expected, marker, width, labels=None, release=False):
    tab(page, label).click()
    table = page.get_by_role('table', name=label, exact=True)
    trigger = table.locator('tbody tr').nth(row).get_by_role('button', name='Ver detalle')
    trigger.click()
    dialog = page.get_by_role('dialog')
    expect(dialog.get_by_test_id('scoped-summary')).to_be_visible()
    expect(dialog.locator('form,input,textarea,select')).to_have_count(0)
    if release:
        # The release of the vehicle is confirmed from this dossier, not from the rental folio.
        region = dialog.get_by_role('region', name='Liberación del vehículo')
        expect(region).to_be_visible()
        expect(region).to_contain_text('Liberar el vehículo')
        expect(region).to_contain_text('no cobra nada')
        expect(region).not_to_contain_text('Limpieza')
    expect(dialog).to_contain_text(marker)
    expect(dialog.locator('dl[aria-label="Importes del alcance consultado"] dd')).to_have_text(expected)
    if labels:
        expect(dialog.locator('dl[aria-label="Importes del alcance consultado"] dt')).to_have_text(labels)
    expect(dialog).not_to_contain_text('$1,234.00')
    expect(dialog).not_to_contain_text('$99,999.00')
    dialog.screenshot(path=str(ROOT / f'{label.split()[-1]}-detail-{row}-{width}.png'))
    dialog.locator('dl[aria-label="Importes del alcance consultado"]').scroll_into_view_if_needed()
    dialog.screenshot(path=str(ROOT / f'{label.split()[-1]}-detail-money-{row}-{width}.png'))
    page.keyboard.press('Escape')
    expect(dialog).to_have_count(0)
    expect(trigger).to_be_focused()


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    public_url = next(line.split('=', 1)[1].strip().strip('"')
                      for line in Path('.env.local').read_text(encoding='utf8').splitlines()
                      if line.startswith('NEXT_PUBLIC_SUPABASE_URL='))
    storage_key = 'sb-' + urlparse(public_url).hostname.split('.')[0] + '-auth-token'
    session = {'access_token': 'synthetic-never-forwarded', 'refresh_token': 'synthetic-refresh',
               'expires_at': 4102444800, 'expires_in': 3600, 'token_type': 'bearer',
               'user': {'id': USER, 'email': 'fixture@example.invalid', 'aud': 'authenticated',
                        'role': 'authenticated', 'app_metadata': {}, 'user_metadata': {}}}
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, timezone_id='Asia/Tokyo',
                                reduced_motion='reduce')
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: ERRORS.append(str(error)))
        try:
            go(page)
            assert not any(resource == 'rental_inspections' for resource, _ in READS), 'No inspection prefetch'
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                tab(page, 'Resumen').click()
                nav = page.get_by_role('navigation', name='Secciones del expediente')
                expect(nav.get_by_role('button')).to_have_text([
                    'Resumen', 'Historial de alquileres', 'Historial de mantenimientos', 'Ingresos', 'Documentación'])
                expect(page.locator('[data-chart=apache-echarts] svg')).to_have_count(3)
                assert page.locator('[data-chart=apache-echarts] svg path').count() > 15
                expect(page.locator('dl[aria-label="Importes del alcance consultado"] dd')).to_have_text([
                    '$1,234.00', '$215.00', '$777.00', '$19.00'])
                fit(page)
                page.screenshot(path=str(ROOT / f'summary-{width}.png'), full_page=True)
                tab(page, 'Historial de alquileres').click()
                expect(page.get_by_role('table', name='Historial de alquileres').locator('tbody tr')).to_have_count(3)
                expect(page.get_by_role('table', name='Historial de alquileres')).to_contain_text('Borrador')
                expect(page.get_by_role('table', name='Historial de alquileres')).to_contain_text('Cancelada')
                fit(page)
                page.screenshot(path=str(ROOT / f'rentals-{width}.png'), full_page=True)
                check_detail(page, 'Historial de alquileres', 0, ['$45.00', '$37.00', '$31.00', '$7.00', '$19.00'],
                             'Existing wrong reading stays untouched', width,
                             ['Lo acordado', 'Lo pendiente', 'Importes emitidos al cliente', 'Cobros aplicados',
                              'Egresos vinculados'], release=True)
                check_detail(page, 'Historial de alquileres', 1, ['$45.00', '$39.00', '$52.00', '$12.00', '$19.00'],
                             'Cancelada', width,
                             ['Lo acordado', 'Lo pendiente', 'Importes emitidos al cliente', 'Cobros aplicados',
                              'Egresos vinculados'])
                tab(page, 'Historial de mantenimientos').click()
                expect(page.get_by_role('table', name='Historial de mantenimientos').locator('tbody tr')).to_have_count(2)
                fit(page)
                page.screenshot(path=str(ROOT / f'maintenance-{width}.png'), full_page=True)
                check_detail(page, 'Historial de mantenimientos', 0, ['$71.00', '$17.00', '$49.00', '$19.00'],
                             'Stored workshop condition', width,
                             ['Importes emitidos al cliente', 'Cobros aplicados', 'Saldo pendiente',
                              'Egresos vinculados'])
                check_detail(page, 'Historial de mantenimientos', 1, ['$0.00', '$0.00', '$0.00', '$19.00'],
                             'Sin recepción', width,
                             ['Importes emitidos al cliente', 'Cobros aplicados', 'Saldo pendiente',
                              'Egresos vinculados'])
                tab(page, 'Ingresos').click()
                expect(page.get_by_role('table', name='Movimientos financieros del vehículo').locator('tbody tr')).to_have_count(4)
                expect(page.get_by_role('table', name='Movimientos financieros del vehículo')).to_contain_text('Reversión')
                expect(page.get_by_role('table', name='Movimientos financieros del vehículo')).to_contain_text('-$5.00')
                fit(page)
                page.screenshot(path=str(ROOT / f'financial-{width}.png'), full_page=True)
                tab(page, 'Documentación').click()
                expect(page.locator('main')).to_contain_text('PRIVATE-FINANCIAL-EVIDENCE.pdf')
                expect(page.get_by_role('button', name='Guardar archivo en este expediente')).to_be_visible()
                fit(page)
                page.screenshot(path=str(ROOT / f'documents-{width}.png'), full_page=True)
            page.set_viewport_size({'width': 1440, 'height': 1000})
            # Close a pending read, select another record, then deliver the obsolete response.
            STATE['hold'] = True
            tab(page, 'Historial de alquileres').click()
            triggers = page.get_by_role('table', name='Historial de alquileres').get_by_role('button', name='Ver detalle')
            with page.expect_request(lambda request: '/rpc/rental_case_file' in request.url):
                triggers.nth(0).click()
            expect(page.get_by_role('dialog')).to_contain_text('Consultando solo esta operación')
            page.keyboard.press('Escape')
            triggers.nth(1).click()
            expect(page.get_by_role('dialog')).to_contain_text('$52.00')
            assert HELD, 'At least one selected-scope response must be delayed'
            STATE['hold'] = False
            # React development Strict Mode can start two identical read effects.
            for route in HELD:
                route.fulfill(json=case_file('rental-1'))
            HELD.clear()
            expect(page.get_by_role('dialog')).not_to_contain_text('Existing wrong reading')
            page.keyboard.press('Escape')
            STATE['fail'] = True
            triggers.nth(0).click()
            expect(page.get_by_role('dialog')).to_contain_text('No se pudo consultar este detalle')
            expect(page.get_by_role('dialog')).not_to_contain_text('$1,234.00')
            STATE['fail'] = False
            page.get_by_role('button', name='Reintentar detalle').click()
            expect(page.get_by_role('dialog')).to_contain_text('$31.00')
            page.keyboard.press('Escape')
            # Refresh preserves selection and an administration draft without submitting it.
            page.get_by_role('button', name='Administrar vehículo', exact=True).click()
            page.get_by_text('Completar o corregir datos', exact=True).click()
            page.get_by_role('dialog').locator('input[name=plate]').fill('UNSAVED-DRAFT')
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            page.wait_for_load_state('networkidle')
            expect(page.get_by_role('dialog').locator('input[name=plate]')).to_have_value('UNSAVED-DRAFT')
            page.keyboard.press('Escape')
            expect(tab(page, 'Historial de alquileres')).to_have_attribute('aria-pressed', 'true')
            page.get_by_role('button', name='Actualizar expediente', exact=True).click()
            expect(tab(page, 'Historial de alquileres')).to_have_attribute('aria-pressed', 'true')
            STATE['denied'] = {'expenses.write'}
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            tab(page, 'Ingresos').click()
            expect(page.get_by_role('button', name='Registrar gasto vinculado')).to_have_count(0)
            tab(page, 'Documentación').click()
            expect(page.get_by_role('button', name='Guardar archivo en este expediente')).to_be_visible()
            expect(page.get_by_label('Soporte financiero (restringir su consulta)')).to_have_count(0)
            tab(page, 'Historial de alquileres').click()
            # Revoke current permission while the API deliberately still returns cached privileged data.
            triggers.nth(0).click()
            expect(page.get_by_role('dialog')).to_contain_text('$31.00')
            STATE['denied'] = {'expenses.read', 'expenses.write', 'orders.write', 'vehicles.write'}
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(page.get_by_role('dialog')).to_contain_text('Información financiera restringida')
            expect(page.locator('body')).not_to_contain_text('$31.00')
            expect(page.locator('body')).not_to_contain_text('$1,234.00')
            page.keyboard.press('Escape')
            expect(page.get_by_role('button', name='Administrar vehículo', exact=True)).to_have_count(0)
            tab(page, 'Documentación').click()
            expect(page.locator('body')).not_to_contain_text('PRIVATE-FINANCIAL-EVIDENCE.pdf')
            expect(page.get_by_role('button', name='Guardar archivo en este expediente')).to_have_count(0)
            expect(page.get_by_role('button', name='Descargar archivo')).to_have_count(1)
            with page.expect_download():
                page.get_by_role('button', name='Descargar archivo').click()
            tab(page, 'Ingresos').click()
            expect(page.locator('main')).to_contain_text('Información financiera restringida')
            expect(page.locator('main table')).to_have_count(0)
            tab(page, 'Resumen').click()
            expect(page.locator('[data-chart=apache-echarts] svg')).to_have_count(2)
            expect(page.locator('main [aria-label="Importes del alcance consultado"]')).to_have_count(0)
            page.screenshot(path=str(ROOT / 'restricted.png'), full_page=True)
            # Server flag alone must also hide finances, even with current permission restored.
            STATE['denied'] = set()
            STATE['server_finance'] = False
            go(page, 'financial')
            expect(page.locator('main')).to_contain_text('Información financiera restringida')
            go(page, 'Ingresos')
            expect(tab(page, 'Historial de mantenimientos')).to_have_attribute('aria-pressed', 'true')
            go(page, 'Datos%20de%20flota')
            expect(page.get_by_role('dialog', name='Administrar vehículo')).to_be_visible()
            page.keyboard.press('Escape')
            # Explicit order scope uses the workshop pipeline, preserving the legacy reception link.
            STATE['server_finance'] = True
            page.goto(APP + '/taller/ingreso/?id=OT-99001&seccion=Recepci%C3%B3n', wait_until='networkidle')
            expect(page.get_by_test_id('vehicle-dossier')).to_have_count(0)
            expect(page.get_by_role('heading', name='Inspección de ingreso')).to_be_visible()
            expect(page.get_by_test_id('workshop-case')).to_have_count(1)
            order_sections = page.get_by_role('region', name='Fases del trabajo')
            expect(order_sections.get_by_role('button')).to_have_count(5)
            for label in ['Resumen', 'Ingreso y diagnóstico', 'Costos reales', 'Entrega', 'Fotos y documentos']:
                expect(order_sections.get_by_role('button', name=label)).to_be_visible()
            expect(order_sections.get_by_role('button', name='Cobros')).to_have_count(0)
            STATE['fail'] = True
            page.goto(APP + '/taller/ingreso/?id=OT-99002', wait_until='networkidle')
            expect(page.get_by_test_id('vehicle-dossier')).to_have_count(0)
            expect(page.get_by_role('button', name='Reintentar consulta')).to_be_visible()
            STATE['fail'] = False
            assert not BLOCKED, BLOCKED
            assert not ERRORS, ERRORS
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'widths': [1440, 1024, 390, 320], 'realApiRequests': 0,
              'businessWrites': 0, 'charts': 'Real Apache ECharts SVG, not canvas',
              'fiveSections': True, 'scopedRentalAndWorkshopModals': True, 'staleReadAndCloseGuard': True,
              'focusReturnAndEscape': True, 'permissionRevocation': True, 'serverFinancialFlag': True,
              'legacyLinksAndOrderScope': True, 'draftSurvivesRefresh': True,
              'blockedRequests': BLOCKED, 'browserErrors': ERRORS}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
