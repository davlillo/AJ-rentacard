"""Workshop money wording proof; synthetic HTTP only, unknown requests always abort."""
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright
import workshop_pipeline_readonly as fixture

ROOT = Path('test-results/workshop-money-language')
STATE = {'approved': True, 'internal': False, 'issued': 1000}
COMMANDS, ERRORS = [], []
ORIGINAL = fixture.protect
RECEIPT = {'id': 'original-advance', 'customer_id': fixture.CUSTOMER['id'], 'amount': 99999,
           'paid_on': '2026-11-01', 'method': 'Transferencia', 'account': 'Synthetic bank',
           'reference': 'Original synthetic advance', 'folio_number': 99002}
LINE_BASE = {'description': 'Synthetic base repair', 'kind': 'Material', 'quantity': 1,
             'unitCost': 900, 'unitPrice': 1000, 'cost': 900, 'price': 1000}
LINE_ADDITIONAL = {'description': 'Synthetic approved additional', 'kind': 'Material', 'quantity': 1,
                   'unitCost': 0, 'unitPrice': 400, 'cost': 0, 'price': 400}
APPROVED = {'id': 'approved', 'order_id': fixture.JOB['id'], 'revision': 2, 'parent_id': 'initial',
            'status': 'Aprobado', 'folio_number': 99001,
            'snapshot': {'cost': 900, 'costComplete': True, 'subtotal': 1400, 'discount': 0,
                         'total': 1400, 'margin': 500, 'marginPct': 36, 'commercial': 1400,
                         'currency': 'USD', 'lines': [LINE_BASE, LINE_ADDITIONAL]},
            'customer_snapshot': fixture.CUSTOMER, 'vehicle_snapshot': fixture.VEHICLE,
            'reason': 'Synthetic approved additional', 'created_at': '2026-11-11T12:00:00Z'}


def case_file():
    result = fixture.case_file()
    result['documents'] = [{'id': 'doc', 'amount': 99999, 'scope_amount': STATE['issued'],
                             'scope_balance': 400, 'description': 'Synthetic scoped charge',
                             'issued_on': '2026-11-02', 'due_on': '2026-11-30', 'grouped': False,
                             'folio_number': 99003}]
    result['payments'] = [RECEIPT]
    result['advances'] = [{**RECEIPT, 'available_amount': 100}]
    result['applications'] = [{'id': 'prior-application', 'payment_id': RECEIPT['id'],
                               'document_id': 'doc', 'kind': 'Aplicacion', 'scope_amount': 600,
                               'amount': 99899, 'effective_on': '2026-11-02',
                               'reason': 'Synthetic scoped prior application'}]
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
            route.fulfill(json=[{**case_file()['documents'][0], 'customer_id': fixture.CUSTOMER['id'],
                                  'current_customer_id': fixture.CUSTOMER['id'],
                                  'order_id': fixture.JOB['id'], 'reservation_id': None,
                                  'balance': 400, 'amount': 99999}])
            return
        if resource == 'reservation_payment_summary':
            route.fulfill(json={})
            return
        if resource in ['record_linked_receipt', 'execute_case_command']:
            COMMANDS.append(copy.deepcopy(body))
            route.fulfill(json={})
            return
    if '/rest/v1/' in url.path and request.method == 'GET':
        if resource == 'customer_payments':
            route.fulfill(json=[RECEIPT])
            return
        if resource == 'payment_applications':
            route.fulfill(json=[{'id': 'ledger-application', 'payment_id': RECEIPT['id'],
                                 'kind': 'Aplicacion', 'amount': 99899}])
            return
        if resource == 'payment_refunds':
            route.fulfill(json=[])
            return
        if resource in ['vehicle_commitments', 'reservation_evidence']:
            route.fulfill(json=[])
            return
    ORIGINAL(route)


def go(page, section='Cobros'):
    page.goto(fixture.APP + '/taller/ingreso/?id=' + fixture.JOB['id'] + '&seccion=' + section,
              wait_until='networkidle')
    expect(page.get_by_test_id('workshop-case')).to_be_visible()


def shot(page, name, width):
    page.evaluate('window.scrollTo(0, 0)')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name
    page.screenshot(path=str(ROOT / f'{name}-{width}.png'), full_page=True)


