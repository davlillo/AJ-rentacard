"""Exercise the real folio UI with synthetic HTTP only; never contact a business API."""
import copy
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

APP = 'http://127.0.0.1:3030'
ROOT = Path('test-results/rental-folio-flow')
FIXTURE_ID = '00000000-0000-4000-8000-000000009901'
USER_ID = '00000000-0000-4000-8000-000000009902'
now = datetime.now(timezone.utc)
customer = {'id': 'fixture-customer', 'name': 'Synthetic inspection customer', 'phone': '', 'email': '',
            'document': '', 'type': 'Personal', 'version': 1, 'aliases': []}
vehicle = {'id': 'fixture-vehicle', 'plate': 'FIXTURE-ONLY', 'brand': 'Synthetic', 'model': 'Car',
           'km': 100, 'version': 1, 'status': 'Disponible', 'in_rental_fleet': True,
           'inRentalFleet': True, 'daily': 50, 'ownership': 'Propio', 'category': 'Sedán',
           'year': 2026, 'color': 'White', 'registered_holder': '', 'commercial_line': ''}
booking = {'id': FIXTURE_ID, 'version': 4, 'folio_number': 99001, 'status': 'Confirmada',
           'rental_state': 'Preparado', 'customer_id': customer['id'], 'vehicle_id': vehicle['id'],
           'customer_snapshot': customer, 'vehicle_snapshot': vehicle,
           'starts_at': (now - timedelta(hours=1)).isoformat(),
           'ends_at': (now + timedelta(days=1)).isoformat(),
           'daily_rate': 50, 'total': 50, 'cleaning_minutes': 30}
inspections, commands, blocked, errors = [], [], [], []
reservation_commands, commitments = [], []
mode = {'fail': 'connection', 'finance': False, 'extensionFail': True, 'denied': set(),
        'cleaningFail': False, 'cleaningBlocked': True}
document = {'id': 'fixture-document', 'customer_id': customer['id'], 'current_customer_id': customer['id'],
            'reservation_id': FIXTURE_ID, 'order_id': None, 'description': 'Scoped fixture charge',
            'amount': 100, 'balance': 60, 'scope_amount': 100, 'scope_balance': 60, 'folio_number': 99001,
            'issued_on': '2026-11-14', 'due_on': '2030-01-03'}
grouped = {**document, 'id': 'fixture-grouped', 'description': 'Grouped fixture charge', 'grouped': True,
           'amount': 900, 'balance': 500, 'scope_amount': 20, 'scope_balance': 20, 'folio_number': 99002}
unrelated = {**document, 'id': 'unrelated-document', 'reservation_id': 'another-rental',
             'description': 'Unrelated rental charge', 'amount': 200, 'balance': 200, 'folio_number': 99003}
payment = {'id': 'fixture-payment', 'customer_id': customer['id'], 'amount': 40, 'paid_on': '2026-11-14',
           'method': 'Efectivo', 'account': 'Synthetic cash', 'reference': 'Existing receipt', 'folio_number': 99001}
advance = {**payment, 'id': 'fixture-advance', 'amount': 10, 'available_amount': 10,
           'reference': 'Existing advance', 'folio_number': 99002}
application = {'id': 'fixture-application', 'payment_id': payment['id'], 'document_id': document['id'],
               'amount': 40, 'scope_amount': 40, 'kind': 'Aplicacion', 'effective_on': '2026-11-14',
               'reason': 'Previously applied receipt'}


def case_file():
    return {'vehicle': vehicle, 'reservations': [booking], 'financialAccess': mode['finance'],
            'orders': [], 'commitments': commitments, 'inspections': [], 'files': [],
            'documents': [document, grouped] if mode['finance'] else [],
            'applications': [application] if mode['finance'] else [], 'expenses': [],
            'payments': [payment] if mode['finance'] else [], 'advances': [advance] if mode['finance'] else []}


