"""Exercise the unified workshop cost entry and the collections emphasis with
synthetic HTTP only. Unknown business requests abort and no real API, database
or business write is ever performed."""
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlparse, quote

from playwright.sync_api import expect, sync_playwright

APP = 'http://127.0.0.1:3030'
ROOT = Path('test-results/workshop-cost-entry')
USER = '00000000-0000-4000-8000-000000009901'
CUSTOMER = {'id': 'synthetic-customer', 'name': 'Synthetic workshop customer', 'phone': '',
            'email': '', 'document': '', 'type': 'Personal', 'version': 1}
VEHICLE = {'id': 'synthetic-vehicle', 'plate': 'SYNTHETIC-ONLY', 'brand': 'Toyota', 'model': 'Corolla',
           'km': 12000, 'year': 2026, 'color': 'Blanco', 'version': 1, 'status': 'En taller',
           'in_rental_fleet': False, 'inRentalFleet': False, 'daily': 45, 'ownership': 'Cliente',
           'category': 'Sedán', 'registered_holder': 'Synthetic holder', 'commercial_line': 'Sedán'}
JOB = {'id': 'OT-99001', 'service': 'Synthetic diagnosis', 'status': 'Diagnóstico',
       'internal_job': False, 'internalJob': False, 'vehicle_id': VEHICLE['id'], 'vehicleId': VEHICLE['id'],
       'customer_id': CUSTOMER['id'], 'customerId': CUSTOMER['id'], 'occurred_at': '2026-11-10T12:00:00Z',
       'created_at': '2026-11-09T12:00:00Z', 'pending_fields': [], 'active_estimate_id': None,
       'area': 'Mecánica', 'hours': 1, 'estimate': 0, 'paid': 0, 'due': '2026-11-16',
       'technician': '', 'version': 7}
QUOTE = {'id': 'synthetic-quote', 'order_id': JOB['id'], 'revision': 1, 'parent_id': None,
         'status': 'Aprobado', 'folio_number': 99001, 'snapshot': {
             'cost': 40, 'costComplete': True, 'subtotal': 100, 'discount': 0, 'total': 100,
             'margin': 60, 'marginPct': 60, 'commercial': 100, 'currency': 'USD',
             'lines': [{'description': 'Synthetic replacement', 'kind': 'Material', 'quantity': 2,
                        'unitCost': 20, 'unitPrice': 50, 'cost': 40, 'price': 100}]},
         'customer_snapshot': CUSTOMER, 'vehicle_snapshot': VEHICLE, 'reason': 'Synthetic scope',
         'created_at': '2026-11-10T12:00:00Z'}
COST = {'id': 'synthetic-cost', 'order_id': JOB['id'], 'kind': 'Compra directa',
        'description': 'Synthetic acquired part', 'quantity': 1, 'unit_cost': 30, 'amount': 30,
        'expense_id': None, 'supplier': 'Synthetic supplier', 'source_reference': 'FIXTURE-ONLY',
        'disposition': 'Pendiente', 'estimate_id': None, 'version': 3, 'reason': '',
        'occurred_at': '2026-11-10', 'created_at': '2026-11-10T12:00:00Z', 'created_by': USER}
PAYMENT_ROW = {'id': 'synthetic-payment', 'date': '2026-11-10', 'concept': 'Pago de compra',
               'amount': 10, 'scope_amount': 10, 'shared': False, 'account': 'Caja', 'support': '',
               'direct_purchase_cost_id': COST['id']}
FILES = [{'id': 'private', 'vehicle_id': VEHICLE['id'], 'order_id': JOB['id'], 'reservation_id': None,
          'name': 'PRIVATE-FINANCIAL-MARKER.pdf', 'mime': 'application/pdf', 'purpose': 'Soporte',
          'financial': True, 'size': 10, 'created_at': '2026-11-10T12:00:00Z'},
         {'id': 'public', 'vehicle_id': VEHICLE['id'], 'order_id': JOB['id'], 'reservation_id': None,
          'name': 'Synthetic inspection.pdf', 'mime': 'application/pdf', 'purpose': 'Ingreso',
          'financial': False, 'size': 10, 'created_at': '2026-11-10T12:00:00Z'}]
