"""Synthetic-only creation/list verification; unknown business endpoints are aborted."""
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

APP = 'http://127.0.0.1:3030'
ROOT = Path('test-results/rental-create')
USER = '00000000-0000-4000-8000-000000009902'
ID = '00000000-0000-4000-8000-000000009903'
customer = {'id': 'fixture-customer', 'name': 'Synthetic creation customer', 'phone': '',
            'document': '', 'email': '', 'type': 'Personal', 'version': 1}
vehicle = {'id': 'fixture-vehicle', 'plate': 'FIXTURE-ONLY', 'brand': 'Synthetic', 'model': 'Car',
           'daily': 50, 'inRentalFleet': True, 'in_rental_fleet': True, 'status': 'Disponible',
           'category': 'Sedán', 'ownership': 'Propio', 'version': 1, 'km': 100}
booking = {'id': ID, 'version': 7, 'folio_number': 99003, 'status': 'Borrador',
           'rental_state': 'Preparado', 'customer_id': customer['id'], 'vehicle_id': vehicle['id'],
           'customer_snapshot': customer, 'vehicle_snapshot': vehicle,
           'starts_at': '2030-01-01T14:00:00Z', 'ends_at': '2030-01-03T14:00:00Z',
           'daily_rate': 50, 'total': 100, 'cleaning_minutes': 60}
commands, blocked, errors = [], [], []
mode = {'createFail': True, 'confirmFail': True, 'denied': set()}
customers = [customer]


