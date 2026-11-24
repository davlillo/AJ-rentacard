"""Synthetic checks for the rental Cuentas section; all API traffic is fulfilled or blocked locally."""
import copy
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
import rental_folio_readonly as fixture

APP = fixture.APP
ROOT = Path('test-results/rental-accounts')
periods, receipts, period_commands, blocked, errors = [], [], [], [], []
state = {'periodFail': False, 'receiptFail': False}
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
            receipts.append(body)
            if state['receiptFail']:
                route.fulfill(status=503, json={'message': 'SYNTHETIC_UNAVAILABLE'})
                return
            route.fulfill(json={'id': 'synthetic-receipt'})
            return
        if resource == 'execute_reservation_command' and request.post_data_json['command'] == 'period':
            body = copy.deepcopy(request.post_data_json)
            period_commands.append(body)
            assert body['payload']['reservationId'] == fixture.FIXTURE_ID
            if state['periodFail']:
                route.fulfill(status=503, json={'message': 'SYNTHETIC_UNAVAILABLE'})
                return
            payload = body['payload']
            periods.append({'id': 'synthetic-period-%d' % len(periods), 'reservation_id': fixture.FIXTURE_ID,
                            'document_id': fixture.document['id'], 'starts_on': payload['startsOn'],
                            'ends_on': payload['endsOn'], 'reason': payload['reason']})
            route.fulfill(json=periods[-1])
            return
    fixture.protect(route)


def open_folio(page, section=None):
    path = '/alquileres/folio/?id=' + fixture.FIXTURE_ID + ('&seccion=' + section if section else '')
    page.goto(APP + path, wait_until='networkidle')
    expect(page.get_by_role('heading', level=1, name=re.compile('ALQ-99001'))).to_be_visible()


