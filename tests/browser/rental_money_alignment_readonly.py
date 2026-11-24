"""Verify that the operator-facing money surfaces of a rental agree with the canonical model.

Synthetic HTTP only: every API call is fulfilled locally, nothing reaches a business API,
the database or a real authentication service. The fixture is a rental with an agreed amount
of 80 and no issued document, so the pending amount must be 80 everywhere.
"""
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

APP = 'http://127.0.0.1:3030'
ROOT = Path('test-results/rental-money-alignment')
FIXTURE_ID = '00000000-0000-4000-8000-000000009901'
VEHICLE_ID = '00000000-0000-4000-8000-000000009902'
USER_ID = '00000000-0000-4000-8000-000000009903'
AGREED = 80
CLOSED_ID = '00000000-0000-4000-8000-000000009911'
CLOSED_VEHICLE_ID = '00000000-0000-4000-8000-000000009912'
CLOSED_CUSTOMER_ID = '00000000-0000-4000-8000-000000009913'

customer = {'id': 'synthetic-customer', 'name': 'Synthetic money customer', 'phone': '', 'email': '',
            'document': '', 'type': 'Personal', 'version': 1, 'aliases': []}
vehicle = {'id': VEHICLE_ID, 'plate': 'SYNTH-001', 'brand': 'Synthetic', 'model': 'Car', 'km': 100,
           'version': 1, 'status': 'Alquilado', 'in_rental_fleet': True, 'inRentalFleet': True,
           'daily': 40, 'ownership': 'Propio', 'category': 'Sedán', 'year': 2026, 'color': 'White',
           'registered_holder': '', 'commercial_line': ''}
booking = {'id': FIXTURE_ID, 'version': 4, 'folio_number': 99001, 'status': 'Confirmada',
           'rental_state': 'Entregado', 'customer_id': customer['id'], 'vehicle_id': VEHICLE_ID,
           'customer_snapshot': customer, 'vehicle_snapshot': vehicle,
           'starts_at': '2026-11-14T12:00:00Z', 'ends_at': '2026-11-16T12:00:00Z',
           'daily_rate': 40, 'total': AGREED, 'cleaning_minutes': 30, 'open_ended': False,
           'created_at': '2026-11-01T12:00:00Z', 'actual_departure_at': '2026-11-14T12:00:00Z',
           'actual_return_at': None}
# A rental that is already closed and still owes money: the card has to say both facts.
closed_customer = {'id': CLOSED_CUSTOMER_ID, 'name': 'Synthetic closed customer', 'phone': '', 'email': '',
                   'document': '', 'type': 'Personal', 'version': 1, 'aliases': []}
closed_vehicle = {**vehicle, 'id': CLOSED_VEHICLE_ID, 'plate': 'SYNTH-002', 'status': 'Disponible',
                  'customer_snapshot': closed_customer}
closed_booking = {**booking, 'id': CLOSED_ID, 'version': 6, 'folio_number': 99011,
                  'rental_state': 'Cerrado', 'customer_id': closed_customer['id'],
                  'vehicle_id': CLOSED_VEHICLE_ID, 'customer_snapshot': closed_customer,
                  'vehicle_snapshot': closed_vehicle,
                  'actual_return_at': '2026-11-16T12:00:00Z'}
blocked, errors = [], []


blocked, errors = [], []
STATE = {'issued': False, 'open_ended': False}


def case_file(reservation=None):
    """A rental scope with an agreed amount and no issued document at all."""
    booking_row = reservation if reservation else booking
    if STATE['open_ended']:
        # An open ended rental has no agreed total: there is nothing to compare.
        booking_row = {**booking_row, 'open_ended': True, 'ends_at': 'infinity', 'total': 0}
    documents = []
    if STATE['issued'] and booking_row['total'] > 0:
        # The whole agreed amount was already issued: there is no difference to warn about.
        documents = [{'id': 'issued-doc', 'description': 'Synthetic issued rental charge',
                      'amount': booking_row['total'], 'balance': booking_row['total'],
                      'scope_amount': booking_row['total'], 'scope_balance': booking_row['total'],
                      'folio_number': 99021, 'issued_on': '2026-11-14', 'due_on': '2026-11-30',
                      'grouped': False, 'customer_id': booking_row['customer_id']}]
    return {'vehicle': booking_row['vehicle_snapshot'], 'financialAccess': True, 'orders': [],
            'reservations': [booking_row], 'commitments': [], 'inspections': [], 'files': [],
            'documents': documents, 'applications': [], 'expenses': [], 'payments': [], 'advances': [],
            'quotes': [], 'costs': []}


