"""Exercise workshop order UI through synthetic HTTP only; unknown business requests abort."""
import copy
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse, quote

from playwright.sync_api import expect, sync_playwright

APP = os.environ.get('AJ_APP', 'http://127.0.0.1:3030')
ROOT = Path(os.environ.get('AJ_RESULTS', 'test-results/workshop-pipeline'))
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
LINE = {'description': 'Synthetic replacement', 'kind': 'Material', 'quantity': 2, 'unitCost': 20,
        'unitPrice': 50, 'cost': 40, 'price': 100}
QUOTE = {'id': 'synthetic-quote', 'order_id': JOB['id'], 'revision': 1, 'parent_id': None,
         'status': 'Borrador', 'folio_number': 99001, 'snapshot': {
             'cost': 40, 'costComplete': True, 'subtotal': 100, 'discount': 0, 'total': 100,
             'margin': 60, 'marginPct': 60, 'commercial': 100, 'currency': 'USD', 'lines': [LINE]},
         'customer_snapshot': CUSTOMER, 'vehicle_snapshot': VEHICLE, 'reason': 'Synthetic scope',
         'created_at': '2026-11-10T12:00:00Z'}
COST = {'id': 'synthetic-cost', 'order_id': JOB['id'], 'kind': 'Compra directa',
        'description': 'Synthetic acquired part', 'quantity': 1, 'unit_cost': 30, 'amount': 30,
        'expense_id': None, 'supplier': 'Synthetic supplier', 'source_reference': 'FIXTURE-ONLY',
        'disposition': 'Pendiente', 'estimate_id': None, 'version': 3, 'reason': '',
        'occurred_at': '2026-11-10', 'created_at': '2026-11-10T12:00:00Z', 'created_by': USER}
FILES = [{'id': 'private', 'vehicle_id': VEHICLE['id'], 'order_id': JOB['id'], 'reservation_id': None,
          'name': 'PRIVATE-FINANCIAL-MARKER.pdf', 'mime': 'application/pdf', 'purpose': 'Soporte',
          'financial': True, 'size': 10, 'created_at': '2026-11-10T12:00:00Z'},
         {'id': 'public', 'vehicle_id': VEHICLE['id'], 'order_id': JOB['id'], 'reservation_id': None,
          'name': 'Synthetic inspection.pdf', 'mime': 'application/pdf', 'purpose': 'Ingreso',
          'financial': False, 'size': 10, 'created_at': '2026-11-10T12:00:00Z'}]
STATE = {'denied': set(), 'finance': True, 'quotes': [], 'internal': False, 'status': 'Diagnóstico',
         'active': None, 'open_timer': True, 'settled': False, 'unbilled': False, 'pending_cost': True}
BLOCKED, ERRORS, COMMANDS, BILLING = [], [], [], []


def order():
    return {**JOB, 'status': STATE['status'], 'internal_job': STATE['internal'],
            'internalJob': STATE['internal'], 'active_estimate_id': STATE['active']}