STATE = {'denied': set(), 'finance': True, 'quotes': [copy.deepcopy(QUOTE)], 'pay_fails': False,
         'purchase_fails': False, 'status': 'Diagnóstico'}
BLOCKED, ERRORS, COMMANDS = [], [], []


def order():
    return {**JOB, 'status': STATE['status']}


def purchased_cost(payload):
    amount = round(float(payload['quantity']) * float(payload['unitCost']), 2)
    return {'id': 'synthetic-cost-new', 'order_id': payload['orderId'], 'kind': 'Compra directa',
            'description': payload['description'], 'quantity': float(payload['quantity']),
            'unit_cost': float(payload['unitCost']), 'amount': amount, 'expense_id': None,
            'linked_expense_id': None, 'supplier': payload['supplier'],
            'source_reference': payload['sourceReference'], 'disposition': 'Pendiente',
            'estimate_id': None, 'version': 1, 'reason': payload.get('reason', ''),
            'occurred_at': payload['date'], 'created_at': '2026-11-10T12:00:00Z', 'created_by': USER}


def case_file():
    return {'vehicle': VEHICLE, 'financialAccess': STATE['finance'], 'orders': [order()],
            'reservations': [], 'commitments': [], 'files': FILES, 'quotes': STATE['quotes'],
            'inspections': [], 'costs': [COST], 'allocations': [],
            'expenses': [{'id': 'expense', 'amount': 99999, 'scope_amount': 15, 'shared': True,
                          'date': '2026-11-10', 'concept': 'Synthetic scoped expense', 'account': 'Cash',
                          'support': '', 'direct_purchase_cost_id': None}, copy.deepcopy(PAYMENT_ROW)],
            'documents': [{'id': 'doc', 'amount': 99999, 'scope_amount': 100, 'scope_balance': 70,
                           'description': 'Synthetic grouped document', 'grouped': True,
                           'issued_on': '2026-11-10', 'due_on': '2026-11-30'},
                          {'id': 'doc2', 'amount': 99999, 'scope_amount': 30, 'scope_balance': 30,
                           'description': 'Synthetic job document', 'grouped': False,
                           'issued_on': '2026-11-10', 'due_on': '2026-11-30'}],
            'applications': [{'id': 'application', 'payment_id': 'receipt', 'document_id': 'doc',
                              'kind': 'Aplicacion', 'scope_amount': 30, 'amount': 99999,
                              'effective_on': '2026-11-10', 'reason': 'Synthetic scoped collection'}],
            'payments': [{'id': 'receipt', 'paid_on': '2026-11-10', 'amount': 99999}],
            'advances': [{'id': 'advance', 'amount': 99999, 'available_amount': 7,
                          'paid_on': '2026-11-10', 'reference': 'Synthetic advance'}]}


