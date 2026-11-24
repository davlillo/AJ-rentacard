"""Synthetic lifecycle checks; all API traffic is fulfilled or blocked locally."""
import copy
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
import rental_folio_readonly as fixture

APP = fixture.APP
ROOT = Path('test-results/rental-lifecycle')
periods, receipts, period_commands, blocked, errors = [], [], [], [], []
state = {'periodFail': True, 'receiptFail': True}
reads = {'customers', 'customer_aliases', 'vehicles', 'work_orders', 'expenses', 'workshop_tasks',
         'reservations', 'vehicle_files', 'rental_inspections', 'rental_extra_proposals',
         'vehicle_commitments', 'reservation_evidence', 'customer_payments',
         'payment_applications', 'payment_refunds', 'rental_periods', 'rental_contracts', 'contract_acceptances'}


def protect(route):
    request = route.request
    url = urlparse(request.url)
    resource = url.path.split('/')[-1]
    if url.hostname == '127.0.0.1' and url.port == 3030:
        if request.method not in ['GET', 'HEAD']:
            blocked.append(url.path)
            route.abort()
        else:
            route.continue_()
        return
    if '/rest/v1/' in url.path and '/rpc/' not in url.path:
        if request.method != 'GET' or resource not in reads:
            blocked.append(url.path)
            route.abort()
            return
        if resource == 'rental_periods':
            route.fulfill(json=periods)
            return
    if '/rpc/' in url.path:
        if resource == 'record_linked_receipt':
            body = copy.deepcopy(request.post_data_json)
            assert body['payload']['reservationId'] == fixture.FIXTURE_ID
            assert body['payload']['customerId'] == fixture.customer['id']
            receipts.append(body)
            if state['receiptFail']:
                route.fulfill(status=503, json={'message': 'SYNTHETIC_UNAVAILABLE'})
                return
            amount = float(body['payload']['amount'])
            fixture.document['scope_balance'] -= amount
            fixture.document['balance'] -= amount
            fixture.application['scope_amount'] += amount
            fixture.application['amount'] += amount
            route.fulfill(json={'id': 'synthetic-new-receipt'})
            return
        if resource == 'execute_reservation_command' and request.post_data_json['command'] == 'period':
            body = copy.deepcopy(request.post_data_json)
            period_commands.append(body)
            assert body['payload']['reservationId'] == fixture.FIXTURE_ID
            if state['periodFail']:
                route.fulfill(status=503, json={'message': 'SYNTHETIC_UNAVAILABLE'})
                return
            payload = body['payload']
            periods.append({'id': 'synthetic-period', 'reservation_id': fixture.FIXTURE_ID,
                            'document_id': fixture.document['id'], 'starts_on': payload['startsOn'],
                            'ends_on': payload['endsOn'], 'reason': payload['reason']})
            route.fulfill(json=periods[-1])
            return
    fixture.protect(route)


def open_folio(page, section=None, legacy=False):
    path = '/vehiculos/alquiler/' if legacy else '/alquileres/folio/'
    page.goto(APP + path + '?id=' + fixture.FIXTURE_ID + ('&seccion=' + section if section else ''),
              wait_until='networkidle')
    expect(page.get_by_role('heading', level=1, name=re.compile('ALQ-99001'))).to_be_visible()


def collect(page):
    # The collection control lives only in the Cuentas stage of the folio.
    stage(page, 'Cuentas').click()
    expect(page.get_by_role('button', name='Realizar cobro', exact=True)).to_have_count(1)


def stage(page, label):
    # The circles are the only navigation of the folio.
    return page.get_by_role('region', name='Fases del folio').get_by_role('button', name=re.compile('^' + label + ':'))
    page.get_by_role('button', name='Realizar cobro', exact=True).click()
    dialog = page.get_by_role('dialog')
    expect(dialog.get_by_role('region', name='Cobro o anticipo vinculado')).to_have_count(1)
    expect(page.get_by_role('region', name='Cobro o anticipo vinculado')).to_have_count(1)
    expect(dialog.get_by_label('Origen del dinero')).to_contain_text('Existing advance')
    expect(dialog.get_by_label('A qué documento se aplica el cobro')).not_to_contain_text('Unrelated rental charge')
    expect(dialog.get_by_label('A qué documento se aplica el cobro')).not_to_contain_text('Grouped fixture charge')
    assert page.locator('button button, form form').count() == 0
    dialog.get_by_role('button', name='Cerrar', exact=True).click()
    expect(page.get_by_role('region', name='Cobro o anticipo vinculado')).to_have_count(0)


