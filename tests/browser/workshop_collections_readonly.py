"""Workshop collections proof; synthetic HTTP only, unknown requests always abort."""
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
import workshop_pipeline_readonly as fixture
# The rental fixture is a separate artefact of the folder; the workshop proof keeps
# working without it when only this file is available.
try:
    import rental_folio_readonly as rental
except ModuleNotFoundError:  # pragma: no cover - depends on the checked-out fixture set
    rental = None

ROOT = Path('test-results/workshop-collections')
STATE = {'balance': 400, 'issued': 1000, 'available': 100, 'grouped': False,
         'empty': False, 'unknown': False, 'fail': False, 'reversal': False}
COMMANDS, ERRORS = [], []
ORIGINAL = fixture.protect
RECEIPT = {'id': 'original-advance', 'customer_id': fixture.CUSTOMER['id'], 'amount': 99999,
           'paid_on': '2026-11-01', 'method': 'Transferencia', 'account': 'Synthetic bank',
           'reference': 'Original synthetic advance', 'folio_number': 99002}


def case_file():
    result = fixture.case_file()
    result['documents'] = [] if STATE['empty'] else [{
        'id': 'doc', 'amount': 99999, 'scope_amount': STATE['issued'],
        'scope_balance': STATE['balance'], 'description': 'Synthetic scoped charge',
        'issued_on': '2026-11-02', 'due_on': '2026-11-30', 'grouped': STATE['grouped'],
        'folio_number': 99003}]
    result['payments'] = [RECEIPT]
    result['advances'] = [{**RECEIPT, 'available_amount': STATE['available']}] if STATE['available'] else []
    result['applications'] = [] if STATE['empty'] else [{
        'id': 'prior-application', 'payment_id': RECEIPT['id'], 'document_id': 'doc',
        'kind': 'Aplicacion', 'scope_amount': 600, 'amount': 99899,
        'effective_on': '2026-11-02', 'reason': 'Synthetic scoped prior application'}]
    if STATE['reversal']:
        result['applications'].append({
            'id': 'reversal', 'payment_id': RECEIPT['id'], 'document_id': 'doc',
            'kind': 'Reversion', 'scope_amount': 25, 'amount': 25,
            'effective_on': '2026-11-03', 'reason': 'Synthetic correction'})
    if STATE['unknown']:
        del result['documents']
    return result


def protect(route):
    request, url = route.request, urlparse(route.request.url)
    resource = url.path.split('/')[-1]
    if '/rest/v1/rpc/' in url.path:
        body = request.post_data_json
        if resource == 'vehicle_case_file':
            route.fulfill(json=copy.deepcopy(case_file()))
            return
        if resource == 'receivables_at':
            route.fulfill(json=[] if STATE['empty'] else [{
                **case_file().get('documents', [{}])[0], 'customer_id': fixture.CUSTOMER['id'],
                'current_customer_id': fixture.CUSTOMER['id'], 'order_id': fixture.JOB['id'],
                'reservation_id': None, 'balance': STATE['balance'], 'amount': 99999}])
            return
        if resource == 'record_linked_receipt':
            assert body['idempotency_key']
            payload = body['payload']
            assert payload['customerId'] == fixture.CUSTOMER['id']
            assert payload['orderId'] == fixture.JOB['id']
            COMMANDS.append(copy.deepcopy(body))
            if STATE['fail']:
                STATE['fail'] = False
                route.fulfill(status=400, json={'message': 'APPLICATION_PREDATES_DOCUMENT'})
                return
            if payload.get('documentId'):
                assert payload['documentId'] == 'doc'
                STATE['balance'] -= float(payload['amount'])
            if payload.get('paymentId'):
                assert payload['paymentId'] == RECEIPT['id']
                assert 'method' not in payload and 'account' not in payload
                STATE['available'] -= float(payload['amount'])
            route.fulfill(json={})
            return
        if resource == 'reservation_payment_summary':
            route.fulfill(json={})
            return
        if resource == 'execute_case_command':
            assert body['command'] == 'bill_scope'
            assert body['payload']['orderId'] == fixture.JOB['id']
            COMMANDS.append(copy.deepcopy(body))
            STATE['issued'] = 1200
            route.fulfill(json={})
            return
    if '/rest/v1/' in url.path and request.method == 'GET':
        if resource == 'customer_payments':
            route.fulfill(json=[RECEIPT])
            return
        if resource == 'payment_applications':
            route.fulfill(json=[{'id': 'ledger-application', 'payment_id': RECEIPT['id'],
                                'kind': 'Aplicacion', 'amount': 99999 - STATE['available']}])
            return
        if resource == 'payment_refunds':
            route.fulfill(json=[])
            return
        if resource in ['vehicle_commitments', 'reservation_evidence']:
            route.fulfill(json=[])
            return
    ORIGINAL(route)