def case_file():
    result = {'vehicle': VEHICLE, 'financialAccess': STATE['finance'], 'orders': [order()],
            'reservations': [], 'commitments': [], 'files': FILES, 'quotes': STATE['quotes'],
            'inspections': [{'id': 'inspection', 'order_id': JOB['id'], 'km': 12000, 'fuel': 80,
                             'condition': 'Synthetic stored diagnosis', 'accessories': 'Keys',
                             'created_at': '2026-11-10T12:00:00Z'}],
            'costs': [COST], 'allocations': [],
            'expenses': [{'id': 'expense', 'amount': 99999, 'scope_amount': 15, 'shared': True,
                          'date': '2026-11-10', 'concept': 'Synthetic scoped expense', 'account': 'Cash'}],
            'documents': [{'id': 'doc', 'amount': 99999, 'scope_amount': 100, 'scope_balance': 0 if STATE['settled'] else 70,
                           'description': 'Synthetic grouped document', 'grouped': True,
                           'issued_on': '2026-11-10', 'due_on': '2026-11-30'}],
            'applications': [{'id': 'application', 'payment_id': 'receipt', 'document_id': 'doc',
                              'kind': 'Aplicacion', 'scope_amount': 100 if STATE['settled'] else 30, 'amount': 99999,
                              'effective_on': '2026-11-10', 'reason': 'Synthetic scoped collection'}],
            'payments': [{'id': 'receipt', 'paid_on': '2026-11-10', 'amount': 99999}],
            'advances': [{'id': 'advance', 'amount': 99999, 'available_amount': 7,
                          'paid_on': '2026-11-10', 'reference': 'Synthetic advance'}]}
    if STATE['unbilled']:
        # A freshly approved scope with nothing issued yet: the only document the
        # operator could emit is the one the approval stage offers.
        result['documents'] = []
        result['applications'] = []
    return result


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
                               'pendingFields': [], 'costs': [COST] if STATE['pending_cost'] else [],
                               'pendingCosts': 1 if STATE['pending_cost'] else 0,
                               'openTasks': [{'id': 'pending', 'description': 'Synthetic pending task'}],
                               'openTimers': [{'id': 'timer'}] if STATE['open_timer'] else [],
                               'pendingEstimate': None, 'approvedEstimateId': STATE['active'],
                               'estimatedUnpaid': 70, 'balancePolicy': 'Synthetic fixture'})
            return
        if resource == 'execute_case_command':
            assert body['command'] == 'bill_scope'
            assert body['payload']['orderId'] == JOB['id']
            assert body['payload']['date'] and body['payload']['dueOn']
            assert body['idempotency_key']
            BILLING.append(copy.deepcopy(body))
            STATE['unbilled'] = False
            route.fulfill(json={})
            return
        if resource == 'execute_estimate_command':
            assert body['command'] in ['approve', 'reject']
            assert body['payload']['estimateId'] == STATE['quotes'][-1]['id']
            assert body['payload']['evidence'] and body['idempotency_key']
            COMMANDS.append(body)
            STATE['quotes'][-1]['status'] = 'Aprobado' if body['command'] == 'approve' else 'Rechazado'
            if body['command'] == 'approve':
                STATE['active'] = STATE['quotes'][-1]['id']
            route.fulfill(json={})
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


def go(page, section='Resumen'):
    page.goto(APP + '/taller/ingreso/?id=' + JOB['id'] + '&seccion=' + quote(section),
              wait_until='networkidle')
    expect(page.get_by_test_id('workshop-case')).to_be_visible()


def tab(page, name):
    # The circles are the only navigation of the workshop folio.
    return page.get_by_role('region', name='Fases del trabajo').get_by_role('button', name=name)