def protect(route):
    request, url = route.request, urlparse(route.request.url)
    if url.hostname == '127.0.0.1' and url.port == 3030 and not url.path.startswith('/api/'):
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
    if '/auth/v1/' in url.path:
        if resource == 'user':
            route.fulfill(json={'user': {'id': USER, 'email': 'fixture@example.invalid'}})
            return
    elif '/rest/v1/rpc/' in url.path:
        body = request.post_data_json
        if resource in ['has_permission', 'has_task_access']:
            route.fulfill(json=body.get('permission', 'tasks.read') not in STATE['denied'])
            return
        if resource == 'vehicle_case_file':
            route.fulfill(json=copy.deepcopy(case_file()))
            return
        if resource in ['workshop_assignees', 'receivables_at', 'workshop_expense_inbox']:
            route.fulfill(json=[])
            return
        if resource == 'workshop_delivery_checklist':
            route.fulfill(json={'orderId': JOB['id'], 'version': 7, 'status': STATE['status'],
                                'pendingFields': [], 'costs': [COST], 'pendingCosts': 1,
                                'openTasks': [], 'openTimers': [], 'pendingEstimate': None,
                                'approvedEstimateId': None, 'estimatedUnpaid': 70,
                                'balancePolicy': 'Synthetic fixture'})
            return
        if resource == 'execute_cost_command':
            assert body['command'] == 'purchase', body
            assert body['idempotency_key'], body
            COMMANDS.append({'command': 'purchase', 'payload': body['payload'],
                             'key': body['idempotency_key']})
            if STATE['purchase_fails']:
                route.fulfill(status=400, json={'code': '42000', 'message': 'SYNTHETIC_PURCHASE_FAILURE'})
                return
            route.fulfill(json=purchased_cost(body['payload']))
            return
        if resource == 'pay_direct_purchase':
            COMMANDS.append({'command': 'pay', 'costId': body['cost_id'], 'payload': body['payload'],
                             'key': body['idempotency_key']})
            if STATE['pay_fails']:
                route.fulfill(status=400, json={'code': '42000', 'message': 'SYNTHETIC_PAYMENT_FAILURE'})
                return
            route.fulfill(json={'id': 'synthetic-paid', 'direct_purchase_cost_id': body['cost_id'],
                                'amount': float(body['payload']['amount']), 'date': body['payload']['date']})
            return
        if resource == 'record_linked_expense':
            COMMANDS.append({'command': 'linked-expense', 'payload': body['payload'],
                             'key': body['idempotency_key']})
            route.fulfill(json={'id': 'synthetic-expense', 'amount': body['payload']['amount']})
            return
    elif '/rest/v1/' in url.path and request.method == 'GET':
        records = {'customers': [CUSTOMER], 'customer_aliases': [], 'vehicles': [VEHICLE],
                   'work_orders': [order()], 'expenses': [], 'workshop_tasks': [], 'reservations': [],
                   'vehicle_files': [], 'workshop_costs': [COST], 'workshop_tariffs': [],
                   'estimate_versions': STATE['quotes'], 'estimate_approvals': [], 'workshop_deliveries': [],
                   'customer_payments': [], 'payment_applications': [], 'payment_refunds': [],
                   'expense_origin_links': [], 'task_timers': [], 'task_time_spans': []}
        if resource in records:
            route.fulfill(json=copy.deepcopy(records[resource]))
            return
    BLOCKED.append(resource)
    route.abort()


def go(page, section='Costos'):
    page.goto(APP + '/taller/ingreso/?id=' + JOB['id'] + '&seccion=' + quote(section),
              wait_until='networkidle')
    expect(page.get_by_test_id('workshop-case')).to_be_visible()


def screenshot(page, name, width):
    page.evaluate('window.scrollTo(0, 0)')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name
    page.screenshot(path=str(ROOT / f'{name}-{width}.png'), full_page=True)


def commands(name):
    return [command for command in COMMANDS if command['command'] == name]


def open_entry(page):
    page.get_by_role('button', name='Registrar costo', exact=True).click()
    entry = page.get_by_role('region', name='Registrar costo', exact=True)
    expect(entry).to_be_visible()
    expect(entry.get_by_role('heading', name='¿Cuánto pagaste?', exact=True)).to_be_visible()
    return entry


def fill_cost(page, description='Synthetic part'):
    page.get_by_label('Repuesto o servicio adquirido', exact=True).fill(description)
    page.get_by_label('Cantidad adquirida', exact=True).fill('2')
    page.get_by_label('Costo unitario real (USD)', exact=True).fill('25.50')
    page.get_by_label('Proveedor de compra', exact=True).fill('Synthetic supplier')
    page.get_by_label('Referencia de factura y línea', exact=True).fill('SYNTHETIC-REF')