def protect(route):
    request, url = route.request, urlparse(route.request.url)
    resource = url.path.split('/')[-1]
    if url.hostname == '127.0.0.1' and url.port == 3030:
        if request.method in ['GET', 'HEAD']:
            route.continue_()
        else:
            blocked.append(url.path)
            route.abort()
        return
    # No route.fetch and no continue for any API or Auth request.
    if request.method == 'OPTIONS':
        route.fulfill(status=204, headers={'access-control-allow-origin': '*',
                      'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
        return
    if '/auth/v1/' in url.path:
        route.fulfill(json={'user': {'id': USER_ID, 'email': 'fixture@example.invalid'}})
    elif '/rest/v1/rpc/' in url.path:
        if resource in ['has_permission', 'has_task_access']:
            route.fulfill(json=True)
        elif resource == 'rental_case_file':
            assert request.post_data_json['reservation_id'] in (FIXTURE_ID, CLOSED_ID)
            route.fulfill(json=case_file(closed_booking if request.post_data_json['reservation_id'] == CLOSED_ID else booking))
        elif resource == 'vehicle_case_file':
            assert request.post_data_json['vehicle_id'] == VEHICLE_ID
            route.fulfill(json=case_file())
        elif resource == 'receivables_at':
            route.fulfill(json=[])
        elif resource == 'reservation_payment_summary':
            route.fulfill(json={})
        elif resource == 'rental_paid_through':
            route.fulfill(json=None)
        else:
            blocked.append(resource)
            route.abort()
    elif '/rest/v1/' in url.path and request.method == 'GET':
        records = {'customers': [customer, closed_customer], 'customer_aliases': [], 'vehicles': [vehicle, closed_vehicle],
                   'work_orders': [], 'expenses': [], 'workshop_tasks': [], 'vehicle_files': [],
                   'vehicle_commitments': [], 'reservation_evidence': [],
                   'customer_payments': [], 'payment_applications': [], 'payment_refunds': [],
                   'rental_inspections': [], 'rental_extra_proposals': [],
                   'reservations': [{**booking, 'vehicleId': VEHICLE_ID, 'customerId': customer['id'],
                                     'start': booking['starts_at'], 'end': booking['ends_at'],
                                     'rentalState': booking['rental_state'],
                                     'folioNumber': booking['folio_number']},
                                     {**closed_booking, 'vehicleId': CLOSED_VEHICLE_ID,
                                      'customerId': closed_customer['id'],
                                      'start': closed_booking['starts_at'], 'end': closed_booking['ends_at'],
                                      'rentalState': closed_booking['rental_state'],
                                      'folioNumber': closed_booking['folio_number']}]}
        route.fulfill(json=records.get(resource, []))
    else:
        blocked.append(url.path)
        route.abort()


def assert_fits(page):
    page.evaluate('window.scrollTo(0, 0)')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'


def shoot(page, name):
    page.evaluate('window.scrollTo(0, 0)')
    page.screenshot(path=str(ROOT / f'{name}.png'), full_page=True)


def check_folio(page):
    page.goto(APP + '/alquileres/folio/?id=' + FIXTURE_ID, wait_until='networkidle')
    # The folio states the money of the rental in plain words: what is agreed and what is pending.
    expect(page.get_by_text('Pendiente por cobrar')).to_be_visible()
    expect(page.locator('body')).to_contain_text('$80.00')
    expect(page.locator('body')).not_to_contain_text('Sin cargo emitido')
    expect(page.locator('body')).not_to_contain_text('Cargos de este alquiler')
    # The folio states the state of the operation as well as the state of the money.
    expect(page.get_by_role('button', name=re.compile('Cuentas'))).to_be_visible()
    for width in [1440, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert_fits(page)
        shoot(page, f'folio-{width}')


def check_cobros(page):
    page.goto(APP + '/cobros', wait_until='networkidle')
    card = page.locator('.collection-card').filter(has_text='Synthetic money customer')
    expect(card).to_have_count(1)
    expect(card).to_contain_text('Importe acordado')
    expect(card).to_contain_text('$80.00')
    expect(card).to_contain_text('Por cobrar')
    expect(card).not_to_contain_text('Sin cargo')
    expect(card).not_to_contain_text('Según cargo del alquiler')
    expect(card).not_to_contain_text('Saldo de los cargos emitidos')
    # The badge states the same fact as the pending amount.
    expect(card).to_contain_text('Pendiente de emitir el documento')
    # The reconciliation alarm states the difference between what was agreed and what was issued.
    card_alarm = card.get_by_test_id('reconciliation-alarm')
    expect(card_alarm).to_have_count(1)
    expect(card_alarm).to_contain_text('Todavía no se emitió ningún importe')
    expect(card_alarm).to_contain_text('de $80.00 acordados')
    expect(card_alarm).to_contain_text('faltan $80.00 por emitir')
    # It is informative: it never blocks the actions of the card.
    for button in card.get_by_role('button').all():
        expect(button).to_be_enabled()
    for width in [1440, 1024, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert_fits(page)
        shoot(page, f'cobros-{width}')
    page.set_viewport_size({'width': 1440, 'height': 1000})


def check_cobros_without_agreement(page):
    """Without an agreed amount, or with everything already issued, there is no alarm."""
    # Everything that was agreed was issued: the difference is zero.
    STATE['issued'] = True
    page.goto(APP + '/cobros', wait_until='networkidle')
    card = page.locator('.collection-card').filter(has_text='Synthetic money customer')
    expect(card).to_have_count(1)
    expect(card.get_by_test_id('reconciliation-alarm')).to_have_count(0)
    assert_fits(page)
    shoot(page, 'cobros-issued-equals-agreed')
    STATE['issued'] = False
    # An open ended rental has no agreed amount: there is nothing to compare.
    STATE['open_ended'] = True
    page.goto(APP + '/cobros', wait_until='networkidle')
    card = page.locator('.collection-card').filter(has_text='Synthetic money customer')
    expect(card).to_have_count(1)
    expect(card.get_by_test_id('reconciliation-alarm')).to_have_count(0)
    expect(card).to_contain_text('Sin total acordado')
    assert_fits(page)
    shoot(page, 'cobros-open-ended')
    STATE['open_ended'] = False


def check_cuentas(page):
    """The Cuentas section of the rental states the same difference, in the same words."""
    page.goto(APP + '/alquileres/folio/?id=' + FIXTURE_ID + '&seccion=Cuentas', wait_until='networkidle')
    section = page.get_by_role('region', name='Cuentas del alquiler')
    expect(section).to_be_visible()
    section_alarm = section.get_by_test_id('reconciliation-alarm')
    expect(section_alarm).to_have_count(1)
    expect(section_alarm).to_contain_text('Todavía no se emitió ningún importe')
    expect(section_alarm).to_contain_text('faltan $80.00 por emitir')
    # The same fact is never stated twice in the section.
    expect(section.get_by_text('faltan $80.00 por emitir', exact=False)).to_have_count(1)
    for width in [1440, 1024, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert_fits(page)
        shoot(page, f'cuentas-{width}')
    page.set_viewport_size({'width': 1440, 'height': 1000})


def check_cobros_closed(page):
    """A rental that is already closed and still owes money: the card says both facts."""
    page.goto(APP + '/cobros', wait_until='networkidle')
    card = page.locator('.collection-card').filter(has_text='Synthetic closed customer')
    expect(card).to_have_count(1)
    expect(card.locator('.collection-statuses')).to_have_attribute(
        'aria-label', 'Finalizado · Pendiente de emitir el documento')
    expect(card).to_contain_text('Finalizado')
    expect(card).to_contain_text('Pendiente de emitir el documento')
    # The three key amounts lead the card.
    row = card.locator('dl.collection-money')
    expect(row.locator('dt')).to_have_text(['Importe acordado', 'Cobrado', 'Por cobrar'])
    expect(row).to_contain_text('$80.00')
    # The card warns about the difference, without blocking anything.
    expect(card.get_by_test_id('reconciliation-alarm')).to_have_count(1)
    # The secondary figures stay available inside a collapsed detail.
    detail = card.locator('details.collection-detail')
    expect(detail).to_have_count(1)
    expect(detail.locator('summary')).to_have_text(re.compile('Detalle'))
    expect(card.locator('details.collection-detail dl.operation-amounts')).not_to_be_visible()
    # The card is a compact record.
    height = card.bounding_box()['height']
    print(f'closed rental card height: {height:.0f} pixels')
    assert height < 320, f'the closed rental card is {height} pixels tall'
    for width in [1440, 1024, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert_fits(page)
        shoot(page, f'cobros-closed-{width}')
    page.set_viewport_size({'width': 1440, 'height': 1000})


def check_dossier(page):
    page.goto(APP + '/vehiculos/expediente/?id=' + VEHICLE_ID + '&seccion=Alquileres',
              wait_until='networkidle')
    expect(page.get_by_test_id('vehicle-dossier')).to_be_visible()
    page.get_by_role('table', name='Historial de alquileres').locator('tbody tr').first \
        .get_by_role('button', name='Ver detalle').click()
    dialog = page.get_by_role('dialog')
    expect(dialog.get_by_test_id('scoped-summary')).to_be_visible()
    amounts = dialog.locator('dl[aria-label="Importes del alcance consultado"]')
    expect(amounts).to_contain_text('Lo acordado')
    expect(amounts).to_contain_text('Lo pendiente')
    expect(amounts).to_contain_text('$80.00')
    expect(amounts).not_to_contain_text('Cargos emitidos')
    expect(amounts).not_to_contain_text('Abonos aplicados')
    expect(amounts).not_to_contain_text('Saldo por cobrar')
    for width in [1440, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        dialog.screenshot(path=str(ROOT / f'dossier-rental-{width}.png'))
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).to_have_count(0)
    # The historical amounts of the vehicle keep their plain labels.
    page.get_by_role('button', name='Ingresos', exact=True).click()
    expect(page.locator('dl[aria-label="Importes del alcance consultado"]')).to_contain_text('Importes emitidos al cliente')
    expect(page.locator('dl[aria-label="Importes del alcance consultado"]')).to_contain_text('Saldo pendiente')
    expect(page.locator('main')).not_to_contain_text('Cargos emitidos')
    shoot(page, 'dossier-ingresos')


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    # Read configuration only, never credentials, manifests or database records.
    public_url = next(line.split('=', 1)[1].strip().strip('"')
                      for line in Path('.env.local').read_text(encoding='utf8').splitlines()
                      if line.startswith('NEXT_PUBLIC_SUPABASE_URL='))
    storage_key = 'sb-' + urlparse(public_url).hostname.split('.')[0] + '-auth-token'
    session = {'access_token': 'synthetic-never-forwarded', 'refresh_token': 'synthetic-refresh',
               'expires_at': 4102444800, 'expires_in': 3600, 'token_type': 'bearer',
               'user': {'id': USER_ID, 'email': 'fixture@example.invalid', 'aud': 'authenticated',
                        'role': 'authenticated', 'app_metadata': {}, 'user_metadata': {}}}
    expect.set_options(timeout=200000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, timezone_id='Asia/Tokyo',
                                reduced_motion='reduce')
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            check_folio(page)
            check_cobros(page)
            check_cobros_without_agreement(page)
            check_cuentas(page)
            check_cobros_closed(page)
            check_dossier(page)
            assert not blocked, blocked
            assert not errors, errors
            print('PASS: rental folio, /cobros row and dossier amounts show the agreed and the pending amount.')
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    main()