def screenshot(page, name, width):
    page.evaluate('window.scrollTo(0, 0)')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name
    page.screenshot(path=str(ROOT / f'{name}-{width}.png'), full_page=True)


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
            go(page, 'Recepción')
            expect(page.get_by_role('heading', name='Inspección de ingreso')).to_be_visible()
            expect(page.get_by_text('Synthetic stored diagnosis')).to_be_visible()
            assert not COMMANDS
            STATE['status'] = 'Presupuesto'
            go(page)
            expect(page.get_by_role('region', name='Fases del trabajo')).to_contain_text('Recepción física pendiente')
            STATE['status'] = 'Diagnóstico'
            STATE['quotes'] = [copy.deepcopy(QUOTE)]
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                go(page)
                expect(page.get_by_role('region', name='Fases del trabajo').locator('li')).to_have_count(7)
                values = page.locator('[aria-label="Importes de este trabajo"] dd')
                expect(values).to_have_text(['$100.00', '$100.00', '$30.00', '$70.00'])
                expect(page.get_by_test_id('workshop-case')).not_to_contain_text('$99,999.00')
                screenshot(page, 'customer-summary', width)
                go(page, 'Presupuestos')
                expect(page.get_by_role('button', name='Editar el presupuesto del trabajo', exact=True)).to_be_visible()
                expect(page.get_by_test_id('workshop-case')).to_contain_text('Versión 1')
                screenshot(page, 'budget-pending', width)
                go(page, 'Aprobación')
                expect(page.get_by_role('button', name='Descargar imagen para el cliente')).to_be_visible()
                go(page, 'Costos')
                expect(page.get_by_role('button', name=re.compile('Synthetic acquired part')).first).to_be_visible()
                page.get_by_role('button', name=re.compile('Synthetic acquired part')).first.click()
                # A pending cost shows its classification question on the card
                # surface, without opening any collapsed detail.
                expect(page.get_by_test_id('workshop-case')).to_contain_text('Pendiente de clasificar')
                expect(page.get_by_test_id('workshop-case')).to_contain_text('¿Este costo está incluido en el presupuesto?')
                expect(page.get_by_role('button', name='Guardar relación con el presupuesto')).to_be_visible()
                collection = page.get_by_role('button', name=re.compile('^Registrar (cobro|anticipo)$')).first
                expect(collection).to_be_visible()
                brand = collection.evaluate('(b)=>getComputedStyle(b).backgroundColor')
                assert brand != 'rgba(0, 0, 0, 0)', brand
                costs_button = page.get_by_role('button', name='Registrar costo', exact=True)
                assert costs_button.evaluate('(b)=>getComputedStyle(b).backgroundColor') != brand
                # The history of the collections is a finished disclosure, not a raw arrow.
                history = page.locator('main button[aria-expanded]').filter(has_text='Documentos y movimientos')
                expect(history).to_have_count(1)
                expect(history).to_have_attribute('aria-expanded', 'true')
                expect(page.get_by_role('heading', name='Documentos de este trabajo', exact=True)).to_be_visible()
                screenshot(page, 'actual-costs', width)
                go(page, 'Salida')
                expect(page.get_by_role('button', name='Confirmar entrega revisada')).to_be_disabled()
                expect(page.get_by_text('Cronómetros abiertos:')).to_contain_text('1')
                # The delivery stage names every blocker instead of a generic count.
                expect(page.get_by_test_id('workshop-case')).to_contain_text('Synthetic acquired part')
                expect(page.get_by_test_id('workshop-case')).to_contain_text('clasificar en')
                expect(page.get_by_role('link', name='Costos del trabajo')).to_be_visible()
                tasks = page.get_by_role('region', name='Tareas abiertas de este trabajo')
                expect(tasks).to_contain_text('Synthetic pending task')
                expect(tasks).to_contain_text('Las tareas abiertas no impiden entregar. Puede cerrarlas después.')
                expect(tasks.get_by_role('link', name=re.compile('revisar en Tareas'))).to_be_visible()
                assert tasks.evaluate("(s) => s.className.includes('form-error')") is False
                assert tasks.evaluate("(s) => s.className.includes('inline-note')") is True
                screenshot(page, 'delivery-review', width)
                # An open task is optional follow-up: with the money settled and no open
                # timer the delivery stays available and the task block stays informational.
                STATE['open_timer'] = False
                STATE['pending_cost'] = False
                go(page, 'Salida')
                expect(page.get_by_role('button', name='Confirmar entrega revisada')).to_be_enabled()
                tasks = page.get_by_role('region', name='Tareas abiertas de este trabajo')
                expect(tasks).to_contain_text('Las tareas abiertas no impiden entregar. Puede cerrarlas después.')
                expect(tasks).to_contain_text('Synthetic pending task')
                assert tasks.evaluate("(s) => s.className.includes('form-error')") is False
                expect(page.get_by_test_id('workshop-case')).not_to_contain_text('Costos sin clasificar: 1')
                screenshot(page, 'delivery-tasks-optional', width)
                STATE['open_timer'] = True
                STATE['pending_cost'] = True
            page.set_viewport_size({'width': 1440, 'height': 1000})
            # The budget is editable in the folio: the editor mounts inline, with the
            # same fields and the same save, and closing it never navigates away.
            go(page, 'Presupuestos')
            budgetAction = page.get_by_role('button', name='Editar el presupuesto del trabajo', exact=True)
            expect(budgetAction).to_be_visible()
            stageBrand = budgetAction.evaluate('(b)=>getComputedStyle(b).backgroundColor')
            stageReds = page.evaluate(
                "(brand) => [...document.querySelectorAll('main button')].filter(b => getComputedStyle(b).backgroundColor === brand).length", stageBrand)
            assert stageReds == 1, stageReds
            budgetAction.click()
            expect(page.locator('.budget-line').first).to_be_visible()
            expect(page.get_by_label('Costo unitario 1', exact=True)).to_have_value('20')
            submit = page.locator('.budget-actions button').filter(has_text='Definir precio')
            expect(submit).to_be_visible()
            assert '/taller/ingreso/' in page.url, 'the editor must stay inside the folio'
            brand = submit.evaluate('(b)=>getComputedStyle(b).backgroundColor')
            assert brand != 'rgba(0, 0, 0, 0)', brand
            # The commit row keeps exactly one primary: the save is the only brand-red action.
            red = page.evaluate(
                "(brand) => [...document.querySelectorAll('.budget-actions button')].filter(b => getComputedStyle(b).backgroundColor === brand).map(b => b.textContent.trim())", brand)
            assert red == ['Definir precio al cliente →'], red
            screenshot(page, 'budget-editor-inline', 1440)
            page.get_by_role('button', name='Cancelar', exact=True).click()
            expect(page.locator('.budget-line')).to_have_count(0)
            assert not COMMANDS
            go(page, 'Aprobación')
            page.get_by_text('Registrar aprobación o rechazo', exact=True).click()
            page.get_by_label('Quién autoriza').fill('Synthetic approver')
            page.get_by_label('Acuerdo con el cliente (escrito o mensaje)').fill('Synthetic approval evidence')
            page.get_by_role('button', name='Guardar decisión', exact=True).click()
            expect(page.get_by_role('region', name='Fases del trabajo')).to_contain_text('Trabajo acordado y vigente')
            # A successful action moves the folio by itself to the stage that now applies.
            expect(page.locator('main p[role="status"]').filter(has_text='Avanzó a:')).to_have_text('Avanzó a: Cobros')
            expect(page.get_by_role('heading', name='Cobros de este trabajo', exact=True)).to_be_visible()
            assert len(COMMANDS) == 1
            screenshot(page, 'approved-work-guidance', 1440)
            # The circles still navigate by hand, and a manual pick clears the polite notice.
            tab(page, 'Aprobación').click()
            expect(page.get_by_role('heading', name='Aprobación del cliente', exact=True)).to_be_visible()
            expect(page.locator('main p[role="status"]').filter(has_text='Avanzó a:')).to_have_count(0)
            # After the approval decision the stage itself offers the issuance: the
            # operator sees the next money action without navigating to Cobros.
            STATE['unbilled'] = True
            go(page, 'Aprobación')
            card = page.locator('section[aria-label="Emitir importe a cobrar"]')
            expect(card).to_be_visible()
            expect(card).to_contain_text('Trabajo acordado aprobado: $100.00')
            expect(card).to_contain_text('No recibe dinero ni cambia el costo.')
            issue = card.get_by_role('button', name='Emitir importe a cobrar de $100.00', exact=True)
            expect(issue).to_be_visible()
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                screenshot(page, 'issue-after-approval', width)
            page.set_viewport_size({'width': 1440, 'height': 1000})
            issue.click()
            expect(card).to_contain_text('El alcance aprobado ya tiene su documento de cobro emitido')
            assert len(BILLING) == 1, 'the approval card issues exactly the existing bill_scope command'
            assert BILLING[0]['payload']['orderId'] == JOB['id']
            screenshot(page, 'issue-after-approval-issued', 1440)
            assert STATE['unbilled'] is False
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                STATE['settled'] = False
                go(page)
                flow = page.get_by_role('region', name='Fases del trabajo')
                expect(flow.locator('li')).to_have_count(7)
                expect(flow.get_by_role('button', name='Cobros: fase actual', exact=True)).to_be_visible()
                expect(flow).to_contain_text('Saldo pendiente del importe emitido.')
                expect(flow.get_by_role('button', name='Aprobación: completado', exact=True)).to_be_visible()
                expect(flow.get_by_role('button', name='Entrega: pendiente', exact=True)).to_be_visible()
                screenshot(page, 'collections-unpaid-five-stages', width)
                flow.get_by_role('button', name='Cobros: fase actual', exact=True).focus()
                page.keyboard.press('Enter')
                expect(page.get_by_role('heading', name='Cobros de este trabajo', exact=True)).to_be_visible()
                assert len(COMMANDS) == 1, 'Keyboard stage navigation cannot issue a financial command'
                STATE['settled'] = True
                go(page)
                flow = page.get_by_role('region', name='Fases del trabajo')
                expect(flow.get_by_role('button', name='Cobros: completado', exact=True)).to_be_visible()
                expect(flow).to_contain_text('Importe emitido sin saldo pendiente.')
                expect(flow.get_by_role('button', name='Entrega: pendiente', exact=True)).to_be_visible()
                screenshot(page, 'collections-settled-not-delivered', width)
            STATE['settled'] = False
            page.set_viewport_size({'width': 1440, 'height': 1000})
            # The task board reads as optional follow-up, not a gate on the delivery.
            page.goto(APP + '/taller', wait_until='networkidle')
            page.get_by_role('navigation', name='Áreas del taller').get_by_role('button', name='Tareas').click()
            expect(page.get_by_text(
                'Seguimiento opcional: las tareas abiertas no impiden entregar el vehículo. Puede cerrarlas después.'
            )).to_be_visible()
            screenshot(page, 'task-board-optional', 1440)
            for status in ['Borrador', 'Rechazado']:
                STATE['quotes'] = [copy.deepcopy(STATE['quotes'][0]), {**copy.deepcopy(QUOTE), 'id': 'revision-2', 'revision': 2, 'status': status}]
                go(page, 'Tareas')
                expect(page.get_by_role('region', name='Fases del trabajo')).to_contain_text('Trabajo acordado vigente')
                expect(page.get_by_role('button', name='Revisar aprobación →')).to_be_visible()
            STATE['quotes'] = [copy.deepcopy(QUOTE)]
            page.goto(APP + '/presupuestos/?trabajo=' + JOB['id'], wait_until='networkidle')
            expect(page.get_by_label('Costo unitario 1', exact=True)).to_have_value('20')
            page.get_by_label('Costo unitario 1', exact=True).fill('35')
            page.get_by_role('button', name='2. Precio del presupuesto · cliente', exact=True).click()
            expect(page.get_by_label('Precio unitario 1', exact=True)).to_have_value('50')
            expect(page.get_by_role('complementary', name='Contexto de costos previstos')).to_contain_text('$70.00')
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                screenshot(page, 'manual-client-price', width)
            # The extra item is a first class action: one click lands in the client pricing
            # tab with one empty line ready to fill, and an approved scope needs a new
            # client agreement before the new total can be charged.
            approved_quotes = STATE['quotes']
            STATE['quotes'] = [{**copy.deepcopy(QUOTE), 'status': 'Aprobado'}]
            page.goto(APP + '/presupuestos/?id=' + QUOTE['id'], wait_until='networkidle')
            expect(page.get_by_role('button', name='Agregar adicional al cliente')).to_be_visible()
            page.get_by_role('button', name='Agregar adicional al cliente').click()
            expect(page.get_by_role('button', name='2. Precio del presupuesto · cliente')).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.budget-line')).to_have_count(2)
            expect(page.get_by_label('Precio unitario 2')).to_have_value('')
            expect(page.get_by_text('Requiere una nueva aprobación del cliente.')).to_be_visible()
            screenshot(page, 'extra-item-ready', 1440)
            STATE['quotes'] = approved_quotes
            page.set_viewport_size({'width': 1440, 'height': 1000})
            for legacy, label in [('Cargos y abonos', 'Cobros'), ('Tareas', 'Cobros'),
                                  ('Costos', 'Cobros'), ('Trabajo y costos reales', 'Cobros'),
                                  ('Salida', 'Entrega'), ('Recepción', 'Ingreso y diagnóstico')]:
                go(page, legacy)
                expect(tab(page, label)).to_have_attribute('aria-pressed', 'true')
            STATE['internal'] = True
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                go(page)
                expect(page.get_by_role('region', name='Fases del trabajo').locator('li')).to_have_count(5)
                expect(tab(page, 'Costos reales')).to_have_count(1)
                expect(page.get_by_role('region', name='Fases del trabajo')).to_contain_text('Mantenimiento interno')
                expect(tab(page, 'Cobros')).to_have_count(0)
                expect(page.get_by_test_id('workshop-case')).not_to_contain_text('Precio del presupuesto · cliente')
                screenshot(page, 'internal-summary', width)
            STATE['internal'] = False
            page.set_viewport_size({'width': 1440, 'height': 1000})
            go(page, 'Cargos y abonos')
            expect(page.get_by_role('region', name='Cobros del trabajo', exact=True)).to_be_visible()
            STATE['denied'] = {'expenses.read', 'expenses.write'}
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(page.get_by_test_id('workshop-case')).to_contain_text('Información financiera restringida')
            expect(page.get_by_role('region', name='Cobros del trabajo', exact=True)).to_have_count(0)
            expect(page.get_by_test_id('workshop-case')).not_to_contain_text('$70.00')
            flow = page.get_by_role('region', name='Fases del trabajo')
            expect(flow).not_to_contain_text('Saldo pendiente del importe emitido.')
            expect(flow).to_contain_text('Información financiera restringida.')
            tab(page, 'Fotos y documentos').click()
            expect(page.locator('main')).not_to_contain_text('PRIVATE-FINANCIAL-MARKER')
            expect(page.locator('main')).to_contain_text('Synthetic inspection.pdf')
            screenshot(page, 'permission-revoked', 1440)
            STATE['denied'] = set()
            STATE['finance'] = False
            go(page, 'Presupuestos')
            expect(page.get_by_test_id('workshop-case')).to_contain_text('Información financiera restringida')
            expect(page.get_by_role('region', name='Fases del trabajo')).not_to_contain_text('Saldo pendiente del importe emitido.')
            STATE['finance'] = True
            STATE['status'] = 'Entregado'
            go(page)
            expect(page.get_by_role('region', name='Fases del trabajo')).to_contain_text('Entrega registrada')
            expect(page.get_by_test_id('workshop-case')).to_contain_text('Entregado con saldo pendiente')
            flow = page.get_by_role('region', name='Fases del trabajo')
            expect(flow).to_contain_text('Saldo pendiente del importe emitido.')
            expect(flow.get_by_role('button', name='Entrega: completado', exact=True)).to_be_visible()
            screenshot(page, 'delivered-with-debt', 1440)
            # The permanent vehicle route still dispatches to the existing dossier.
            page.goto(APP + '/vehiculos/expediente/?id=' + VEHICLE['id'], wait_until='networkidle')
            expect(page.get_by_test_id('vehicle-dossier')).to_be_visible()
            expect(page.get_by_test_id('workshop-case')).to_have_count(0)
            assert not ERRORS, ERRORS
            assert not BLOCKED, BLOCKED
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'widths': [1440, 1024, 390, 320], 'realApiRequests': 0,
              'realBusinessWrites': 0, 'syntheticApprovalCommands': len(COMMANDS),
              'syntheticIssuanceCommands': len(BILLING), 'issuanceOfferedAfterApproval': True,
              'deliveryBlockersNamed': True, 'deliveryTasksOptional': True,
              'permissionRevocation': True, 'serverFinancialFlag': True,
              'customerFiveInternalThreeStages': True, 'collectionsKeyboardNavigation': True,
              'settlementDoesNotCompleteWorkOrDelivery': True, 'deliveredDebtStillOutstanding': True,
              'manualPriceIndependentOfCost': True, 'legacyOrderLinks': True,
              'permanentDossierDispatcher': True, 'blockedRequests': BLOCKED, 'browserErrors': ERRORS}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