def entry_flows(page, width):
    """The single entry with its three answers and the canonical commands."""
    go(page)
    COMMANDS.clear()
    entry = open_entry(page)
    # One obvious entry: the three answers, and no mechanism buttons.
    expect(entry.get_by_role('button', name='Todo', exact=True)).to_be_visible()
    expect(entry.get_by_role('button', name='Una parte', exact=True)).to_be_visible()
    expect(entry.get_by_role('button', name='Nada todavía (queda pendiente con el proveedor)',
                             exact=True)).to_be_visible()
    expect(entry.get_by_role('button', name='Gasto pagado', exact=True)).to_have_count(0)
    expect(entry.get_by_role('button', name='Compra directa', exact=True)).to_have_count(0)
    expect(entry.get_by_role('button', name='Vincular gasto existente', exact=True)).to_be_visible()
    screenshot(page, 'entry-three-answers', width)

    # Credit purchase: the cost is acquired and the supplier payment stays pending.
    COMMANDS.clear()
    entry.get_by_role('button', name='Nada todavía (queda pendiente con el proveedor)',
                      exact=True).click()
    fill_cost(page, 'Synthetic credit part')
    page.get_by_role('button', name='Guardar costo de compra', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='pendiente')).to_be_visible()
    assert len(commands('purchase')) == 1, COMMANDS
    assert not commands('pay'), COMMANDS
    assert commands('purchase')[0]['payload']['description'] == 'Synthetic credit part'
    assert 'disposition' not in commands('purchase')[0]['payload']
    # The later supplier payment action is preserved for the credit state.
    expect(page.get_by_text('Registrar pago al proveedor', exact=True).first).to_be_visible()
    page.wait_for_timeout(300)
    screenshot(page, 'credit-pending-supplier', width)

    # Paid in part: purchase plus a first supplier payment with the right amount.
    COMMANDS.clear()
    STATE['pay_fails'] = True
    entry = open_entry(page)
    entry.get_by_role('button', name='Una parte', exact=True).click()
    fill_cost(page, 'Synthetic partial part')
    page.get_by_label('Importe pagado ahora (USD)', exact=True).fill('12.50')
    page.get_by_label('Cuenta o caja del pago', exact=True).fill('Caja')
    page.get_by_role('button', name='Guardar costo y primer pago', exact=True).click()
    expect(page.get_by_role('alert').first).to_be_visible()
    pending = page.get_by_role('region', name='Registrar costo', exact=True)
    expect(pending).to_contain_text('Pendiente con el proveedor')
    expect(pending).to_contain_text('$38.50')
    assert len(commands('purchase')) == 1, COMMANDS
    assert len(commands('pay')) == 1, COMMANDS
    assert commands('pay')[0]['payload']['amount'] == '12.50'
    assert commands('pay')[0]['costId'] == 'synthetic-cost-new'
    screenshot(page, 'partial-payment-failed', width)

    # The retry pays only the payment, with the same identity and no second cost.
    STATE['pay_fails'] = False
    pending.get_by_role('button', name='Reintentar solo el pago al proveedor',
                        exact=True).click()
    expect(page.get_by_role('status').filter(has_text='Pago al proveedor confirmado')).to_be_visible()
    assert len(commands('purchase')) == 1, COMMANDS

    # Paid in full: the shared expense dialog records one cash outflow.
    COMMANDS.clear()
    entry = open_entry(page)
    entry.get_by_role('button', name='Todo', exact=True).click()
    entry.get_by_role('button', name='Registrar el gasto pagado', exact=True).click()
    dialog = page.get_by_role('dialog')
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role('heading', name='Registrar gasto', exact=True)).to_be_visible()
    dialog.get_by_label('Concepto', exact=True).fill('Synthetic paid expense')
    dialog.get_by_label('Importe (USD)', exact=True).fill('30.00')
    dialog.get_by_label('Categoría', exact=True).fill('Repuestos')
    dialog.get_by_label('Cuenta o caja', exact=True).fill('Caja')
    screenshot(page, 'paid-in-full-dialog', width)
    dialog.get_by_role('button', name='Guardar registro', exact=True).click()
    page.wait_for_timeout(800)
    assert len(commands('linked-expense')) == 1, COMMANDS
    assert not commands('purchase'), COMMANDS
    assert not commands('pay'), COMMANDS
    allocation = commands('linked-expense')[0]['payload']['allocations'][0]
    assert allocation['orderId'] == JOB['id'], allocation

    # A failed purchase never attempts a payment.
    COMMANDS.clear()
    STATE['purchase_fails'] = True
    entry = open_entry(page)
    entry.get_by_role('button', name='Una parte', exact=True).click()
    fill_cost(page, 'Synthetic failing purchase')
    page.get_by_label('Importe pagado ahora (USD)', exact=True).fill('5.00')
    page.get_by_label('Cuenta o caja del pago', exact=True).fill('Caja')
    page.get_by_role('button', name='Guardar costo y primer pago', exact=True).click()
    expect(page.get_by_role('alert').first).to_be_visible()
    assert len(commands('purchase')) == 1, COMMANDS
    assert not commands('pay'), COMMANDS
    STATE['purchase_fails'] = False

    # Keyboard: the answers are reachable and the error is preserved.
    entry = page.get_by_role('region', name='Registrar costo', exact=True)
    expect(entry).to_be_visible()
    expect(page.get_by_role('alert').first).to_be_visible()
    entry.get_by_role('button', name='Una parte', exact=True).focus()
    page.keyboard.press('Enter')
    expect(entry.get_by_role('button', name='Una parte', exact=True)).to_have_attribute('aria-pressed', 'true')
    expect(entry.get_by_label('Importe pagado ahora (USD)', exact=True)).to_be_visible()
    expect(page.get_by_role('alert').first).to_be_visible()
    screenshot(page, 'entry-error-preserved', width)