def protect(route):
    request = route.request
    url = urlparse(request.url)
    if url.hostname == '127.0.0.1' and url.port == 3030:
        if request.method not in ['GET', 'HEAD']:
            blocked.append(url.path)
            route.abort()
        else:
            route.continue_()
        return
    # No route.fetch or continue is permitted for ANY API request, including reads and Auth.
    if request.method == 'OPTIONS':
        route.fulfill(status=204, headers={'access-control-allow-origin': '*',
                      'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
        return
    resource = url.path.split('/')[-1]
    if '/auth/v1/' in url.path:
        route.fulfill(json={'user': {'id': USER_ID, 'email': 'fixture@example.invalid'}})
    elif '/rest/v1/rpc/' in url.path:
        if resource in ['has_permission', 'has_task_access']:
            permission = request.post_data_json.get('permission') if resource == 'has_permission' else 'tasks.read'
            route.fulfill(json=permission not in mode['denied'])
        elif resource == 'rental_case_file':
            assert request.post_data_json['reservation_id'] == FIXTURE_ID
            route.fulfill(json=case_file())
        elif resource == 'vehicle_case_file':
            assert request.post_data_json['vehicle_id'] == vehicle['id']
            route.fulfill(json=case_file())
        elif resource == 'reservation_payment_summary':
            route.fulfill(json={FIXTURE_ID: 'Con saldo'})
        elif resource == 'receivables_at':
            route.fulfill(json=[document, grouped, unrelated])
        elif resource == 'rental_paid_through':
            assert request.post_data_json['reservation_id'] == FIXTURE_ID
            route.fulfill(json=None)
        elif resource == 'execute_reservation_command':
            body = request.post_data_json
            assert body['payload']['reservationId'] == FIXTURE_ID
            assert body['command'] in ['extend', 'set_end', 'review_return_cleaning'], 'Unexpected mutation, billing or cash command'
            reservation_commands.append(copy.deepcopy(body))
            if body['command'] == 'review_return_cleaning':
                data = body['payload']
                assert data['blockId'] == 'fixture-cleaning'
                if data['expectedVersion'] != booking['version']:
                    route.fulfill(status=409, json={'code': 'P0001', 'message': 'VERSION_CONFLICT'})
                    return
                if data['expectedVehicleVersion'] != vehicle['version']:
                    route.fulfill(status=409, json={'code': 'P0001', 'message': 'VEHICLE_VERSION_CONFLICT'})
                    return
                if mode['cleaningFail']:
                    route.fulfill(status=503, json={'code': 'SYNTHETIC_UNAVAILABLE', 'message': 'SYNTHETIC_UNAVAILABLE'})
                    return
                cleaning = commitments[0]
                cleaning.update(active=False, ends_at=datetime.now(timezone.utc).isoformat(),
                                reason='Revisión de limpieza confirmada: ' + data['reason'])
                booking['version'] += 1
                if not mode['cleaningBlocked']:
                    vehicle.update(status='Disponible', readiness_hold=False, version=vehicle['version'] + 1)
                route.fulfill(json={'reservation': booking, 'vehicle': vehicle, 'cleaning': cleaning,
                                    'cleaningReviewed': True, 'releaseBlocked': mode['cleaningBlocked']})
                return
            if mode['extensionFail']:
                route.fulfill(status=409, json={'code': '23P01', 'message': 'RENTAL_CONFLICT'})
                return
            if body['payload']['expectedVersion'] != booking['version']:
                route.fulfill(status=409, json={'code': '23505', 'message': 'VERSION_CONFLICT'})
                return
            booking['ends_at'] = body['payload']['endsAt']
            elapsed = datetime.fromisoformat(booking['ends_at'].replace('Z', '+00:00')) - datetime.fromisoformat(booking['starts_at'].replace('Z', '+00:00'))
            import math
            booking['total'] = booking['daily_rate'] * max(1, math.ceil(elapsed.total_seconds() / 86400))
            booking['open_ended'] = False
            booking['version'] += 1
            route.fulfill(json=booking)
        elif resource == 'execute_rental_command':
            body = request.post_data_json
            assert body['payload']['reservationId'] == FIXTURE_ID
            assert body['command'] in ['depart', 'return']
            commands.append(copy.deepcopy(body))
            if mode['fail']:
                conflict = mode['fail'] == 'version'
                route.fulfill(status=409 if conflict else 503,
                              json={'code': '23505' if conflict else 'SYNTHETIC_UNAVAILABLE',
                                    'message': 'VERSION_CONFLICT' if conflict else 'SYNTHETIC_UNAVAILABLE'})
                return
            assert body['payload']['expectedVersion'] == booking['version']
            returning = body['command'] == 'return'
            record = {'id': 'fixture-return' if returning else 'fixture-departure',
                      'reservation_id': FIXTURE_ID, 'kind': 'Retorno' if returning else 'Salida',
                      'km': body['payload']['km'], 'fuel': body['payload']['fuel'],
                      'condition': body['payload']['condition'], 'accessories': '',
                      'evidence': body['payload']['evidence'], 'occurred_at': datetime.now(timezone.utc).isoformat(),
                      'created_by': USER_ID}
            inspections.append(record)
            booking['version'] += 1
            booking['rental_state'] = 'Devuelto' if returning else 'Entregado'
            booking['actual_return_at' if returning else 'actual_departure_at'] = record['occurred_at']
            route.fulfill(json={'reservation': booking, 'return' if returning else 'inspection': record,
                                'cleaningConflict': returning})
        else:
            blocked.append(resource)
            route.abort()
    elif '/rest/v1/' in url.path and request.method == 'GET':
        records = {'rental_inspections': inspections, 'customers': [customer], 'vehicles': [vehicle],
                   'reservations': [{**{key: value for key, value in booking.items()
                                        if key not in ['actual_departure_at', 'actual_return_at']},
                                     'vehicleId': vehicle['id'], 'customerId': customer['id'],
                                     'start': booking['starts_at'], 'end': booking['ends_at'],
                                     'rentalState': booking['rental_state'], 'folioNumber': booking['folio_number']}],
                   'vehicle_commitments': commitments, 'customer_payments': [payment, advance],
                   'payment_applications': [application]}
        route.fulfill(json=records.get(resource, []))
    else:
        blocked.append(url.path)
        route.abort()


def fill_review(page, km, fuel, review):
    page.get_by_label('Kilometraje (km)', exact=True).fill(km)
    page.get_by_label('Combustible (%)', exact=True).fill(fuel)
    page.get_by_label('Revisión general del vehículo (360°)', exact=True).fill(review)


def refresh(page):
    with page.expect_response(lambda response: '/rpc/rental_case_file' in response.url):
        page.get_by_role('button', name='Actualizar alquiler', exact=True).click()
    page.wait_for_load_state('networkidle')


def stage(page, label):
    # The circles are the only navigation of the folio.
    return page.get_by_role('region', name='Fases del folio').get_by_role('button', name=re.compile('^' + label + ':'))


def assert_fits(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'
    for label in ['Kilometraje (km)', 'Combustible (%)']:
        field = page.get_by_label(label, exact=True)
        if field.count():
            minimum = 44 if page.viewport_size['width'] <= 600 else 36
            assert field.bounding_box()['height'] >= minimum


def workspace_checks(page):
    mode['finance'] = True
    mode['fail'] = False
    booking.update(rental_state='Entregado', version=10)
    for width in [1440, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        page.goto(APP + '/alquileres/', wait_until='networkidle')
        expect(page.locator('.page-heading-module h1')).to_have_text('Alquileres')
        nav = page.get_by_role('navigation', name='Navegación principal')
        expect(nav.get_by_role('link')).to_have_count(9)
        expect(nav.get_by_role('link', name='Calendario', exact=True)).to_be_visible()
        expect(nav.get_by_role('link', name='Alquileres', exact=True)).to_have_attribute('aria-current', 'page')
        expect(page.get_by_role('button', name='Folios', exact=True)).to_have_attribute('aria-pressed', 'true')
        expect(page.get_by_role('link', name='Abrir folio', exact=True)).to_have_attribute('href', '/alquileres/folio/?id=' + FIXTURE_ID)
        page.get_by_role('button', name='Calendario', exact=True).click()
        expect(page.get_by_role('region', name='Calendario mensual de vehículos')).to_be_visible()
        page.get_by_role('button', name='Ver alquiler →', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('link', name='Abrir folio', exact=True)).to_be_visible()
        expect(dialog.locator('form')).to_have_count(0)
        assert_fits(page)
        dialog.screenshot(path=str(ROOT / f'calendar-preview-{width}.png'))
        dialog.get_by_role('button', name='Cerrar', exact=True).click()

        page.goto(APP + '/vehiculos/expediente/?id=' + vehicle['id'] + '&seccion=Alquileres', wait_until='networkidle')
        # The permanent dossier shows one row per rental and opens the detail in a read-only modal.
        records = page.locator('main')
        rows = records.get_by_role('button', name='Ver detalle')
        expect(rows.first).to_be_visible()
        rows.first.click()
        detail = page.get_by_role('dialog')
        expect(detail.get_by_role('link', name='Abrir folio')).to_be_visible()
        expect(detail.locator('form')).to_have_count(0)
        page.keyboard.press('Escape')
        expect(page.get_by_role('navigation', name='Navegación principal').get_by_role('link', name='Vehículos', exact=True)).to_have_attribute('aria-current', 'page')
        assert_fits(page)
        page.goto(APP + '/alquileres/folio/?id=' + FIXTURE_ID, wait_until='networkidle')
        # The money of the folio lives in the Cuentas stage with separated amounts.
        stage(page, 'Cuentas').click()
        expect(page.locator('main')).to_contain_text('Lo acordado')
        expect(page.locator('main')).to_contain_text('Lo cobrado')
        expect(page.locator('main')).to_contain_text('Lo pendiente')
        expect(page.locator('main')).to_contain_text('Importes emitidos al cliente')
        expect(page.locator('main')).to_contain_text('Cobros aplicados (netos)')
        expect(page.locator('main')).to_contain_text('Saldo pendiente del documento de cobro')
        expect(page.locator('main')).to_contain_text('Anticipos por aplicar')
        expect(page.locator('main')).to_contain_text('$120.00')
        expect(page.locator('main')).to_contain_text('$40.00')
        expect(page.locator('main')).to_contain_text('$80.00')
        expect(page.locator('main')).to_contain_text('$10.00')
        # The billing detail lives inside the Cuentas stage.
        expect(page.locator('main')).to_contain_text('Scoped fixture charge')
        expect(page.locator('main')).not_to_contain_text('Unrelated rental charge')
        expect(page.locator('main')).to_contain_text('repartir recibos y ajustes por línea')
        # The collection form is the shared global dialog, opened from Realizar cobro.
        page.get_by_role('button', name='Realizar cobro', exact=True).click()
        receipt = page.get_by_role('region', name='Cobro o anticipo vinculado', exact=True)
        expect(receipt).to_be_visible()
        expect(receipt.get_by_label('A qué documento se aplica el cobro', exact=True).locator('option')).to_have_count(3)
        expect(receipt.get_by_label('A qué documento se aplica el cobro', exact=True)).not_to_contain_text('Unrelated rental charge')
        expect(receipt.get_by_label('A qué documento se aplica el cobro', exact=True)).not_to_contain_text('Grouped fixture charge')
        expect(receipt.get_by_label('Origen del dinero', exact=True)).to_contain_text('Existing advance')
        expect(receipt.locator('[aria-label="Folio de taller o contrato del cobro (opcional)"]')).to_have_count(0)
        page.get_by_role('button', name='Cerrar', exact=True).click()
        assert_fits(page)
        page.screenshot(path=str(ROOT / f'folio-finances-{width}.png'), full_page=True)

    # Calendar stays separate; legacy rental routes retain the Alquileres context.
    for path in ['/calendario/', '/vehiculos/reservas/', '/vehiculos/alquiler/?id=' + FIXTURE_ID,
                 '/alquileres/', '/alquileres/folio/?id=' + FIXTURE_ID]:
        page.goto(APP + path, wait_until='networkidle')
        expect(page.locator('main h1')).to_be_visible()
        active_label = 'Calendario' if path == '/calendario/' else 'Alquileres'
        expect(page.get_by_role('navigation', name='Navegación principal').get_by_role('link', name=active_label, exact=True)).to_have_attribute('aria-current', 'page')

    # The preview matches the existing SQL's three-extra-hours example.
    booking.update(starts_at='2030-01-01T12:00:00Z', ends_at='2030-01-03T12:00:00Z',
                   daily_rate=50, total=100, open_ended=False)
    refresh(page)
    # The extension belongs to the Alquilado stage of the single flow.
    stage(page, 'Alquilado').click()
    page.get_by_text('Extender o acordar la fecha de devolución', exact=True).click()
    page.get_by_label('Nueva fecha final acordada', exact=True).fill('2030-01-03T09:00')
    page.get_by_label('Motivo del cambio de fecha', exact=True).fill('Synthetic three-hour extension')
    page.get_by_role('button', name='Revisar cambio de fecha e importe', exact=True).click()
    preview = page.get_by_role('region', name='Revisión de extensión')
    expect(preview.locator('dd')).to_contain_text(['3 ene', '3 ene', '$100.00', '$150.00', '$50.00'])
    expect(preview).to_contain_text('NO emite un importe a cobrar ni registra un cobro')
    assert not reservation_commands
    for width in [1440, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        minimum = 44 if width <= 600 else 36
        assert page.get_by_label('Nueva fecha final acordada', exact=True).bounding_box()['height'] >= minimum
        assert_fits(page)
        page.screenshot(path=str(ROOT / f'extension-preview-{width}.png'), full_page=True)
    page.get_by_role('button', name='Confirmar solo cambio de fecha', exact=True).click()
    expect(page.locator('main [role=alert]')).to_contain_text('coincide con otro compromiso')
    expect(page.get_by_label('Motivo del cambio de fecha', exact=True)).to_have_value('Synthetic three-hour extension')
    mode['extensionFail'] = False
    refresh(page)
    stage(page, 'Alquilado').click()
    page.get_by_role('button', name='Confirmar solo cambio de fecha', exact=True).click()
    expect(page.locator('main')).to_contain_text('Fechas guardadas. No se creó ningún importe a cobrar ni cobro.')
    assert reservation_commands[0] == reservation_commands[1]
    assert booking['total'] == 150
    expect(page.locator('.rental-money dd')).to_have_text(['$150.00', '$120.00', '$40.00', '$110.00'])

    page.get_by_label('Nueva fecha final acordada', exact=True).fill('2030-01-03T10:00')
    page.get_by_label('Motivo del cambio de fecha', exact=True).fill('Same rounded day')
    page.get_by_role('button', name='Revisar cambio de fecha e importe', exact=True).click()
    expect(preview).to_contain_text('Sin incremento previsto')
    page.get_by_role('button', name='Volver a revisar fechas', exact=True).click()
    booking.update(open_ended=True, ends_at='infinity', total=0, version=20)
    refresh(page)
    page.get_by_role('button', name='Revisar cambio de fecha e importe', exact=True).click()
    expect(preview).to_contain_text('Sin total final acordado')
    expect(preview).to_contain_text('sin diferencia comparable')
    page.get_by_role('button', name='Confirmar solo cambio de fecha', exact=True).click()
    expect(page.locator('main')).to_contain_text('Fechas guardadas. No se creó ningún importe a cobrar ni cobro.')
    assert reservation_commands[-1]['command'] == 'set_end'
    assert reservation_commands[-1]['payload']['expectedVersion'] == 20
    page.get_by_label('Nueva fecha final acordada', exact=True).fill('2030-01-03T11:00')
    page.get_by_label('Motivo del cambio de fecha', exact=True).fill('Do not reinterpret confirmed extension')
    page.get_by_role('button', name='Revisar cambio de fecha e importe', exact=True).click()
    booking.update(open_ended=True, ends_at='infinity', version=22)
    refresh(page)
    page.get_by_role('button', name='Confirmar solo cambio de fecha', exact=True).click()
    expect(page.locator('main [role=alert]')).to_contain_text('La reserva cambió')
    assert reservation_commands[-1]['command'] == 'extend'
    assert reservation_commands[-1]['payload']['expectedVersion'] == 21
    expect(page.get_by_label('Motivo del cambio de fecha', exact=True)).to_have_value('Do not reinterpret confirmed extension')

    # The return step of the folio is one action: the readings and a single primary action.
    stage(page, 'Devolución').click()
    expect(page.get_by_role('button', name='Iniciar devolución', exact=True)).to_have_count(1)
    expect(page.get_by_role('button', name='Registrar devolución', exact=True)).to_have_count(0)
    expect(page.locator('#rental-cleaning')).to_have_count(0)
    expect(page.locator('main')).not_to_contain_text('Limpieza')
    expect(page.locator('main')).not_to_contain_text('limpieza')
    assert_fits(page)
    page.screenshot(path=str(ROOT / 'return-step.png'), full_page=True)

    # The release of the vehicle is confirmed from the folio inline (checked below)
    # and from the vehicle dossier as the secondary path.
    booking.update(rental_state='Devuelto', actual_return_at='2026-01-01T12:00:00Z')
    vehicle.update(status='En taller', readiness_hold=True)
    commitments[:] = [{'id': 'fixture-cleaning', 'reservation_id': FIXTURE_ID, 'vehicle_id': vehicle['id'],
                      'order_id': None, 'kind': 'Limpieza', 'active': False,
                      'starts_at': '2026-01-01T12:00:01Z', 'ends_at': '2026-01-01T12:05:00Z',
                      'reason': 'CONFLICTO de limpieza tras devolución tardía; requiere reprogramación'}]
    refresh(page)

    # The release is confirmed INLINE in the folio first: same canonical command,
    # in place, no navigation. The dossier keeps a secondary path (checked below).
    page.goto(APP + '/alquileres/folio/?id=' + FIXTURE_ID + '&seccion=Gastos', wait_until='networkidle')
    stage(page, 'Finalizado').click()
    release = page.get_by_role('region', name='Liberación del vehículo', exact=True)
    expect(release).to_contain_text('compromiso en conflicto sin resolver')
    before = len(reservation_commands)
    review = release.get_by_label('Descripción de la entrega y la condición del vehículo', exact=True)
    review.fill('Inline folio delivery review')
    release.get_by_role('button', name='Confirmar entrega y liberar el vehículo', exact=True).click()
    confirmation = release.get_by_role('region', name='Confirmación de liberación', exact=True)
    expect(confirmation).to_contain_text('ALQ-99001')
    confirmation.get_by_role('button', name='Confirmar la liberación del vehículo', exact=True).click()
    expect(release.locator('[role=status]').filter(has_text='El vehículo sigue retenido')).to_be_visible()
    assert reservation_commands[-1]['command'] == 'review_return_cleaning'
    assert reservation_commands[-1]['payload']['blockId'] == 'fixture-cleaning'
    assert len(reservation_commands) == before + 1
    # The folio updates in place: the pending-release wording disappears without navigation.
    expect(page.locator('main')).not_to_contain_text('pendiente de liberar')
    # Restore the synthetic state so the dossier scenario below runs unchanged.
    booking['version'] -= 1
    commitments[:] = [{'id': 'fixture-cleaning', 'reservation_id': FIXTURE_ID, 'vehicle_id': vehicle['id'],
                      'order_id': None, 'kind': 'Limpieza', 'active': False,
                      'starts_at': '2026-01-01T12:00:01Z', 'ends_at': '2026-01-01T12:05:00Z',
                      'reason': 'CONFLICTO de limpieza tras devolución tardía; requiere reprogramación'}]

    # The release also lives in the vehicle dossier as a secondary path.
    page.goto(APP + '/vehiculos/expediente/?id=' + vehicle['id'] + '&seccion=Alquileres', wait_until='networkidle')
    page.get_by_role('button', name='Ver detalle', exact=True).first.click()
    detail = page.get_by_role('dialog')
    release = detail.get_by_role('region', name='Liberación del vehículo')
    expect(release).to_contain_text('compromiso en conflicto sin resolver')
    expect(release).to_contain_text('no cobra nada')
    before = len(reservation_commands)
    review = detail.get_by_label('Descripción de la entrega y la condición del vehículo', exact=True)
    review.fill('Synthetic actual delivery review')
    detail.get_by_role('button', name='Confirmar entrega y liberar el vehículo', exact=True).click()
    confirmation = detail.get_by_role('region', name='Confirmación de liberación', exact=True)
    expect(confirmation).to_contain_text('ALQ-99001')
    expect(confirmation).to_contain_text('Synthetic actual delivery review')
    assert len(reservation_commands) == before
    vehicle['version'] += 1
    detail.get_by_role('button', name='Confirmar la liberación del vehículo', exact=True).click()
    expect(detail.locator('p[role=alert]').filter(has_text='El vehículo cambió')).to_be_visible()
    assert reservation_commands[-1]['payload']['expectedVehicleVersion'] == vehicle['version'] - 1
    expect(confirmation).to_contain_text('Synthetic actual delivery review')
    detail.get_by_role('button', name='Volver a revisar la entrega', exact=True).click()
    expect(review).to_have_value('Synthetic actual delivery review')
    # The dossier is read again so the release is confirmed against the current vehicle version.
    page.keyboard.press('Escape')
    page.reload(wait_until='networkidle')
    page.get_by_role('button', name='Ver detalle', exact=True).first.click()
    detail = page.get_by_role('dialog')
    detail.get_by_label('Descripción de la entrega y la condición del vehículo', exact=True).fill('Synthetic actual delivery review')
    detail.get_by_role('button', name='Confirmar entrega y liberar el vehículo', exact=True).click()
    mode['cleaningFail'] = True
    detail.get_by_role('button', name='Confirmar la liberación del vehículo', exact=True).click()
    expect(detail.locator('p[role=alert]').filter(has_text='No se guardó la operación')).to_be_visible()
    mode['cleaningFail'] = False
    commitments.append({'id': 'other-current-reservation', 'reservation_id': 'another-rental',
                        'vehicle_id': vehicle['id'], 'order_id': None, 'kind': 'Reserva', 'active': True,
                        'starts_at': (now - timedelta(hours=1)).isoformat(),
                        'ends_at': (now + timedelta(hours=1)).isoformat(), 'reason': 'Other current occupancy'})
    detail.get_by_role('button', name='Confirmar la liberación del vehículo', exact=True).evaluate('(button)=>{button.click();button.click()}')
    expect(detail.locator('[role=status]').filter(has_text='Entrega confirmada. El vehículo sigue retenido')).to_be_visible()
    assert reservation_commands[-1] == reservation_commands[-2]
    assert vehicle['status'] == 'En taller' and vehicle['readiness_hold']
    expect(detail).not_to_contain_text('El servidor confirmó la liberación')
    page.screenshot(path=str(ROOT / 'release-blocked.png'), full_page=True)

    # A separate active commitment releases only when no independent hold remains.
    commitments[:] = [{**commitments[0], 'active': True, 'reason': 'Revisión posterior a devolución'}]
    booking['version'] = 30
    vehicle['version'] = 5
    mode['cleaningBlocked'] = False
    page.goto(APP + '/vehiculos/expediente/?id=' + vehicle['id'] + '&seccion=Alquileres', wait_until='networkidle')
    page.get_by_role('button', name='Ver detalle', exact=True).first.click()
    detail = page.get_by_role('dialog')
    detail.get_by_label('Descripción de la entrega y la condición del vehículo', exact=True).fill('Actual active delivery reviewed')
    detail.get_by_role('button', name='Confirmar entrega y liberar el vehículo', exact=True).click()
    for width in [1440, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert_fits(page)
        assert detail.get_by_role('button', name='Confirmar la liberación del vehículo', exact=True).bounding_box()['height'] >= (44 if width <= 600 else 36)
    detail.get_by_role('button', name='Confirmar la liberación del vehículo', exact=True).click()
    expect(detail.locator('[role=status]').filter(has_text='El servidor confirmó la liberación')).to_be_visible()
    assert vehicle['status'] == 'Disponible' and not vehicle['readiness_hold']
    inspections[:] = [{'id': 'fixture-return-proof', 'reservation_id': FIXTURE_ID,
                      'kind': 'Retorno', 'occurred_at': booking['actual_return_at'],
                      'km': 110, 'fuel': 80, 'condition': 'Returned', 'accessories': '', 'evidence': 'Returned'}]
    page.goto(APP + '/alquileres/', wait_until='networkidle')
    expect(page.locator('main')).to_contain_text('Alquiler finalizado')

    # The existing read guard and write-button restrictions apply to old and new routes.
    mode['denied'] = {'orders.write'}
    page.goto(APP + '/alquileres/', wait_until='networkidle')
    expect(page.get_by_role('button', name='Nuevo alquiler', exact=True)).to_be_disabled()
    mode['denied'] = {'orders.read'}
    for path in ['/alquileres/', '/alquileres/folio/?id=' + FIXTURE_ID, '/calendario/',
                 '/vehiculos/reservas/', '/vehiculos/alquiler/?id=' + FIXTURE_ID]:
        page.goto(APP + path, wait_until='networkidle')
        expect(page.get_by_role('heading', name='Acceso restringido', exact=True)).to_be_visible()
    mode['denied'] = set()


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    # Read configuration only, never credentials, manifests or database records.
    public_url = next(line.split('=', 1)[1].strip().strip('"')
                      for line in Path('.env.local').read_text(encoding='utf8').splitlines()
                      if line.startswith('NEXT_PUBLIC_SUPABASE_URL='))
    storage_key = 'sb-' + urlparse(public_url).hostname.split('.')[0] + '-auth-token'
    session = {'access_token': 'synthetic-token-never-sent-to-server', 'refresh_token': 'synthetic-refresh',
               'expires_at': 4102444800, 'expires_in': 3600, 'token_type': 'bearer',
               'user': {'id': USER_ID, 'email': 'fixture@example.invalid',
                        'aud': 'authenticated', 'role': 'authenticated', 'app_metadata': {}, 'user_metadata': {}}}
    expect.set_options(timeout=30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, timezone_id='Asia/Tokyo')
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(APP + '/vehiculos/alquiler/?id=' + FIXTURE_ID + '&seccion=Salida%20y%20devoluci%C3%B3n',
                      wait_until='networkidle')
            expect(page.get_by_role('button', name='Iniciar salida', exact=True)).to_be_visible()
            expect(page.locator('textarea[name=review]')).to_have_count(0)
            page.get_by_role('button', name='Iniciar salida', exact=True).click()
            fill_review(page, '100.5', '101', 'Departure draft only')
            page.get_by_role('button', name='Registrar entrega', exact=True).click()
            assert not commands
            expect(page.get_by_role('region', name='Confirmación de inspección')).to_have_count(0)
            fill_review(page, '100', '90', 'Departure draft only')
            refresh(page)
            expect(page.locator('textarea[name=review]')).to_have_value('Departure draft only')
            page.get_by_role('button', name='Registrar entrega', exact=True).click()
            confirmation = page.get_by_role('region', name='Confirmación de inspección')
            for text in ['ALQ-99001', customer['name'], vehicle['plate'], '100 km', '90 %', 'El Salvador']:
                expect(confirmation).to_contain_text(text)
            assert not commands
            page.get_by_role('button', name='Confirmar salida', exact=True).click()
            expect(page.locator('main [role=alert]')).to_contain_text('No se guardó la operación')
            expect(page.locator('textarea[name=review]')).to_have_value('Departure draft only')
            mode['fail'] = False
            # Two public button clicks in the same browser turn must issue exactly one retry.
            page.get_by_role('button', name='Confirmar salida', exact=True).evaluate('(button)=>{button.click();button.click()}')
            expect(page.get_by_role('button', name='Iniciar devolución', exact=True)).to_be_visible()
            assert len(commands) == 2
            assert commands[0] == commands[1], 'Identical retry must retain command, version and idempotency key'
            expect(page.locator('textarea[name=review]')).to_have_count(0)
            expect(page.get_by_role('main')).to_contain_text('Departure draft only')
            refresh(page)
            expect(page.locator('textarea[name=review]')).to_have_count(0)
            page.screenshot(path=str(ROOT / 'departure-saved-desktop.png'), full_page=True)

            page.get_by_role('button', name='Iniciar devolución', exact=True).click()
            for name in ['km', 'fuel', 'review']:
                expect(page.locator(f'[name={name}]')).to_have_value('')
            expect(page.get_by_text('Comparación con la salida guardada', exact=True)).to_be_visible()
            fill_review(page, '99', '80', 'Return draft only')
            page.get_by_role('button', name='Registrar devolución', exact=True).click()
            assert len(commands) == 2
            fill_review(page, '110', '80', 'Return draft only')
            for width in [1440, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                assert_fits(page)
            page.get_by_role('button', name='Registrar devolución', exact=True).click()
            booking['version'] = 6  # Concurrent update arrives after confirmation.
            mode['fail'] = 'version'
            refresh(page)
            page.get_by_role('button', name='Confirmar devolución', exact=True).click()
            expect(page.locator('main [role=alert]')).to_contain_text('La reserva cambió')
            assert commands[-1]['command'] == 'return'
            assert commands[-1]['payload']['expectedVersion'] == 5
            expect(page.locator('[name=review]')).to_have_value('Return draft only')
            page.get_by_role('button', name='Volver al borrador', exact=True).click()
            expect(page.locator('[name=km]')).to_have_value('110')
            page.get_by_role('button', name='Descartar borrador', exact=True).click()
            page.get_by_role('button', name='Iniciar devolución', exact=True).click()
            expect(page.locator('[name=review]')).to_have_value('')
            fill_review(page, '110', '80', 'Fresh quick return')
            mode['fail'] = False
            page.get_by_role('button', name='Registrar devolución', exact=True).click()
            assert_fits(page)
            page.screenshot(path=str(ROOT / 'return-confirmation-mobile.png'), full_page=True)
            page.get_by_role('button', name='Confirmar devolución', exact=True).click()
            expect(page.locator('main p[role=status]').filter(has_text='Devolución guardada')).to_contain_text('sigue retenido por un compromiso en conflicto')
            expect(page.locator('[name=review]')).to_have_count(0)
            assert commands[-1]['payload']['expectedVersion'] == 6
            assert len(inspections) == 2
            stage(page, 'Acuerdo').click()
            expect(page.locator('main')).to_contain_text('Devuelto · pendiente de liberar')
            expect(page.locator('main')).not_to_contain_text('Alquiler finalizado')

            # Unknown historic readings stay unknown in history and the outgoing comparison.
            booking['rental_state'] = 'Entregado'
            inspections[:] = [{**inspections[0], 'km': None, 'fuel': None}]
            stage(page, 'Devolución').click()
            refresh(page)
            expect(page.get_by_role('main')).to_contain_text('Sin registro')
            page.get_by_role('button', name='Iniciar devolución', exact=True).click()
            expect(page.get_by_role('main')).to_contain_text('Kilometraje: Sin registro · Combustible: Sin registro')
            assert_fits(page)
            page.get_by_role('button', name='Descartar borrador', exact=True).click()
            booking['rental_state'] = 'Preparado'
            booking['version'] = 8
            inspections.clear()
            refresh(page)
            page.get_by_role('button', name='Iniciar salida', exact=True).click()
            fill_review(page, '100', '90', 'Never reinterpret this departure')
            page.get_by_role('button', name='Registrar entrega', exact=True).click()
            booking['rental_state'] = 'Entregado'
            booking['version'] = 9
            mode['fail'] = 'version'
            refresh(page)
            page.get_by_role('button', name='Confirmar salida', exact=True).click()
            expect(page.locator('main [role=alert]')).to_contain_text('La reserva cambió')
            assert commands[-1]['command'] == 'depart'
            assert commands[-1]['payload']['expectedVersion'] == 8
            expect(page.locator('[name=review]')).to_have_value('Never reinterpret this departure')
            expect(page.get_by_role('button', name='Confirmar devolución', exact=True)).to_have_count(0)
            workspace_checks(page)
            assert not blocked, blocked
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'syntheticCommands': len(commands), 'syntheticReservationCommands': len(reservation_commands),
              'realApiRequests': 0, 'workspaceAndAliases': True, 'permissionGuards': True,
              'scopedFinancesAndGroupedNotice': True, 'extensionPreviewWithoutBillingOrCash': True,
              'cleaningReviewEvidence': True, 'cleaningRecoveryConfirmed': True, 'cleaningBlockedReleaseSeparate': True,
              'draftSurvivesRefreshAndFailure': True, 'explicitFreshReturn': True,
              'capturedVersion': True, 'stableRetryAndDuplicateGuard': True,
              'quickReturn': True, 'unknownReadings': True, 'cleaningConflictVisible': True,
              'widths': [1440, 390, 320], 'browserErrors': errors, 'blockedRequests': blocked}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
