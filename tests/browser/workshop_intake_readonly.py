"""Synthetic intake verification. All Auth/business HTTP is fulfilled or aborted locally."""
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

APP = 'http://127.0.0.1:3030'
ROOT = Path('test-results/workshop-intake')
USER = '00000000-0000-4000-8000-000000009901'
CUSTOMERS = [{'id': 'customer-a', 'name': 'Synthetic customer', 'phone': '70001111',
              'document': '00000001-0', 'email': '', 'type': 'Personal', 'version': 1}]
VEHICLES = [
    {'id': 'client-car', 'plate': 'CLIENT-ONLY', 'inRentalFleet': False, 'ownership': 'Cliente'},
    {'id': 'fleet-owned-client', 'plate': 'FLEET-CLIENT', 'inRentalFleet': True, 'ownership': 'Cliente'},
    {'id': 'own-nonfleet', 'plate': 'OWN-NONFLEET', 'inRentalFleet': False, 'ownership': 'Propio'},
    {'id': 'legacy-car', 'plate': 'LEGACY-CAR', 'inRentalFleet': False},
    {'id': 'open-car', 'plate': 'OPEN-WORK', 'inRentalFleet': False, 'ownership': 'Cliente'},
]
for car in VEHICLES:
    car.update(brand='Toyota', model='Corolla', year=2026, color='', category='Sedán',
               daily=0, km=0, status='Disponible', version=3, in_rental_fleet=car['inRentalFleet'])
ORDERS = [{'id': 'OT-99001', 'vehicleId': 'open-car', 'vehicle_id': 'open-car',
           'customerId': 'customer-a', 'customer_id': 'customer-a', 'status': 'Diagnóstico',
           'service': 'Synthetic existing diagnosis', 'area': 'Mecánica', 'version': 1,
           'internalJob': False, 'internal_job': False, 'pendingFields': [], 'pending_fields': []}]
DENIED, BLOCKED, ERRORS, COMMANDS, HELD = set(), [], [], [], []
STATE = {'fail': None, 'hold': False}
TABLES = {'customers', 'customer_aliases', 'vehicles', 'work_orders', 'expenses',
          'workshop_tasks', 'reservations', 'vehicle_files'}