def fit(page, name):
    for width in [1440, 1024, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        fixture.assert_fits(page)
        for button in page.get_by_role('region', name='Fases del folio').get_by_role('button').all():
            assert button.bounding_box()['height'] >= 44
        page.screenshot(path=str(ROOT / f'{name}-{width}.png'), full_page=True)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    public_url = next(line.split('=', 1)[1].strip().strip('"')
                      for line in Path('.env.local').read_text(encoding='utf8').splitlines()
                      if line.startswith('NEXT_PUBLIC_SUPABASE_URL='))
    storage_key = 'sb-' + urlparse(public_url).hostname.split('.')[0] + '-auth-token'
    session = {'access_token': 'synthetic-token-never-sent-to-server', 'refresh_token': 'synthetic-refresh',
               'expires_at': 4102444800, 'expires_in': 3600, 'token_type': 'bearer',
               'user': {'id': fixture.USER_ID, 'email': 'fixture@example.invalid',
                        'aud': 'authenticated', 'role': 'authenticated', 'app_metadata': {}, 'user_metadata': {}}}
    fixture.mode.update(finance=True, fail=False)
    now = datetime.now(timezone.utc)
    fixture.booking.update(starts_at=(now-timedelta(days=2, hours=1)).isoformat(),
                           ends_at=(now+timedelta(days=4, hours=23)).isoformat(),
                           actual_departure_at=(now-timedelta(days=2)).isoformat(), total=350)
    expect.set_options(timeout=30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, timezone_id='Asia/Tokyo')
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            for status, rental_state, phase, name in [
                ('Borrador', 'Preparado', 'Acuerdo', 'draft'),
                ('Confirmada', 'Preparado', 'Acuerdo', 'reserved'),
                ('Confirmada', 'Entregado', 'Devolución', 'active'),
                ('Confirmada', 'Devuelto', 'Cuentas', 'returned'),
                ('Confirmada', 'Cerrado', 'Cuentas', 'complete'),
                ('Cancelada', 'Preparado', None, 'canceled'),
            ]:
                fixture.booking.update(status=status, rental_state=rental_state)
                if rental_state in ['Devuelto', 'Cerrado']:
                    fixture.booking['actual_return_at'] = (now-timedelta(days=1)).isoformat()
                open_folio(page)
                progress = page.get_by_role('region', name='Fases del folio')
                if phase:
                    expect(progress.locator('[aria-current=step]')).to_contain_text(phase)
                else:
                    expect(progress.locator('[aria-current=step]')).to_have_count(0)
                    expect(progress).to_contain_text('cancelado')
                if name in ['draft', 'reserved', 'canceled']:
                    expect(page.get_by_role('region', name='Tiempo del alquiler')).to_have_count(0)
                if name == 'active':
                    # The vehicle is out: the open step of the flow is the return.
                    stage(page, 'Alquilado').click()
                    expect(page.get_by_role('region', name='Tiempo del alquiler')).to_contain_text('Día 3 de 7')
                    expect(page.get_by_role('region', name='Tiempo del alquiler')).to_contain_text('NO es un importe a cobrar ni un pago recibido')
                if name == 'returned':
                    expect(page.locator('main')).not_to_contain_text('Proceso finalizado.')
                    # The money still pending keeps the flow in Cuentas.
                    expect(page.locator('main')).to_contain_text('Etapa actual: Cuentas.')
                if name == 'complete':
                    expect(page.locator('main')).not_to_contain_text('Proceso finalizado.')
                    expect(page.locator('main')).to_contain_text('Etapa actual: Cuentas.')
                    stage(page, 'Alquilado').click()
                    expect(page.locator('.rental-money')).to_contain_text('$80.00')
                collect(page)
                fit(page, name)
                assert not receipts and not period_commands and not fixture.commands and not fixture.reservation_commands

            fixture.booking.update(status='Confirmada', rental_state='Entregado', actual_return_at=None)
            open_folio(page)
            page.get_by_role('button', name='Finalizado: pendiente', exact=True).click()
            # Selecting a circle shows the content of that stage and says which one it is.
            expect(page.locator('main')).to_contain_text('Está consultando la etapa')
            expect(page.get_by_role('button', name='Terminar alquiler', exact=True)).to_have_count(0)
            page.get_by_role('button', name='Volver a la etapa actual').click()
            # The operation and its next action live in the Alquilado stage.
            stage(page, 'Alquilado').click()
            page.get_by_role('button', name='Terminar alquiler', exact=True).click()
            review = page.get_by_role('region', name='Revisión para terminar alquiler')
            expect(review).to_contain_text('$350.00')
            expect(review).to_contain_text('$120.00')
            expect(review).to_contain_text('$40.00')
            expect(review).to_contain_text('$80.00')
            expect(review).to_contain_text('NO es importe emitido ni PAGO')
            assert not period_commands and not receipts
            # The collection control is not in the rented stage: it lives in Cuentas.
            expect(page.get_by_role('button', name='Realizar cobro', exact=True)).to_have_count(0)
            fit(page, 'finish-review')

            # Reviewing an explicit manual amount is not a financial command.
            # The period form belongs to the extension action of the active rental.
            page.get_by_role('button', name='Volver al alquiler', exact=True).click()
            page.get_by_text('Extender o acordar la fecha de devolución', exact=True).click()
            page.get_by_text('Documentar otro período de alquiler', exact=True).click()
            today = now.astimezone(timezone(timedelta(hours=-6))).date()
            start = (today-timedelta(days=2)).isoformat()
            end = (today-timedelta(days=1)).isoformat()
            page.get_by_label('Período desde (inclusive)').fill(start)
            page.get_by_label('Período hasta (inclusive)').fill(end)
            page.get_by_label('Importe acordado del período USD').fill('75.00')
            page.get_by_label('Acuerdo del período', exact=True).fill('Synthetic manual early return agreement')
            page.get_by_role('button', name='Revisar importe a cobrar del período', exact=True).click()
            expect(page.get_by_role('region', name='Revisión del importe a cobrar')).to_contain_text('$75.00')
            assert not period_commands
            page.get_by_role('button', name='Emitir importe a cobrar del período (no registra cobro)').click()
            expect(page.locator('main [role=alert]')).to_contain_text('No se guardó la operación')
            state['periodFail'] = False
            page.get_by_role('button', name='Emitir importe a cobrar del período (no registra cobro)').evaluate('(b)=>{b.click();b.click()}')
            expect(page.get_by_role('region', name='Revisión del importe a cobrar')).to_have_count(0)
            assert len(period_commands) == 2 and period_commands[0] == period_commands[1]
            assert fixture.booking['total'] == 350
            page.get_by_role('button', name='Revisar importe a cobrar del período').click()
            expect(page.locator('main [role=alert]')).to_contain_text('superpone')
            assert len(period_commands) == 2
            # The finish review stays available for the operator.
            page.get_by_role('button', name='Terminar alquiler', exact=True).click()
            review = page.get_by_role('region', name='Revisión para terminar alquiler')

            # Collection closes/reopens with fresh form state and updates scoped balances.
            stage(page, 'Cuentas').click()
            page.get_by_role('button', name='Realizar cobro', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.get_by_label('Importe recibido (USD)').fill('10')
            dialog.get_by_label('Cuenta o caja receptora').fill('Synthetic cash')
            dialog.get_by_label('Referencia del pago').fill('Synthetic collection only')
            dialog.get_by_role('button', name='Guardar cobro y aplicar al documento').click()
            expect(dialog.get_by_role('alert')).to_contain_text('No se completó')
            state['receiptFail'] = False
            dialog.get_by_role('button', name='Guardar cobro y aplicar al documento').evaluate('(b)=>{b.click();b.click()}')
            expect(dialog).to_have_count(0)
            assert len(receipts) == 2 and receipts[0] == receipts[1]
            # The finish review is opened again to read the balance after the collection.
            stage(page, 'Alquilado').click()
            page.get_by_role('button', name='Terminar alquiler', exact=True).click()
            review = page.get_by_role('region', name='Revisión para terminar alquiler')
            expect(review).to_contain_text('$70.00')
            collect(page)

            # Current permission revocation removes the open dialog and cached evidence.
            stage(page, 'Cuentas').click()
            page.get_by_role('button', name='Realizar cobro', exact=True).click()
            fixture.mode['denied'] = {'expenses.read', 'expenses.write'}
            # Keep financialAccess true deliberately: current permission must still win.
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(page.get_by_role('dialog')).to_have_count(0)
            expect(page.get_by_role('button', name='Realizar cobro', exact=True)).to_have_count(0)
            expect(page.get_by_role('region', name='Importes documentados del alquiler')).to_have_count(0)
            # The finish review states the revoked permission in its own words.
            stage(page, 'Alquilado').click()
            page.get_by_role('button', name='Terminar alquiler', exact=True).click()
            review = page.get_by_role('region', name='Revisión para terminar alquiler')
            expect(review).to_contain_text('sin ese permiso')
            page.get_by_role('button', name='Continuar con devolución').click()
            page.get_by_role('button', name='Iniciar devolución', exact=True).click()
            fixture.fill_review(page, '110', '80', 'Synthetic return inspection only')
            page.get_by_role('button', name='Registrar devolución', exact=True).click()
            assert not fixture.commands
            fixture.mode['fail'] = 'connection'
            page.get_by_role('button', name='Confirmar devolución', exact=True).click()
            expect(page.locator('main [role=alert]')).to_contain_text('No se guardó')
            fixture.mode['fail'] = False
            page.get_by_role('button', name='Confirmar devolución', exact=True).evaluate('(b)=>{b.click();b.click()}')
            expect(page.locator('main')).to_contain_text('Devolución guardada')
            assert len(fixture.commands) == 2 and fixture.commands[0] == fixture.commands[1]
            assert fixture.commands[-1]['payload']['km'] == 110
            assert fixture.commands[-1]['payload']['fuel'] == 80
            # The release of the vehicle is confirmed inline in the folio return stage.
            stage(page, 'Devolución').click()
            expect(page.get_by_role('region', name='Liberación del vehículo', exact=True)).to_be_visible()
            assert page.get_by_role('link', name='Confirmar entrega y liberar el vehículo →', exact=True).count() == 0
            expect(page.locator('main')).not_to_contain_text('limpieza')
            assert fixture.booking['total'] == 350
            fixture.mode['denied'] = set()
            open_folio(page, 'Períodos y abonos', legacy=True)
            # The legacy alias resolves to the stage that exists today.
            expect(page.get_by_role('region', name='Cuentas del alquiler')).to_be_visible()
            expect(page.locator('main')).to_contain_text('$70.00')
            collect(page)
            for section, landmark in [('Contrato', 'Contrato del alquiler'), ('Fotos y documentos', 'Fotos y documentos'),
                                      ('Gastos', 'Gastos de este alquiler')]:
                open_folio(page, section)
                # Those three are collapsed optional subsections of the last stage of the single flow.
                expect(page.locator('main summary', has_text=landmark)).to_be_visible()
                collect(page)
            assert not blocked and not fixture.blocked and not errors, (blocked, fixture.blocked, errors)
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'realApiRequests': 0, 'widths': [1440, 1024, 390, 320],
              'stages': 6, 'periodAttempts': len(period_commands), 'receiptAttempts': len(receipts),
              'returnAttempts': len(fixture.commands), 'blocked': blocked + fixture.blocked, 'errors': errors}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