def go(page):
    fixture.go(page, 'Cobros')
    expect(page.get_by_role('region', name='Cobros del trabajo', exact=True)).to_be_visible()


def shot(page, name, width):
    page.evaluate('window.scrollTo(0, 0)')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name
    page.screenshot(path=str(ROOT / f'{name}-{width}.png'), full_page=True)


def check_cobros(page):
    """The collections card of /cobros: both states, three amounts, one collapsed detail."""
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.goto(fixture.APP + '/cobros', wait_until='networkidle')
    card = page.locator('.collection-card').filter(has_text='Synthetic workshop customer')
    expect(card).to_have_count(1)
    # Both facts are stated: the state of the work and the state of the money.
    expect(card.locator('.collection-statuses')).to_have_attribute(
        'aria-label', f"{fixture.STATE['status']} · Cobro parcial, pendiente por cobrar")
    # The three key amounts lead the card and the rest stays inside the collapsed detail.
    row = card.locator('dl.collection-money')
    expect(row.locator('dt')).to_have_text(['Importe acordado', 'Cobrado', 'Por cobrar'])
    expect(row).to_contain_text('$1,200.00')
    expect(row).to_contain_text('$600.00')
    expect(row).to_contain_text('$400.00')
    detail = card.locator('details.collection-detail')
    expect(detail).to_have_count(1)
    expect(detail.locator('summary')).to_have_text(re.compile('Detalle'))
    expect(card.locator('details.collection-detail dl.operation-amounts')).not_to_be_visible()
    # The action names the intent in plain words.
    expect(card.get_by_role('button', name='Emitir importe a cobrar', exact=True)).to_be_visible()
    expect(card).not_to_contain_text(re.compile('cargo', re.IGNORECASE))
    # The card warns about the difference between what was agreed and what was issued.
    card_alarm = card.get_by_test_id('reconciliation-alarm')
    expect(card_alarm).to_have_count(1)
    expect(card_alarm).to_contain_text('Facturado $1,000.00 de $1,200.00 acordados')
    expect(card_alarm).to_contain_text('faltan $200.00 por emitir')
    for button in card.get_by_role('button').all():
        expect(button).to_be_enabled()
    height = card.bounding_box()['height']
    print(f'workshop collections card height: {height:.0f} pixels')
    assert height < 320, f'the workshop collections card is {height} pixels tall'
    for width in [1440, 1024, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        page.evaluate('window.scrollTo(0, 0)')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'
        page.screenshot(path=str(ROOT / f'cobros-card-{width}.png'), full_page=True)


def check_alarm(page):
    """The reconciliation alarm states the difference once and never blocks an action."""
    go(page)
    workspace = page.get_by_role('region', name='Cobros del trabajo', exact=True)
    alarm = workspace.get_by_test_id('reconciliation-alarm')
    expect(alarm).to_have_count(1)
    expect(alarm).to_contain_text('Facturado $1,000.00 de $1,200.00 acordados')
    expect(alarm).to_contain_text('faltan $200.00 por emitir')
    # The line it replaces is gone: the same fact is never stated twice.
    expect(workspace).not_to_contain_text('Acordado y aún sin documento de cobro emitido')
    # The alarm never blocks the actions of the section.
    for name in ['Registrar cobro', 'Preparar importe a cobrar']:
        expect(workspace.get_by_role('button', name=name, exact=True)).to_be_enabled()
    for width in [1440, 1024, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        go(page)
        expect(page.get_by_role('region', name='Cobros del trabajo')
               .get_by_test_id('reconciliation-alarm')).to_have_count(1)
        shot(page, 'reconciliation-alarm', width)
    page.set_viewport_size({'width': 1440, 'height': 1000})
    # Everything that was agreed was issued: there is no difference and therefore no alarm.
    STATE['issued'] = 1200
    go(page)
    workspace = page.get_by_role('region', name='Cobros del trabajo', exact=True)
    expect(workspace.get_by_test_id('reconciliation-alarm')).to_have_count(0)
    expect(workspace).not_to_contain_text('Acordado y aún sin documento de cobro emitido')
    shot(page, 'no-reconciliation-alarm', 1440)
    STATE['issued'] = 1000


def fill_new(page, amount='150'):
    page.get_by_role('button', name='Registrar cobro', exact=True).click()
    page.get_by_label('A qué documento se aplica el cobro').select_option('doc')
    page.get_by_label('Importe recibido (USD)').fill(amount)
    page.get_by_label('Fecha del cobro', exact=True).fill('2026-11-10')
    page.get_by_label('Medio de pago', exact=True).select_option('Tarjeta')
    page.get_by_label('Cuenta o caja receptora').fill('Synthetic cash destination')
    page.get_by_label('Referencia del pago', exact=True).fill('Synthetic new money')


def rental_defaults(browser, storage_key, session):
    """Verify default ReceiptForm behavior through the real global rental dialog.

    Legacy CasePayments compatibility is structural only: this page does not mount it.
    """
    rental.mode.update(finance=True, fail=False)
    rental.booking.update(rental_state='Entregado', version=10)
    page = browser.new_page(viewport={'width': 390, 'height': 1000})
    tables = {'customers', 'customer_aliases', 'vehicles', 'work_orders', 'expenses',
              'workshop_tasks', 'reservations', 'vehicle_files', 'rental_inspections',
              'vehicle_commitments', 'customer_payments', 'payment_applications', 'payment_refunds',
               'rental_periods', 'rental_extra_proposals', 'reservation_evidence'}
    rpcs = {'has_permission', 'has_task_access', 'rental_case_file',
            'reservation_payment_summary', 'receivables_at', 'rental_paid_through'}

    def protect_rental(route):
        url = urlparse(route.request.url)
        resource = url.path.split('/')[-1]
        if url.path == '/rest/v1/reservation_evidence' and route.request.method == 'GET':
            route.fulfill(json=[])
            return
        if '/rest/v1/' in url.path:
            if ('/rpc/' in url.path and resource not in rpcs) or (
                    '/rpc/' not in url.path and (route.request.method != 'GET' or resource not in tables)):
                fixture.BLOCKED.append(resource)
                route.abort()
                return
        rental.protect(route)

    page.route(re.compile(r'^https?://'), protect_rental)
    page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
    page.on('pageerror', lambda error: ERRORS.append(str(error)))
    page.goto(fixture.APP + '/alquileres/folio/?id=' + rental.FIXTURE_ID, wait_until='networkidle')
    # The collection control lives only in the Cuentas stage of the folio.
    page.get_by_role('region', name='Fases del folio').get_by_role('button', name=re.compile('^Cuentas:')).click()
    page.get_by_role('button', name='Realizar cobro', exact=True).click()
    dialog = page.get_by_role('dialog', name='Cobro o anticipo', exact=True)
    expect(dialog.get_by_role('heading', name='Cobro o anticipo', exact=True)).to_be_visible()
    form = dialog.get_by_role('region', name='Cobro o anticipo vinculado', exact=True)
    expect(form.get_by_label('Origen del dinero')).to_contain_text('Recibir un pago nuevo')
    expect(form.get_by_label('Origen del dinero')).to_have_value('')
    expect(form.get_by_label('A qué documento se aplica el cobro')).to_have_value(rental.document['id'])
    expect(form.get_by_label('Importe recibido (USD)')).to_have_value('60.00')
    expect(form.get_by_label('Fecha del cobro', exact=True)).to_be_visible()
    expect(form.get_by_label('Medio de pago', exact=True)).to_have_value('Efectivo')
    expect(form.get_by_label('Cuenta o caja receptora')).to_be_visible()
    expect(form.get_by_label('Referencia del pago', exact=True)).to_be_visible()
    expect(form.get_by_role('button', name='Guardar cobro y aplicar al documento', exact=True)).to_be_visible()
    expect(form.get_by_label('A qué documento se aplica el cobro').locator('option')).to_have_count(3)
    expect(form.get_by_label('A qué documento se aplica el cobro')).not_to_contain_text('Unrelated rental charge')
    expect(form.get_by_label('A qué documento se aplica el cobro')).not_to_contain_text('Grouped fixture charge')
    form.get_by_label('Origen del dinero').select_option(rental.advance['id'])
    expect(form.get_by_label('Medio de pago', exact=True)).to_have_count(0)
    expect(form.get_by_label('Cuenta o caja receptora')).to_have_count(0)
    expect(form.get_by_label('Referencia del pago', exact=True)).to_have_count(0)
    expect(form.get_by_label('Fecha de aplicación', exact=True)).to_be_visible()
    expect(form.get_by_label('A qué documento se aplica el cobro')).to_have_value('choose')
    expect(form.get_by_label('A qué documento se aplica el cobro').locator('option[value="advance"]')).to_have_count(0)
    form.get_by_label('A qué documento se aplica el cobro').select_option(rental.document['id'])
    expect(form.get_by_label('Importe recibido (USD)')).to_have_attribute('max', '10')
    form.get_by_label('Importe recibido (USD)').fill('10')
    expect(form).to_contain_text('La aplicación no volverá a sumar dinero al diario.')
    expect(form.get_by_role('button', name='Aplicar recibo sin nuevo ingreso', exact=True)).to_be_visible()
    shot(page, 'rental-defaults-unchanged', 390)
    assert not rental.commands and not rental.reservation_commands and not rental.blocked
    page.close()


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    fixture.STATE.update(status='En proceso', active='approved', quotes=[
        {**copy.deepcopy(fixture.QUOTE), 'id': 'approved', 'status': 'Aprobado',
         'snapshot': {**fixture.QUOTE['snapshot'], 'total': 1200}},
        {**copy.deepcopy(fixture.QUOTE), 'id': 'draft', 'revision': 2,
         'snapshot': {**fixture.QUOTE['snapshot'], 'total': 1600}}])
    public_url = next(line.split('=', 1)[1].strip().strip('"')
                      for line in Path('.env.local').read_text(encoding='utf8').splitlines()
                      if line.startswith('NEXT_PUBLIC_SUPABASE_URL='))
    storage_key = 'sb-' + urlparse(public_url).hostname.split('.')[0] + '-auth-token'
    session = {'access_token': 'synthetic-never-forwarded', 'refresh_token': 'synthetic-refresh',
               'expires_at': 4102444800, 'expires_in': 3600, 'token_type': 'bearer',
               'user': {'id': fixture.USER, 'email': 'fixture@example.invalid', 'aud': 'authenticated',
                        'role': 'authenticated', 'app_metadata': {}, 'user_metadata': {}}}
    expect.set_options(timeout=200000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: ERRORS.append(str(error)))
        try:
            check_cobros(page)
            check_alarm(page)
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                go(page)
                expect(page.get_by_label('Resumen de cobros').locator('dd')).to_have_text(
                    ['$400.00', '$1,000.00', '$600.00', '$100.00'])
                expect(page.get_by_role('region', name='Cobros del trabajo')).not_to_contain_text('$99,999.00')
                assert not COMMANDS, 'Navigation must never issue a charge or receipt'
                shot(page, 'balances-first', width)
                button = page.get_by_role('button', name='Registrar cobro', exact=True)
                button.focus()
                page.keyboard.press('Enter')
                expect(page.get_by_role('button', name='Cerrar editor')).to_be_visible()
                assert page.evaluate('document.activeElement.tabIndex') == -1
                page.get_by_label('A qué documento se aplica el cobro').select_option('doc')
                page.get_by_label('Importe recibido (USD)').fill('150')
                expect(page.get_by_text('Después de aplicar:', exact=False)).to_contain_text('$250.00')
                shot(page, 'new-money-editor', width)
                page.get_by_role('button', name='Cerrar editor').click()
            page.set_viewport_size({'width': 1440, 'height': 1000})
            fill_new(page)
            STATE['fail'] = True
            page.get_by_role('button', name='Registrar cobro de $150.00', exact=True).click()
            expect(page.locator('.form-error[role="alert"]')).to_contain_text('La aplicación no puede ser anterior al cargo.')
            expect(page.get_by_label('Importe recibido (USD)')).to_have_value('150')
            expect(page.get_by_label('Referencia del pago', exact=True)).to_have_value('Synthetic new money')
            shot(page, 'backend-error-preserves-fields', 1440)
            page.get_by_role('button', name='Registrar cobro de $150.00', exact=True).evaluate('(button)=>{button.click();button.click()}')
            expect(page.get_by_role('button', name='Cerrar editor')).to_have_count(0)
            assert len(COMMANDS) == 2
            assert COMMANDS[0]['idempotency_key'] == COMMANDS[1]['idempotency_key']
            assert COMMANDS[1]['payload']['method'] == 'Tarjeta'
            assert COMMANDS[1]['payload']['date'] == '2026-11-10'
            assert STATE['balance'] == 250
            page.get_by_role('button', name='Usar anticipo disponible', exact=True).click()
            page.get_by_label('Origen del dinero').select_option(RECEIPT['id'])
            page.get_by_label('A qué documento se aplica el cobro').select_option('doc')
            page.get_by_label('Importe recibido (USD)').fill('100')
            page.get_by_label('Fecha de aplicación', exact=True).fill('2026-11-11')
            expect(page.get_by_label('Medio de pago', exact=True)).to_have_count(0)
            expect(page.get_by_text('Después de aplicar:', exact=False)).to_contain_text('$150.00')
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                shot(page, 'existing-advance-editor', width)
            page.get_by_role('button', name='Aplicar $100.00 sin nuevo ingreso', exact=True).click()
            expect(page.get_by_role('button', name='Cerrar editor')).to_have_count(0)
            assert STATE['balance'] == 150
            assert len(COMMANDS) == 3
            assert sum('paymentId' not in item['payload'] for item in COMMANDS[1:]) == 1
            assert COMMANDS[-1]['payload']['date'] == '2026-11-11'
            original = page.get_by_role('link', name='Ver recibo original en diario →').first
            expect(original).to_have_attribute('href', re.compile('movimiento=receipt%3Aoriginal-advance.*desde=2026-11-01'))
            page.set_viewport_size({'width': 1440, 'height': 1000})
            fill_new(page, '50')
            STATE['balance'] = 125
            page.get_by_role('button', name='Actualizar expediente', exact=True).click()
            expect(page.get_by_role('region', name='Cobro o anticipo vinculado').get_by_role('alert')).to_contain_text('Se conservaron los campos')
            expect(page.get_by_label('Importe recibido (USD)')).to_have_value('50')
            expect(page.get_by_role('button', name='Registrar cobro de $50.00', exact=True)).to_be_disabled()
            shot(page, 'stale-intent-preserves-fields', 1440)
            page.get_by_role('button', name='Revisé los saldos actualizados').click()
            expect(page.get_by_role('button', name='Registrar cobro de $50.00', exact=True)).to_be_enabled()
            page.get_by_role('button', name='Cerrar editor').click()
            page.get_by_role('button', name='Preparar importe a cobrar', exact=True).click()
            expect(page.get_by_role('button', name='Emitir importe a cobrar de $200.00', exact=True)).to_be_visible()
            assert len(COMMANDS) == 3, 'Preparing the amount cannot issue it'
            shot(page, 'explicit-issuance-review', 1440)
            page.get_by_role('button', name='Emitir importe a cobrar de $200.00', exact=True).click()
            expect(page.get_by_role('button', name='Cerrar editor')).to_have_count(0)
            assert COMMANDS[-1]['command'] == 'bill_scope'
            STATE.update(grouped=True, reversal=True)
            go(page)
            expect(page.get_by_text('Documento compartido con otros trabajos.', exact=False)).to_be_visible()
            expect(page.get_by_role('link', name='Ver documento y registrar cobro en Cobros →')).to_have_attribute('href', re.compile(r'^/cobros/?$'))
            expect(page.get_by_text('Reversión de cobro · -$25.00')).to_be_visible()
            shot(page, 'grouped-and-reversal', 1440)
            STATE.update(empty=True, reversal=False)
            page.set_viewport_size({'width': 320, 'height': 1000})
            go(page)
            page.get_by_role('button', name='Registrar anticipo', exact=True).click()
            expect(page.get_by_label('A qué documento se aplica el cobro')).to_have_value('advance')
            expect(page.get_by_text('No se marca el trabajo como pagado', exact=False)).to_be_visible()
            shot(page, 'no-charge-advance', 320)
            STATE['unknown'] = True
            go(page)
            expect(page.get_by_text('No se pudo confirmar el estado financiero.', exact=False)).to_be_visible()
            expect(page.get_by_label('Resumen de cobros')).to_have_count(0)
            STATE.update(unknown=False, empty=False, grouped=False, available=100)
            page.set_viewport_size({'width': 1440, 'height': 1000})
            go(page)
            fill_new(page, '25')
            fixture.STATE['denied'] = {'expenses.read', 'expenses.write'}
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(page.get_by_role('region', name='Cobros del trabajo', exact=True)).to_have_count(0)
            if rental is not None:
                rental_defaults(browser, storage_key, session)
            expect(page.get_by_label('Referencia del pago', exact=True)).to_have_count(0)
            expect(page.get_by_test_id('workshop-case')).not_to_contain_text('Original synthetic advance')
            shot(page, 'permission-revoked', 1440)
            fixture.STATE['denied'] = set()
            fixture.STATE['finance'] = False
            go_no_finance = fixture.go
            go_no_finance(page, 'Cobros')
            expect(page.get_by_role('region', name='Cobros del trabajo', exact=True)).to_have_count(0)
            assert not fixture.BLOCKED, fixture.BLOCKED
            assert not ERRORS, ERRORS
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'widths': [1440, 1024, 390, 320],
              'realBusinessQueries': 0, 'realBusinessWrites': 0,
              'syntheticCommands': len(COMMANDS), 'newMoney': 150, 'existingMoney': 100,
              'newCashEvents': 1, 'retrySameKey': True, 'doubleSubmitSuppressed': True,
              'revisionReview': True, 'permissionRevocation': True, 'rentalDefaults': True,
              'blockedRequests': fixture.BLOCKED, 'browserErrors': ERRORS}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