def protect(route):
    request, url = route.request, urlparse(route.request.url)
    if url.hostname == '127.0.0.1' and url.port == 3030:
        if request.method in ['GET', 'HEAD']:
            route.continue_()
        else:
            BLOCKED.append(url.path)
            route.abort()
        return
    if request.method == 'OPTIONS':
        route.fulfill(status=204, headers={'access-control-allow-origin': '*',
                      'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
        return
    resource = url.path.split('/')[-1]
    if url.path == '/auth/v1/user' and request.method == 'GET':
        route.fulfill(json={'id': USER, 'email': 'fixture@example.invalid'})
    elif '/rest/v1/rpc/' in url.path:
        body = request.post_data_json
        if resource in ['has_permission', 'has_task_access']:
            route.fulfill(json=body.get('permission', 'tasks.read') not in DENIED)
        elif resource in ['execute_command', 'receive_workshop_vehicle']:
            name = body.get('command', resource)
            assert name in ['create_customer', 'create_vehicle', 'receive_vehicle', 'receive_workshop_vehicle']
            COMMANDS.append(copy.deepcopy(body))
            if STATE['hold']:
                HELD.append(route)
            elif STATE['fail']:
                route.fulfill(status=409, json={'message': STATE['fail'], 'code': 'P0001'})
            elif name == 'create_customer':
                CUSTOMERS.append({'id': 'new-customer', 'version': 1, **body['payload']})
                route.fulfill(json={'id': 'new-customer', 'command': name, 'createdAt': '2026-11-14'})
            else:
                route.fulfill(json={'id': 'OT-99002', 'command': name, 'createdAt': '2026-11-14'})
        elif resource == 'vehicle_case_file':
            route.fulfill(json={'vehicle': VEHICLES[0], 'orders': [], 'reservations': [], 'files': [],
                               'commitments': [], 'inspections': [], 'financialAccess': False})
        else:
            BLOCKED.append(resource)
            route.abort()
    elif '/rest/v1/' in url.path and request.method == 'GET' and resource in TABLES:
        route.fulfill(json={'customers': CUSTOMERS, 'vehicles': VEHICLES, 'work_orders': ORDERS}.get(resource, []))
    else:
        BLOCKED.append(url.path)
        route.abort()


def intake(page):
    page.get_by_role('button', name='Nueva entrada', exact=True).click()
    dialog = page.get_by_test_id('workshop-intake')
    expect(dialog).to_be_visible()
    return dialog


def next_step(dialog):
    dialog.get_by_role('button', name='Continuar', exact=True).click()


def customer_car(dialog, customer='customer-a', car='client-car'):
    dialog.get_by_label('Cliente del trabajo', exact=True).select_option(customer)
    next_step(dialog)
    dialog.get_by_label('Vehículo registrado del taller', exact=True).select_option(car)
    next_step(dialog)


def fit(page):
    page.evaluate('window.scrollTo(0, 0)')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'


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
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: ERRORS.append(str(error)))
        try:
            page.goto(APP + '/taller/', wait_until='networkidle')
            expect(page.get_by_role('heading', name='Taller', exact=True)).to_be_visible()
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                fit(page)
                page.screenshot(path=str(ROOT / f'list-{width}.png'), full_page=True)
                dialog = intake(page)
                expect(dialog.get_by_role('button', name='Continuar', exact=True)).to_be_disabled()
                dialog.get_by_label('Cliente del trabajo', exact=True).select_option('customer-a')
                next_step(dialog)
                options = dialog.get_by_label('Vehículo registrado del taller', exact=True).locator('option')
                expect(options).to_have_text(['Seleccionar vehículo', 'CLIENT-ONLY · Toyota Corolla', 'LEGACY-CAR · Toyota Corolla'])
                dialog.get_by_label('Vehículo registrado del taller', exact=True).select_option('legacy-car')
                expect(dialog).to_contain_text('Por confirmar')
                next_step(dialog)
                dialog.get_by_label('Motivo del ingreso', exact=True).fill('Preserve diagnosis draft')
                dialog.get_by_role('button', name='Atrás', exact=True).click()
                dialog.get_by_role('button', name='Atrás', exact=True).click()
                dialog.get_by_role('button', name='Registrar nuevo cliente', exact=True).click()
                registration = page.get_by_role('dialog', name='Nuevo cliente', exact=True)
                registration.get_by_label('Nombre o razón social').fill('Synthetic new customer')
                registration.get_by_label('Teléfono (opcional)').fill('70001111')
                expect(registration.get_by_role('button', name='Guardar registro')).to_be_disabled()
                expect(registration).to_contain_text('Ya hay coincidencias')
                registration.get_by_label('Teléfono (opcional)').fill('')
                # Width loop registers only once; subsequent iterations prove cancel preserves the same draft.
                if width == 1440:
                    registration.get_by_role('button', name='Guardar registro').click()
                    expect(registration).to_have_count(0)
                    expect(dialog.get_by_label('Cliente del trabajo')).to_have_value('new-customer')
                else:
                    registration.get_by_role('button', name='Cancelar', exact=True).click()
                next_step(dialog)
                next_step(dialog)
                expect(dialog.get_by_label('Motivo del ingreso')).to_have_value('Preserve diagnosis draft')
                page.evaluate("window.dispatchEvent(new Event('focus'))")
                page.wait_for_load_state('networkidle')
                expect(dialog.get_by_label('Motivo del ingreso')).to_have_value('Preserve diagnosis draft')
                fit(page)
                dialog.screenshot(path=str(ROOT / f'intake-{width}.png'))
                page.keyboard.press('Escape')
                expect(dialog).to_have_count(0)
            page.set_viewport_size({'width': 1440, 'height': 1000})
            # Existing-version conflict: refresh/reselect is explicit and preserves remaining draft.
            dialog = intake(page)
            customer_car(dialog)
            dialog.get_by_label('Motivo del ingreso').fill('Version protected')
            STATE['fail'] = 'VERSION_CONFLICT'
            dialog.get_by_role('button', name='Crear folio OT', exact=True).click()
            expect(dialog.locator('[role=alert]')).to_contain_text('registro cambió')
            assert COMMANDS[-1]['payload']['expectedVersion'] == 3
            VEHICLES[0]['version'] = 4
            STATE['fail'] = None
            dialog.get_by_role('button', name='Actualizar vehículo y revisar').click()
            expect(dialog.get_by_label('Vehículo registrado del taller')).to_be_visible()
            dialog.get_by_label('Vehículo registrado del taller').select_option('client-car')
            next_step(dialog)
            expect(dialog.get_by_label('Motivo del ingreso')).to_have_value('Version protected')
            # Ambiguous response and double click must only replay original request/key.
            STATE['hold'] = True
            before = len(COMMANDS)
            dialog.get_by_role('button', name='Crear folio OT', exact=True).dblclick()
            expect(dialog.get_by_role('button', name='Guardando…')).to_be_disabled()
            assert len(COMMANDS) == before + 1
            assert HELD
            for route in HELD:
                route.fulfill(status=503, json={'message': 'SYNTHETIC_LOST_RESPONSE'})
            HELD.clear()
            STATE['hold'] = False
            expect(dialog.locator('[role=alert]')).to_be_visible()
            original = copy.deepcopy(COMMANDS[-1])
            dialog.get_by_role('button', name='Reintentar misma entrada').click()
            expect(dialog.get_by_role('link', name='Abrir folio OT')).to_be_visible()
            assert COMMANDS[-1] == original
            assert original['payload']['expectedVersion'] == 4
            expect(dialog.get_by_role('link', name='Abrir folio OT')).to_have_attribute('href', '/taller/ingreso/?id=OT-99002')
            # Existing folio route is the navigation contract, owned by the parallel writer.
            dialog.get_by_role('link', name='Abrir folio OT').click()
            expect(page).to_have_url(re.compile(r'/taller/ingreso/\?id=OT-99002'))
            page.goto(APP + '/taller/', wait_until='networkidle')
            dialog = intake(page)
            dialog.get_by_role('button', name='Mantenimiento interno', exact=False).click()
            expect(dialog.get_by_label('Cliente del trabajo')).to_have_count(0)
            next_step(dialog)
            expect(dialog.get_by_label('Vehículo de flota disponible').locator('option')).to_have_text([
                'Seleccionar vehículo', 'FLEET-CLIENT · Toyota Corolla'])
            dialog.get_by_label('Vehículo de flota disponible').select_option('fleet-owned-client')
            expect(dialog).to_contain_text('Cliente')
            next_step(dialog)
            dialog.get_by_label('Motivo del ingreso').fill('Internal maintenance')
            dialog.get_by_role('button', name='Crear folio OT', exact=True).click()
            expect(dialog.get_by_role('link', name='Abrir folio OT')).to_be_visible()
            assert COMMANDS[-1]['command'] == 'receive_vehicle'
            assert COMMANDS[-1]['payload']['customerId'] is None
            assert COMMANDS[-1]['payload']['internalJob'] is True
            page.keyboard.press('Escape')
            # New customer vehicle is submitted only through the atomic quick-intake command.
            dialog = intake(page)
            dialog.get_by_label('Cliente del trabajo').select_option('customer-a')
            next_step(dialog)
            dialog.get_by_label('Vehículo del cliente', exact=True).select_option('new')
            for name, value in [('brand', 'Toyota'), ('model', 'Yaris'), ('year', '2026'), ('plate', 'NEW-CLIENT')]:
                dialog.locator(f'input[name={name}]').fill(value)
            next_step(dialog)
            dialog.get_by_label('Motivo del ingreso').fill('Atomic vehicle and order')
            dialog.get_by_role('button', name='Crear folio OT', exact=True).click()
            expect(dialog.get_by_role('link', name='Abrir folio OT')).to_be_visible()
            assert COMMANDS[-1]['payload']['vehicleId'] is None
            assert COMMANDS[-1]['payload']['newVehicle']['plate'] == 'NEW-CLIENT'
            assert COMMANDS[-1]['payload']['internalJob'] is False
            page.keyboard.press('Escape')
            # Shared non-workshop vehicle registration retains the original canonical payload.
            page.get_by_role('button', name='Registrar vehículo de cliente', exact=True).click()
            registration = page.get_by_role('dialog', name='Registrar vehículo', exact=True)
            expect(registration.get_by_label('Tarifa diaria de renta (opcional)')).to_be_visible()
            expect(registration.get_by_label('Incluir explícitamente en la flota de alquiler')).not_to_be_checked()
            registration.get_by_label('Marca', exact=True).fill('Toyota')
            registration.get_by_label('Modelo', exact=True).fill('Corolla')
            registration.get_by_label('Año', exact=True).fill('2026')
            registration.get_by_label('Propietario', exact=True).select_option('customer-a')
            registration.get_by_role('button', name='Guardar registro', exact=True).click()
            expect(registration).to_have_count(0)
            assert COMMANDS[-1]['command'] == 'create_vehicle'
            assert COMMANDS[-1]['payload']['ownership'] == 'Cliente'
            assert COMMANDS[-1]['payload']['inRentalFleet'] is False
            assert COMMANDS[-1]['payload']['ownerCustomerId'] == 'customer-a'
            # Current role restrictions refresh without discarding typed values.
            dialog = intake(page)
            DENIED.update(['customers.write', 'vehicles.write'])
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(dialog.get_by_role('button', name='Registrar nuevo cliente')).to_be_disabled()
            dialog.get_by_label('Cliente del trabajo').select_option('customer-a')
            next_step(dialog)
            expect(dialog.get_by_label('Vehículo del cliente', exact=True).locator('option[value=new]')).to_have_attribute('disabled', '')
            DENIED.add('orders.write')
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(dialog.get_by_role('button', name='Continuar', exact=True)).to_be_disabled()
            page.keyboard.press('Escape')
            expect(page.get_by_role('button', name='Nueva entrada', exact=True)).to_be_disabled()
            assert not BLOCKED, BLOCKED
            assert not ERRORS, ERRORS
        except Exception:
            page.evaluate('window.scrollTo(0, 0)')
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'widths': [1440, 1024, 390, 320], 'realApiRequests': 0,
              'syntheticCommands': len(COMMANDS), 'draftPreserved': True, 'duplicateCustomerHints': True,
              'legacyVehicles': True, 'fleetOwnershipIndependent': True, 'versionConflict': True,
              'retryIdentity': True, 'doubleClickLock': True, 'permissionRevocation': True,
              'existingFolioRoute': True, 'blockedRequests': BLOCKED, 'browserErrors': ERRORS}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