def plain_labels(page):
    """The operator wording: no old jargon and the four receivable facts."""
    workspace = page.get_by_role('region', name='Cobros del trabajo', exact=True)
    expect(workspace).to_be_visible()
    expect(workspace).not_to_contain_text('Cargos emitidos')
    expect(workspace).not_to_contain_text('Cargos y cobros')
    expect(workspace).not_to_contain_text('Cargos y abonos')
    expect(workspace).not_to_contain_text('Emitir cargo')
    expect(workspace).not_to_contain_text('Importe emitido')
    expect(workspace).not_to_contain_text('Aplicado a este trabajo')
    summary = workspace.locator('dl[aria-label="Resumen de cobros"]')
    expect(summary.locator('dt')).to_have_text(
        ['Pendiente de cobro', 'Importe facturado al cliente', 'Cobro aplicado a este trabajo', 'Anticipo disponible'])
    expect(summary.locator('dd')).to_have_text(['$400.00', '$1,000.00', '$600.00', '$100.00'])
    expect(summary).not_to_contain_text('$0.00')
    return workspace


def alarm(scope):
    """The reconciliation alarm: one informative line about what was agreed and what was issued."""
    return scope.get_by_test_id('reconciliation-alarm')


def check_cobros(page):
    """The collections card of /cobros: both states, three amounts, one collapsed detail."""
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.goto(fixture.APP + '/cobros', wait_until='networkidle')
    card = page.locator('.collection-card').filter(has_text='Synthetic workshop customer')
    expect(card).to_have_count(1)
    # Both facts are stated: the state of the work and the state of the money.
    expect(card.locator('.collection-statuses')).to_have_attribute(
        'aria-label', 'En proceso · Cobro parcial, pendiente por cobrar')
    expect(card).to_contain_text('En proceso')
    expect(card).to_contain_text('Cobro parcial, pendiente por cobrar')
    # The three key amounts lead the card.
    row = card.locator('dl.collection-money')
    expect(row.locator('dt')).to_have_text(['Importe acordado', 'Cobrado', 'Por cobrar'])
    expect(row).to_contain_text('$1,400.00')
    expect(row).to_contain_text('$600.00')
    expect(row).to_contain_text('$400.00')
    # The secondary figures stay available inside a collapsed detail.
    detail = card.locator('details.collection-detail')
    expect(detail).to_have_count(1)
    expect(detail.locator('summary')).to_have_text(re.compile('Detalle'))
    expect(card.locator('details.collection-detail dl.operation-amounts')).not_to_be_visible()
    # The action names the intent in plain words.
    expect(card.get_by_role('button', name='Emitir importe a cobrar', exact=True)).to_be_visible()
    expect(card).not_to_contain_text(re.compile('cargo', re.IGNORECASE))
    # The card shows the difference between what was agreed and what was issued.
    card_alarm = alarm(card)
    expect(card_alarm).to_have_count(1)
    expect(card_alarm).to_contain_text('Facturado $1,000.00 de $1,400.00 acordados')
    expect(card_alarm).to_contain_text('faltan $400.00 por emitir')
    # It is informative: it never paints an error and it never blocks the action.
    expect(card_alarm).not_to_contain_text(re.compile('error|alerta|p[eé]rdida|margen', re.IGNORECASE))
    colors = card_alarm.evaluate('(node)=>{const style=getComputedStyle(node);'
                                  'return [style.backgroundColor,style.borderLeftColor,style.color]}')
    assert 'rgb(229, 43, 64)' not in colors, colors
    assert 'rgb(253, 247, 232)' in colors, colors
    expect(card.get_by_role('button', name='Emitir importe a cobrar', exact=True)).to_be_enabled()
    height = card.bounding_box()['height']
    print(f'workshop collections card height: {height:.0f} pixels')
    assert height < 320, f'the workshop collections card is {height} pixels tall'
    for width in [1440, 1024, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        page.evaluate('window.scrollTo(0, 0)')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'
        page.screenshot(path=str(ROOT / f'cobros-card-{width}.png'), full_page=True)
    page.set_viewport_size({'width': 1440, 'height': 1000})


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    fixture.STATE.update(status='En proceso', active='approved', quotes=[copy.deepcopy(APPROVED)],
                          internal=False)
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
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                go(page)
                workspace = plain_labels(page)
                agreed = page.get_by_role('region', name='Importe acordado con el cliente', exact=True)
                expect(agreed).to_be_visible()
                expect(agreed).to_contain_text('$1,400.00')
                expect(agreed).to_contain_text('Trabajo acordado con el cliente')
                expect(agreed).to_contain_text(
                    'Un adicional aprobado sube el importe acordado con el cliente y, por eso, '
                    'aumenta lo pendiente de cobro hasta que el cliente paga.')
                # The reconciliation alarm states the difference once, with the exact numbers.
                expect(alarm(workspace)).to_have_count(1)
                expect(alarm(workspace)).to_contain_text('Facturado $1,000.00 de $1,400.00 acordados')
                expect(alarm(workspace)).to_contain_text('faltan $400.00 por emitir')
                # The line it replaces is gone: the same fact is never stated twice.
                expect(workspace).not_to_contain_text('Acordado y aún sin documento de cobro emitido')
                assert not COMMANDS, 'Reading the folio must never issue or collect anything'
                shot(page, 'plain-money-labels', width)

            check_cobros(page)

            page.set_viewport_size({'width': 1440, 'height': 1000})
            go(page, 'Cargos%20y%20abonos')
            expect(page.get_by_role('region', name='Cobros del trabajo', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name=re.compile('^Cobros:'), exact=False)).to_have_attribute('aria-pressed', 'true')
            fixture.STATE.update(quotes=[], active=None)
            go(page)
            workspace = plain_labels(page)
            agreed = page.get_by_role('region', name='Importe acordado con el cliente', exact=True)
            expect(agreed).to_contain_text('Sin dato')
            expect(agreed).to_contain_text('No hay un presupuesto aprobado para este trabajo')
            expect(agreed).not_to_contain_text('$0.00')
            # Without an approved quote there is no agreed amount and therefore no alarm.
            expect(alarm(workspace)).to_have_count(0)
            shot(page, 'no-approved-estimate', 1440)

            # What was issued is exactly what was agreed: there is no difference to warn about.
            fixture.STATE.update(quotes=[copy.deepcopy(APPROVED)], active='approved', internal=False)
            STATE['issued'] = 1400
            go(page)
            workspace = page.get_by_role('region', name='Cobros del trabajo', exact=True)
            expect(workspace).to_be_visible()
            expect(alarm(workspace)).to_have_count(0)
            expect(workspace).not_to_contain_text('Acordado y aún sin documento de cobro emitido')
            shot(page, 'issued-equals-agreed', 1440)
            STATE['issued'] = 1000

            fixture.STATE.update(quotes=[copy.deepcopy(APPROVED)], active='approved', internal=True)
            go(page)
            expect(page.get_by_test_id('workshop-case')).to_contain_text(
                'Mantenimiento interno: no se genera cuenta por cobrar a AJ.')
            expect(page.get_by_role('region', name='Importe acordado con el cliente', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='Cobros', exact=True)).to_have_count(0)
            expect(page.get_by_text('Pendiente de cobro', exact=True)).to_have_count(0)
            # An internal job has no customer amount: no alarm either.
            expect(page.get_by_test_id('reconciliation-alarm')).to_have_count(0)
            shot(page, 'internal-job', 1440)

            assert not COMMANDS, COMMANDS
            assert not fixture.BLOCKED, fixture.BLOCKED
            assert not ERRORS, ERRORS
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'widths': [1440, 1024, 390, 320], 'realBusinessQueries': 0,
              'realBusinessWrites': 0, 'syntheticCommands': len(COMMANDS),
              'plainLabels': True, 'approvedAmount': '$1,400.00', 'additionalExplanation': True,
              'missingApprovedEstimate': 'Sin dato', 'internalJob': True,
              'reconciliationAlarm': 'Facturado $1,000.00 de $1,400.00 acordados · faltan $400.00 por emitir.',
              'reconciliationAlarmWithoutApprovedQuote': False,
              'reconciliationAlarmWhenIssuedEqualsAgreed': False,
              'reconciliationAlarmOnInternalJob': False,
              'blockedRequests': fixture.BLOCKED, 'browserErrors': ERRORS}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