def collections_flow(page, width):
    """The customer receivable leads and the supplier credit stays apart."""
    go(page, 'Cobros')
    workspace = page.get_by_role('region', name='Cobros del trabajo', exact=True)
    expect(workspace).to_be_visible()
    summary = workspace.locator('dl[aria-label="Resumen de cobros"]')
    expect(summary).to_contain_text('Pendiente de cobro')
    expect(summary).to_contain_text('$100.00')
    supplier = workspace.get_by_role('region', name='Pendiente con el proveedor', exact=True)
    expect(supplier).to_be_visible()
    expect(supplier).to_contain_text('$20.00')
    expect(supplier).to_contain_text('No es lo que el cliente debe')
    expect(supplier).not_to_contain_text('Pendiente de cobro')
    order_dom = page.evaluate(
        "() => { const a=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Pendiente de cobro');"
        " const b=[...document.querySelectorAll('*')].find(e=>e.getAttribute('aria-label')==='Pendiente con el proveedor');"
        " return a && b ? (a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after') : 'missing'; }")
    assert order_dom == 'before', order_dom
    workspace.get_by_role('button', name='Registrar cobro', exact=True).click()
    expect(workspace.get_by_role('heading', name='Registrar dinero recibido', exact=True)).to_be_visible()
    screenshot(page, 'collections-emphasis', width)


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
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                entry_flows(page, width)
                collections_flow(page, width)

            # Permission revocation hides the money.
            page.set_viewport_size({'width': 1440, 'height': 1000})
            STATE['denied'] = {'expenses.read', 'expenses.write'}
            go(page, 'Cobros')
            expect(page.get_by_test_id('workshop-case')).to_contain_text('Información financiera restringida')
            expect(page.get_by_test_id('workshop-case')).not_to_contain_text('$100.00')
            expect(page.get_by_test_id('workshop-case')).not_to_contain_text('$20.00')
            go(page, 'Costos')
            expect(page.get_by_test_id('workshop-case')).to_contain_text('Información financiera restringida')
            expect(page.get_by_role('button', name='Registrar costo', exact=True)).to_have_count(0)
            screenshot(page, 'permission-revoked', 1440)
            STATE['denied'] = set()
            assert not BLOCKED, BLOCKED
            assert not ERRORS, ERRORS
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'widths': [1440, 1024, 390, 320], 'realApiRequests': 0,
              'realBusinessWrites': 0, 'answers': 3, 'creditIssuesNoCash': True,
              'partialPaymentIssuesOneCashOutflow': True, 'partialFailureKeepsCostAndPending': True,
              'retryOnlyPaymentSameIdentity': True, 'paidInFullUsesSharedExpenseDialog': True,
              'collectionsKeepsCustomerReceivableFirst': True, 'supplierCreditApart': True,
              'permissionRevocationHidesMoney': True, 'blockedRequests': BLOCKED, 'browserErrors': ERRORS}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