def fit(page, name):
    for width in [1440, 1024, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        fixture.assert_fits(page)
        for button in page.get_by_role('region', name='Fases del folio').get_by_role('button').all():
            assert button.bounding_box()['height'] >= 44
        page.evaluate('window.scrollTo(0, 0)')
        page.screenshot(path=str(ROOT / f'{name}-{width}.png'), full_page=True)


def accounts_section(page):
    return page.get_by_role('region', name='Cuentas del alquiler')


def stage(page, label):
    # The circles are the only navigation of the folio.
    return page.get_by_role('region', name='Fases del folio').get_by_role('button', name=re.compile('^' + label + ':'))


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
    fixture.booking.update(starts_at=(now - timedelta(days=2, hours=1)).isoformat(),
                           ends_at=(now + timedelta(days=4, hours=23)).isoformat(),
                           actual_departure_at=(now - timedelta(days=2)).isoformat(),
                           actual_return_at=(now - timedelta(days=1)).isoformat(),
                           status='Confirmada', rental_state='Cerrado', total=350)
    expect.set_options(timeout=30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, timezone_id='Asia/Tokyo')
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            # The Cuentas section is visible and states every amount with its exact meaning.
            open_folio(page, 'Cuentas')
            expect(stage(page, 'Cuentas')).to_be_visible()
            section = accounts_section(page)
            totals = page.get_by_role('region', name='Resumen de cuentas')
            expect(totals).to_contain_text('$350.00')
            expect(totals).to_contain_text('$40.00')
            expect(totals).to_contain_text('$80.00')
            expect(totals).to_contain_text('Es lo pactado en el contrato')
            expect(totals).to_contain_text('Un anticipo sin aplicar todavía no cuenta aquí')
            # The reconciliation alarm states the difference between what was agreed and what was
            # issued, once, in plain words.
            alarm = section.get_by_test_id('reconciliation-alarm')
            expect(alarm).to_contain_text('Facturado $120.00 de $350.00 acordados')
            expect(alarm).to_contain_text('faltan $230.00 por emitir')
            expect(section).to_contain_text('$230.00')
            expect(section).to_contain_text('$10.00')
            expect(section).not_to_contain_text('Sin saldo pendiente')
            expect(section).not_to_contain_text('cargo')
            # Reading the section never issues money.
            assert not period_commands and not receipts, (period_commands, receipts)

            # A grouped share belongs to a shared document: the section points to Cobros and never offers it.
            expect(section).to_contain_text('Parte de un documento agrupado')
            expect(section).to_contain_text('$20.00')
            expect(section.get_by_role('link', name='Cobros', exact=True)).to_have_attribute('href', '/cobros/')
            status = section.get_by_role('status')
            expect(status).to_contain_text('documento agrupado')
            expect(status).to_contain_text('no se cobra desde esta sección')
            expect(status).to_contain_text('Saldo pendiente de los importes ya emitidos al cliente: $80.00')
            expect(status).not_to_contain_text('Saldo pendiente por cobrar: $80.00')

            # The stage is honest: money pending keeps Cuentas as the current step.
            progress = page.get_by_role('region', name='Fases del folio')
            expect(progress.get_by_role('button', name='Cuentas: fase actual', exact=True)).to_be_visible()
            expect(progress.get_by_role('button', name='Finalizado: pendiente', exact=True)).to_be_visible()
            expect(progress.locator('[aria-current=step]')).to_contain_text('Cuentas')
            expect(progress).to_contain_text('Etapa actual: Cuentas')
            expect(progress).to_contain_text('Pendiente por cobrar: $310.00')

            # The period is issued only after an explicit review of the amount and the version.
            # The period form belongs to the extension action of an active rental.
            fixture.booking.update(rental_state='Entregado')
            open_folio(page)
            # The period form belongs to the extension action of the Alquilado stage.
            stage(page, 'Alquilado').click()
            page.get_by_text('Extender o acordar la fecha de devolución', exact=True).click()
            page.get_by_text('Documentar otro período de alquiler', exact=True).click()
            page.get_by_label('Período desde (inclusive)', exact=True).fill((now - timedelta(days=1)).date().isoformat())
            page.get_by_label('Período hasta (inclusive)', exact=True).fill(now.date().isoformat())
            page.get_by_label('Importe acordado del período USD', exact=True).fill('120.00')
            page.get_by_label('Acuerdo del período', exact=True).fill('Synthetic agreed period')
            page.get_by_role('button', name='Revisar importe a cobrar del período', exact=True).click()
            review = page.get_by_role('region', name='Revisión del importe a cobrar')
            expect(review).to_contain_text('$120.00')
            expect(review).to_contain_text('NO registra un cobro')
            state['periodFail'] = True
            page.get_by_role('button', name='Emitir importe a cobrar del período (no registra cobro)', exact=True).click()
            expect(page.locator('main [role=alert]')).to_contain_text('No se guardó')
            expect(review).to_contain_text('$120.00')
            state['periodFail'] = False
            page.get_by_role('button', name='Emitir importe a cobrar del período (no registra cobro)', exact=True).click()
            expect(page.get_by_role('region', name='Revisión del importe a cobrar')).to_have_count(0)
            assert len(period_commands) == 2 and period_commands[0] == period_commands[1]
            assert period_commands[-1]['payload']['expectedVersion'] == fixture.booking['version']
            assert period_commands[-1]['payload']['amount'] == '120.00'
            assert not receipts, 'Issuing a period must not register cash.'

            # The place that states what is owed is also where the amount is issued. The action
            # opens a modal with the agreed facts at hand: the operator never retypes them.
            open_folio(page, 'Cuentas')
            issue = accounts_section(page).get_by_role('button', name='Emitir importe a cobrar', exact=True)
            expect(issue).to_have_count(1)
            expect(page.get_by_role('dialog')).to_have_count(0)
            issue.click()
            dialog = page.get_by_role('dialog')
            expect(dialog).to_be_visible()
            expect(dialog.get_by_role('heading', name='Emitir importe a cobrar', exact=True)).to_be_visible()
            # The consequence is stated in plain words, without the jargon of a charge.
            expect(dialog).to_contain_text('Registra el documento de cobro de este período')
            expect(dialog).to_contain_text('No recibe dinero ni cancela la deuda pendiente')
            expect(dialog).not_to_contain_text('cargo')
            # The agreed facts are read-only context: customer, vehicle, period, days and totals.
            facts = dialog.get_by_role('region', name='Datos ya conocidos del período')
            expect(facts).to_contain_text('Synthetic inspection customer')
            expect(facts).to_contain_text('FIXTURE-ONLY')
            expect(facts.get_by_text('Días del período', exact=True)).to_be_visible()
            expect(facts.get_by_text('Total acordado', exact=True)).to_be_visible()
            expect(facts).to_contain_text('$350.00')
            expect(facts).to_contain_text('$310.00')
            expect(facts).to_contain_text('$230.00')
            # Only what needs a decision is editable, and the amount starts with the agreed one.
            expect(dialog.get_by_label('Importe del período USD', exact=True)).to_have_value('230.00')
            expect(dialog.get_by_label('Fecha de emisión del período', exact=True)).not_to_have_value('')
            expect(dialog.get_by_label('Vencimiento del período', exact=True)).not_to_have_value('')
            expect(dialog.get_by_label('Acuerdo del período', exact=True)).to_be_visible()
            expect(dialog).to_contain_text('Total acordado de referencia: $350.00')
            # The period dates are prefilled from the agreement, inside a collapsed disclosure.
            expect(dialog.get_by_text('Modificar las fechas del período', exact=True)).to_be_visible()
            disclosure = dialog.locator('details')
            expect(disclosure).to_have_count(1)
            assert not disclosure.get_attribute('open')
            expect(dialog.get_by_label('Período desde (inclusive)', exact=True)).not_to_have_value('')
            expect(dialog.get_by_label('Período hasta (inclusive)', exact=True)).not_to_have_value('')
            # A failed command keeps the typed values, shows the error and retries with the same key.
            dialog.get_by_label('Acuerdo del período', exact=True).fill('Synthetic agreed amount from Cuentas')
            before = len(period_commands)
            state['periodFail'] = True
            dialog.get_by_role('button', name='Emitir importe a cobrar de $230.00', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('No se guardó')
            expect(dialog.get_by_label('Importe del período USD', exact=True)).to_have_value('230.00')
            expect(dialog.locator('textarea[name=reason]')).to_have_value('Synthetic agreed amount from Cuentas')
            state['periodFail'] = False
            dialog.get_by_role('button', name='Emitir importe a cobrar de $230.00', exact=True).click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            # The canonical command carries the version, the amount and the idempotency key.
            assert len(period_commands) == before + 2, period_commands
            assert period_commands[-1]['command'] == 'period'
            assert period_commands[-1]['payload']['expectedVersion'] == fixture.booking['version']
            assert period_commands[-1]['payload']['amount'] == '230.00'
            assert period_commands[-1]['idempotency_key'], period_commands[-1]
            assert period_commands[-1]['idempotency_key'] == period_commands[-2]['idempotency_key']
            assert not receipts, 'Issuing from Cuentas must not register cash.'
            # The modal returns the focus to its action and fits a 320 CSS pixel screen.
            issue.click()
            dialog = page.get_by_role('dialog')
            expect(dialog).to_be_visible()
            page.set_viewport_size({'width': 320, 'height': 1000})
            overflow = page.evaluate("""() => {
              const dialog = document.querySelector('[role=dialog]');
              return {page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                      dialog: dialog.scrollWidth - dialog.clientWidth};
            }""")
            assert overflow['page'] <= 0, overflow
            assert overflow['dialog'] <= 0, overflow
            # The body of the modal scrolls: the content never overflows the screen sideways.
            scrolling = page.evaluate("""() => {
              const dialog = document.querySelector('[role=dialog]');
              return {scroll: dialog.scrollHeight, client: dialog.clientHeight};
            }""")
            assert scrolling['scroll'] > scrolling['client'], scrolling
            page.evaluate('window.scrollTo(0, 0)')
            page.screenshot(path=str(ROOT / 'cuentas-modal-320.png'), full_page=True)
            page.keyboard.press('Escape')
            expect(page.get_by_role('dialog')).to_have_count(0)
            expect(issue).to_be_focused()
            page.set_viewport_size({'width': 1440, 'height': 1000})

            # The collection reuses the global collection dialog; no duplicate form is mounted.
            open_folio(page, 'Cuentas')
            expect(page.get_by_role('button', name='Realizar cobro', exact=True)).to_have_count(1)
            # The collection is opened once, from the header of the folio.
            page.get_by_role('button', name='Realizar cobro', exact=True).click()
            dialog = page.get_by_role('dialog')
            expect(dialog.get_by_role('region', name='Cobro o anticipo vinculado', exact=True)).to_have_count(1)
            expect(page.get_by_role('region', name='Cobro o anticipo vinculado', exact=True)).to_have_count(1)
            expect(dialog.get_by_label('A qué documento se aplica el cobro', exact=True)).not_to_contain_text('Unrelated rental charge')
            expect(dialog.get_by_label('A qué documento se aplica el cobro', exact=True)).not_to_contain_text('Grouped fixture charge')
            # Only the individual charge is collectible here; the grouped share is not offered.
            expect(dialog.get_by_label('Importe recibido (USD)', exact=True)).to_have_value('60.00')

            # A balance that changes under the open form blocks the collection with the stale banner.
            fixture.document['scope_balance'] = 25
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(dialog.get_by_role('alert')).to_contain_text('Los importes o movimientos cambiaron')
            expect(dialog.get_by_role('button', name=re.compile('Guardar cobro'))).to_be_disabled()
            assert not receipts, 'A stale collection must never reach the server.'
            # The operator can review the updated amounts and continue.
            dialog.get_by_role('button', name='Revisé los saldos actualizados', exact=True).click()
            expect(dialog.get_by_role('alert')).to_have_count(0)
            fixture.document['scope_balance'] = 60
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            dialog.get_by_role('button', name='Cerrar', exact=True).click()
            expect(page.get_by_role('dialog')).to_have_count(0)

            # An advance already received is applied without registering new cash.
            page.get_by_role('button', name='Usar anticipo disponible', exact=True).click()
            dialog = page.get_by_role('dialog')
            expect(dialog.get_by_label('Origen del dinero', exact=True)).to_contain_text('Existing advance')
            expect(dialog.get_by_label('Medio de pago', exact=True)).to_have_count(0)
            expect(dialog.get_by_label('Cuenta o caja receptora', exact=True)).to_have_count(0)
            expect(dialog.get_by_label('Referencia del pago', exact=True)).to_have_count(0)
            dialog.get_by_label('Origen del dinero', exact=True).select_option('fixture-advance')
            destination = dialog.get_by_label('A qué documento se aplica el cobro', exact=True)
            expect(destination).to_contain_text('Scoped fixture charge')
            expect(destination).not_to_contain_text('Grouped fixture charge')
            destination.select_option('fixture-document')
            dialog.get_by_label('Importe recibido (USD)', exact=True).fill('10')
            dialog.get_by_role('button', name=re.compile('sin nuevo ingreso')).click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            assert len(receipts) == 1, receipts
            assert receipts[-1]['payload']['paymentId'] == 'fixture-advance'
            assert 'method' not in receipts[-1]['payload'] and 'account' not in receipts[-1]['payload']

            # Without orders.write the extension action disappears: there is no period to issue or read.
            fixture.booking.update(rental_state='Entregado')
            open_folio(page)
            stage(page, 'Alquilado').click()
            page.get_by_text('Extender o acordar la fecha de devolución', exact=True).click()
            page.get_by_text('Documentar otro período de alquiler', exact=True).click()
            expect(page.get_by_text('Períodos documentados y pagado hasta', exact=True)).to_be_visible()
            expect(page.get_by_text('Synthetic agreed period', exact=False)).to_be_visible()
            fixture.mode['denied'] = {'orders.write'}
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            # The revocation is applied first: the issuing controls are gone with the extension action.
            expect(page.get_by_text('Documentar otro período de alquiler', exact=True)).to_have_count(0)
            expect(page.get_by_text('Períodos documentados y pagado hasta', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='Revisar importe a cobrar del período', exact=True)).to_have_count(0)
            # The money of the rental is still collectible: only the issuing action is gone.
            open_folio(page, 'Cuentas')
            expect(page.get_by_role('button', name='Realizar cobro', exact=True)).to_have_count(1)
            # Without orders.write the issuing action in Cuentas is gone as well.
            expect(page.get_by_role('button', name='Emitir importe a cobrar', exact=True)).to_have_count(0)
            expect(accounts_section(page)).to_contain_text('Emitir un importe a cobrar requiere un alquiler confirmado')
            fixture.mode['denied'] = set()
            page.evaluate("window.dispatchEvent(new Event('focus'))")

            # The keyboard reaches the section and the focus stays visible.
            open_folio(page)
            tab = stage(page, 'Cuentas')
            tab.focus()
            expect(tab).to_be_focused()
            page.keyboard.press('Enter')
            expect(accounts_section(page)).to_be_visible()
            expect(accounts_section(page).get_by_role('region', name='Resumen de cuentas')).to_be_visible()

            # A permission revocation hides every amount and every money action at once.
            fixture.mode['denied'] = {'expenses.read', 'expenses.write'}
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(page.get_by_role('region', name='Resumen de cuentas')).to_have_count(0)
            expect(page.get_by_role('button', name='Cobrar saldo pendiente', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='Usar anticipo disponible', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='Realizar cobro', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='Emitir importe a cobrar', exact=True)).to_have_count(0)
            expect(accounts_section(page)).to_contain_text('Información financiera restringida')
            fixture.mode['denied'] = set()

            # Settled money completes the checkpoint; money that was agreed and never issued
            # keeps the folio in Cuentas.
            fixture.booking.update(rental_state='Cerrado')
            fixture.document['scope_balance'] = 0
            fixture.grouped['scope_balance'] = 0
            open_folio(page, 'Cuentas')
            progress = page.get_by_role('region', name='Fases del folio')
            expect(progress.get_by_role('button', name='Cuentas: fase actual', exact=True)).to_be_visible()
            expect(accounts_section(page).get_by_test_id('reconciliation-alarm')).to_contain_text('faltan $230.00 por emitir')
            # Only the agreed amount that was really issued lets the folio move on.
            fixture.booking.update(total=120)
            open_folio(page, 'Cuentas')
            progress = page.get_by_role('region', name='Fases del folio')
            expect(progress.get_by_role('button', name='Cuentas: completado', exact=True)).to_be_visible()
            expect(progress.get_by_role('button', name='Finalizado: fase actual', exact=True)).to_be_visible()
            # Everything that was agreed was issued: there is no difference and no alarm.
            expect(accounts_section(page).get_by_test_id('reconciliation-alarm')).to_have_count(0)
            fit(page, 'cuentas')
            assert not blocked and not fixture.blocked and not errors, (blocked, fixture.blocked, errors)
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'realApiRequests': 0, 'widths': [1440, 1024, 390, 320],
              'periodAttempts': len(period_commands), 'receiptAttempts': len(receipts),
              'blocked': blocked + fixture.blocked, 'errors': errors}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