def protect(route):
    request = route.request
    url = urlparse(request.url)
    if url.hostname == '127.0.0.1' and url.port == 3030:
        if request.method in ['GET', 'HEAD'] and not url.path.startswith('/api/'):
            route.continue_()
        else:
            blocked.append(url.path)
            route.abort()
        return
    if request.method == 'OPTIONS':
        route.fulfill(status=204, headers={'access-control-allow-origin': '*',
                      'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
        return
    resource = url.path.split('/')[-1]
    if '/auth/v1/' in url.path:
        route.fulfill(json={'user': {'id': USER, 'email': 'fixture@example.invalid'}})
    elif '/rest/v1/rpc/' in url.path:
        if resource in ['has_permission', 'has_task_access']:
            permission = request.post_data_json.get('permission') if resource == 'has_permission' else 'tasks.read'
            route.fulfill(json=permission not in mode['denied'])
        elif resource == 'reservation_payment_summary':
            route.fulfill(json={})
        elif resource == 'execute_reservation_command':
            body = request.post_data_json
            assert body['command'] in ['create', 'confirm'], 'No billing, payment or inspection allowed'
            commands.append(copy.deepcopy(body))
            if body['command'] == 'create':
                assert body['payload']['startsAt'] == '2030-01-01T14:00:00.000Z'
                if mode['createFail']:
                    route.fulfill(status=503, json={'code': 'SYNTHETIC', 'message': 'SYNTHETIC'})
                    return
            else:
                assert body['payload'] == {'reservationId': ID, 'expectedVersion': 7}
                if mode['confirmFail']:
                    route.fulfill(status=409, json={'code': 'P0001', 'message': 'VERSION_CONFLICT'})
                    return
                booking.update(status='Confirmada', version=8)
            route.fulfill(json=booking)
        elif resource == 'rental_case_file':
            route.fulfill(json={'vehicle': vehicle, 'reservations': [booking], 'orders': [],
                               'commitments': [], 'inspections': [], 'files': [], 'financialAccess': False,
                               'documents': [], 'applications': [], 'payments': [], 'advances': [], 'expenses': []})
        elif resource == 'rental_paid_through':
            route.fulfill(json=None)
        elif resource == 'execute_command':
            body = request.post_data_json
            assert body['command'] == 'create_customer'
            assert set(body['payload']) == {'name', 'phone', 'document', 'email', 'type'}
            new_customer = {**customer, **body['payload'], 'id': 'fixture-new-customer'}
            customers.append(new_customer)
            route.fulfill(json={'id': new_customer['id'], 'command': 'create_customer'})
        else:
            blocked.append(resource)
            route.abort()
    elif '/rest/v1/' in url.path and request.method == 'GET':
        records = {'customers': customers, 'vehicles': [vehicle], 'reservations': [booking],
                   'rental_inspections': [], 'vehicle_commitments': [], 'reservation_evidence': [],
                   'customer_aliases': [], 'work_orders': [], 'expenses': [], 'workshop_tasks': [],
                   'vehicle_files': []}
        if resource not in records:
            blocked.append(resource)
            route.abort()
        else:
            route.fulfill(json=records[resource])
    else:
        blocked.append(url.path)
        route.abort()


def fits(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'


def fill(page):
    page.get_by_label('Cliente del alquiler', exact=True).select_option(customer['id'])
    page.get_by_label('Vehículo del alquiler', exact=True).select_option(vehicle['id'])
    page.get_by_label('Entrega prevista', exact=True).fill('2030-01-01T08:00')
    page.get_by_label('Devolución prevista', exact=True).fill('2030-01-03T08:00')


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    public_url = next(line.split('=', 1)[1].strip().strip('"')
                      for line in Path('.env.local').read_text(encoding='utf8').splitlines()
                      if line.startswith('NEXT_PUBLIC_SUPABASE_URL='))
    storage_key = 'sb-' + urlparse(public_url).hostname.split('.')[0] + '-auth-token'
    session = {'access_token': 'synthetic-only', 'refresh_token': 'synthetic-only',
               'expires_at': 4102444800, 'expires_in': 3600, 'token_type': 'bearer',
               'user': {'id': USER, 'email': 'fixture@example.invalid', 'aud': 'authenticated',
                        'role': 'authenticated', 'app_metadata': {}, 'user_metadata': {}}}
    expect.set_options(timeout=30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, timezone_id='Asia/Tokyo')
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: errors.append(str(error)))
        # Full navigation between synthetic viewport cases deliberately discards local form input.
        page.on('dialog', lambda dialog: dialog.accept())
        try:
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                page.goto(APP + '/alquileres/', wait_until='networkidle')
                expect(page.get_by_role('region', name='Folios de alquiler')).to_contain_text('ALQ-99003')
                expect(page.get_by_role('main')).to_contain_text('Reserva sin confirmar')
                expect(page.get_by_role('link', name='Nuevo alquiler', exact=True)).to_have_attribute('href', '/alquileres/nuevo/')
                fits(page)
                page.screenshot(path=str(ROOT / f'list-{width}.png'), full_page=True)
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                page.goto(APP + '/alquileres/nuevo/', wait_until='networkidle')
                if page.get_by_role('heading', name='Historia pendiente', exact=True).count():
                    page.screenshot(path=str(ROOT / 'route-gate-blocker.png'), full_page=True)
                    raise AssertionError('Parent integration required: /alquileres/nuevo orders.read gate entry')
                expect(page.get_by_role('heading', name='Nuevo alquiler', exact=True)).to_be_visible()
                expect(page.get_by_role('navigation', name='Etapas de creación')).to_be_visible()
                fill(page)
                fits(page)
                page.screenshot(path=str(ROOT / f'create-{width}.png'), full_page=True)
            page.get_by_role('button', name='Nuevo cliente', exact=True).click()
            dialog = page.get_by_role('dialog')
            expect(dialog.get_by_label('Nombre o razón social')).to_be_visible()
            dialog.get_by_label('Nombre o razón social').fill('Synthetic new customer')
            dialog.get_by_role('button', name='Guardar registro', exact=True).click()
            expect(dialog).not_to_be_visible()
            expect(page.get_by_label('Cliente del alquiler')).to_contain_text('Synthetic new customer')
            expect(page.get_by_label('Entrega prevista')).to_have_value('2030-01-01T08:00')
            page.get_by_role('button', name='Revisar acuerdo', exact=True).click()
            expect(page.locator('h2:focus')).to_have_text('Revisar acuerdo')
            page.screenshot(path=str(ROOT / 'agreement-review-320.png'), full_page=True)
            assert not commands
            page.get_by_role('button', name='Paso 1: Datos del alquiler').click()
            expect(page.get_by_label('Entrega prevista')).to_have_value('2030-01-01T08:00')
            page.get_by_role('button', name='Revisar acuerdo', exact=True).click()
            page.get_by_role('button', name='Guardar borrador', exact=True).click()
            expect(page.locator('main p[role="alert"]')).to_contain_text('No se guardó la operación')
            mode['createFail'] = False
            page.get_by_role('button', name='Reintentar el mismo borrador', exact=True).evaluate('(b)=>{b.click();b.click()}')
            expect(page.get_by_role('main')).to_contain_text('Borrador guardado')
            assert commands[0] == commands[1] and len(commands) == 2
            page.get_by_role('button', name='Confirmar reserva y abrir folio', exact=True).click()
            expect(page.locator('main p[role="alert"]')).to_contain_text('La reserva cambió')
            assert commands[-1]['payload']['expectedVersion'] == 7
            page.screenshot(path=str(ROOT / 'confirmation-conflict-320.png'), full_page=True)
            # Refresh must preserve the saved ID and must not create or silently confirm anything.
            before = len(commands)
            page.reload(wait_until='networkidle')
            expect(page.get_by_role('link', name='Abrir folio guardado', exact=True)).to_have_attribute('href', '/alquileres/folio/?id=' + ID)
            assert len(commands) == before
            page.screenshot(path=str(ROOT / 'saved-draft-refresh.png'), full_page=True)
            # Re-enter with a deliberate new agreement and prove confirm retry identity.
            page.get_by_role('button', name='Iniciar otro alquiler', exact=True).click()
            fill(page)
            page.get_by_role('button', name='Revisar acuerdo', exact=True).click()
            page.get_by_role('button', name='Guardar borrador', exact=True).click()
            expect(page.get_by_role('main')).to_contain_text('Borrador guardado')
            page.get_by_role('button', name='Confirmar reserva y abrir folio', exact=True).click()
            expect(page.locator('main p[role="alert"]')).to_contain_text('La reserva cambió')
            previous = copy.deepcopy(commands[-1])
            mode['confirmFail'] = False
            page.get_by_role('button', name='Confirmar reserva y abrir folio', exact=True).evaluate('(b)=>{b.click();b.click()}')
            page.wait_for_url('**/alquileres/folio/**')
            assert commands[-1] == previous
            assert not errors, errors
            assert not blocked, blocked
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'widths': [1440, 1024, 390, 320], 'realApiRequests': 0,
              'syntheticCommands': len(commands), 'errors': errors, 'blocked': blocked}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
