"""Browser-only linked-money journey. All business writes are intercepted, never persisted."""
import copy
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright
from usability_acceptance import assert_fits


def main() -> None:
    config = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf-8').splitlines()
                  if '=' in line and not line.startswith('#'))
    api = config['NEXT_PUBLIC_SUPABASE_URL']
    assert api == 'http://127.0.0.1:55321'
    base = 'http://127.0.0.1:3030'
    today = datetime.now(timezone(timedelta(hours=-6))).date().isoformat()
    expect.set_options(timeout=45000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        page = context.new_page()
        errors, denied, actions = [], [], []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def deny_write(route):
            denied.append(route.request.url.rsplit('/', 1)[-1])
            route.fulfill(status=403, json={'message': 'Persistent business writes are blocked'})

        context.route(re.compile(r'.*/rest/v1/rpc/(execute_|record_|issue_|save_|collect_|pay_|stage_|publish_|review_|link_).*'), deny_write)
        try:
            page.goto(base + '/inicio/', wait_until='networkidle')
            page.locator('#aj-login-email').fill(config['AJ_LOCAL_OWNER_EMAIL'])
            page.locator('#aj-login-password').fill(config['AJ_LOCAL_OWNER_PASSWORD'])
            page.get_by_role('button', name='Ingresar', exact=True).click()
            expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
            token = page.evaluate("""() => JSON.parse(localStorage.getItem(Object.keys(localStorage)
                .find(key => /^sb-.+-auth-token$/.test(key)))).access_token""")
            headers = {'apikey': config['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'], 'Authorization': 'Bearer ' + token}

            def read_table(name):
                response = context.request.get(api + '/rest/v1/' + name + '?select=*', headers=headers)
                assert response.ok, 'Authorized read failed for ' + name
                return response.json()

            tables = ['expenses', 'workshop_costs', 'billing_documents', 'customer_payments',
                      'payment_applications', 'receipt_operation_contexts', 'estimate_versions', 'work_orders', 'reservations']
            before = {name: read_table(name) for name in tables}
            original_quote = before['estimate_versions'][0]
            customer = original_quote['customer_snapshot']
            vehicles = read_table('vehicles')
            first_vehicle = next(v for v in vehicles if v['id'] == original_quote['vehicle_snapshot']['id'])
            cars = [first_vehicle] + [v for v in vehicles if v['id'] != first_vehicle['id']][:2]
            original_order = read_table('work_orders')[0]
            jobs = []
            for index, car in enumerate(cars):
                jobs.append({**original_order, 'id': original_order['id'] if index == 0 else f'OT-{99001 + index}',
                             'vehicle_id': car['id'], 'vehicleId': car['id'], 'customer_id': customer['id'],
                             'customerId': customer['id'], 'status': 'En proceso', 'internal_job': False, 'internalJob': False,
                             'service': f'Browser-only linked work {index + 1}', 'active_estimate_id': original_quote['id'] if index == 0 else None})
            quote = copy.deepcopy(original_quote)
            quote.update({'order_id': jobs[0]['id'], 'status': 'Aprobado'})
            quote.pop('source_totals', None)
            quote['snapshot'].update({'total': 500, 'subtotal': 500, 'commercial': 500, 'discount': 0,
                                     'lines': [{'description': 'Browser-only original scope', 'kind': 'Trabajo',
                                                'quantity': 1, 'unitPrice': 500, 'price': 500, 'unitCost': None, 'cost': None}]})
            state = {'linked': False, 'extra': False, 'advance': False, 'charged': False, 'applied': False, 'revised': None}
            expense = {'id': 'EG-99001', 'date': today, 'concept': 'Browser-only shared labor payment', 'amount': 180,
                       'account': 'Browser-only cash', 'method': 'Efectivo', 'category': 'Labor', 'support': '',
                       'operation_id': None, 'cost_center_id': 'workshop', 'vehicle_id': None, 'reservation_id': None,
                       'currency': 'USD', 'direct_purchase_cost_id': None}
            extra = {**expense, 'id': 'EG-99002', 'amount': 20, 'concept': 'Browser-only expense from folio'}
            cost_ids = [str(uuid4()) for _ in range(4)]
            receipt_id, document_id, application_id = str(uuid4()), str(uuid4()), str(uuid4())

            def costs():
                result = []
                if state['linked']:
                    for index, amount in enumerate([75, 100, 5]):
                        result.append({'id': cost_ids[index], 'order_id': jobs[index]['id'], 'kind': 'Gasto vinculado',
                                       'description': expense['concept'], 'quantity': 1, 'unit_cost': amount, 'amount': amount,
                                       'linked_expense_id': expense['id'], 'expense_id': None, 'version': 1,
                                       'disposition': 'Pendiente', 'reason': 'Browser-only reviewed split', 'occurred_at': today,
                                       'supplier': '', 'source_reference': '', 'estimate_id': None})
                if state['extra']:
                    result.append({**result[0], 'id': cost_ids[3], 'description': extra['concept'], 'amount': 20,
                                   'unit_cost': 20, 'linked_expense_id': extra['id']})
                return result

            def payment():
                return {'id': receipt_id, 'customer_id': customer['id'], 'amount': 200, 'paid_on': today,
                        'method': 'Efectivo', 'account': expense['account'], 'reference': 'Browser-only linked advance', 'folio_number': 99001}

            def document():
                return {'id': document_id, 'order_id': jobs[0]['id'], 'reservation_id': None, 'customer_id': customer['id'],
                        'current_customer_id': customer['id'], 'customer_snapshot': customer, 'description': 'Browser-only posted scope',
                        'amount': 500, 'scope_amount': 500, 'scope_balance': 400 if state['applied'] else 500,
                        'balance': 400 if state['applied'] else 500, 'issued_on': today, 'due_on': today,
                        'days_overdue': 0, 'aging_bucket': 'Vigente', 'folio_number': 99001}

            def application():
                return {'id': application_id, 'payment_id': receipt_id, 'document_id': document_id, 'kind': 'Aplicacion',
                        'amount': 100, 'scope_amount': 100, 'effective_on': today, 'reason': 'Browser-only application'}

            def case_data(args):
                index = next((i for i, job in enumerate(jobs) if job['id'] == args.get('order_id')), 0)
                job_costs = [cost for cost in costs() if cost['order_id'] == jobs[index]['id']]
                expenses = [{**expense, 'scope_amount': [75, 100, 5][index], 'shared': True}] if state['linked'] else []
                if state['extra'] and index == 0:
                    expenses.append({**extra, 'scope_amount': 20, 'shared': False})
                return {'vehicle': cars[index], 'financialAccess': True, 'orders': [jobs[index]],
                                    'reservations': [], 'commitments': [], 'inspections': [], 'files': [],
                                    'quotes': ([state['revised'], quote] if state['revised'] else [quote]) if index == 0 else [],
                                    'costs': job_costs, 'expenses': expenses,
                                    'allocations': [{'id': 'browser-origin', 'cost_id': cost_ids[0], 'estimate_id': state['revised']['id'],
                                                     'line_index': 1, 'description': expense['concept'], 'amount': 75}] if state['revised'] and index == 0 else [],
                                    'documents': [document()] if state['charged'] and index == 0 else [],
                                    'applications': [application()] if state['applied'] and index == 0 else [],
                                    'payments': [payment()] if state['applied'] and index == 0 else [],
                                    'advances': [{**payment(), 'available_amount': 100 if state['applied'] else 200}] if state['advance'] and index == 0 else []}

            def case_response(route):
                route.fulfill(json=case_data(route.request.post_data_json))

            def diary_response(route):
                rows = [{**expense, 'id': 'expense:' + expense['id'], 'kind': 'Egreso', 'area': 'Taller', 'destination': 'workshop',
                         'source_type': 'expense', 'inflow': 0, 'outflow': 180, 'balance_effect': -180, 'linkable': not state['linked'],
                         'links': [{'orderId': job['id'], 'reservationId': None, 'amount': amount, 'kind': 'Gasto repartido'}
                                   for job, amount in zip(jobs, [75, 100, 5])] if state['linked'] else []}]
                if state['extra']:
                    rows.append({**extra, 'id': 'expense:' + extra['id'], 'kind': 'Egreso', 'area': 'Taller', 'destination': 'workshop',
                                 'source_type': 'expense', 'inflow': 0, 'outflow': 20, 'balance_effect': -20, 'linkable': False,
                                 'links': [{'orderId': jobs[0]['id'], 'reservationId': None, 'amount': 20, 'kind': 'Gasto repartido'}]})
                if state['advance']:
                    rows.append({'id': 'receipt:' + receipt_id, 'date': today, 'kind': 'Ingreso', 'source_type': 'receipt',
                                 'concept': payment()['reference'], 'amount': 200, 'account': expense['account'], 'area': 'Por aplicación',
                                 'destination': customer['id'], 'customer_id': customer['id'], 'folio_number': 99001,
                                 'inflow': 200, 'outflow': 0, 'balance_effect': 200, 'unapplied_amount': 100 if state['applied'] else 200,
                                 'links': [{'orderId': jobs[0]['id'], 'reservationId': None, 'amount': 100 if state['applied'] else 200,
                                            'kind': 'Anticipo sin aplicar'}]})
                route.fulfill(json={'rows': rows, 'income': 200 if state['advance'] else 0, 'outgoing': 200 if state['extra'] else 180,
                                    'netMovement': 0, 'balanceBefore': None, 'balanceAfter': None, 'accounts': [expense['account']],
                                    'hasOpening': False, 'unassignedRefunds': 0, 'policy': 'browser-only'})

            def simulate_link(route):
                body = route.request.post_data_json
                assert body['idempotency_key'] and body['payload']['expenseId'] == expense['id']
                assert body['payload']['allocations'] == [{'orderId': job['id'], 'amount': str(amount)} for job, amount in zip(jobs, [75, 100, 5])]
                state['linked'] = True
                actions.append('link-existing')
                route.fulfill(json={'id': expense['id']})

            def simulate_expense(route):
                payload = route.request.post_data_json['payload']
                assert payload['allocations'] == [{'orderId': jobs[0]['id'], 'amount': '20'}]
                assert payload['amount'] == '20'
                state['extra'] = True
                actions.append('capture-in-folio')
                route.fulfill(json={'id': extra['id']})

            def simulate_receipt(route):
                payload = route.request.post_data_json['payload']
                assert payload['customerId'] == customer['id'] and payload['orderId'] == jobs[0]['id']
                if payload.get('paymentId'):
                    assert payload['paymentId'] == receipt_id and payload['documentId'] == document_id and payload['amount'] == '100'
                    state['applied'] = True
                    actions.append('apply-existing')
                else:
                    assert payload['amount'] == '200' and not payload.get('documentId')
                    state['advance'] = True
                    actions.append('advance-in-diary')
                route.fulfill(json={'receipt': {'id': receipt_id}, 'application': {'id': application_id} if state['applied'] else None})

            def simulate_case_command(route):
                body = route.request.post_data_json
                assert body['command'] == 'bill_scope' and body['payload']['orderId'] == jobs[0]['id']
                state['charged'] = True
                actions.append('issue-charge')
                route.fulfill(json=document())

            def simulate_quote(route):
                payload = route.request.post_data_json['payload']
                assert payload['parentId'] == quote['id'] and payload['lines'][0]['unitPrice'] == '500'
                assert payload['lines'][1]['sourceCostId'] == cost_ids[0] and payload['lines'][1]['unitPrice'] == '90'
                revised = copy.deepcopy(quote)
                revised.update({'id': str(uuid4()), 'revision': quote['revision'] + 1, 'status': 'Borrador', 'folio_number': 99002})
                revised['snapshot'].update({'total': 590, 'subtotal': 590, 'commercial': 590, 'lines': [
                    {**line, 'quantity': float(line['quantity']), 'unitPrice': float(line['unitPrice']),
                     'unitCost': float(line['unitCost']) if line.get('unitCost') else None,
                     'price': float(line['quantity']) * float(line['unitPrice']), 'cost': 75 if line.get('sourceCostId') else None}
                    for line in payload['lines']]})
                state['revised'] = revised
                actions.append('link-cost-to-quote')
                route.fulfill(json=revised)

            page.route('**/rest/v1/work_orders?*', lambda route: route.fulfill(json=jobs))
            page.route('**/rest/v1/expenses?*', lambda route: route.fulfill(json=[expense] + ([extra] if state['extra'] else [])))
            page.route('**/rest/v1/workshop_costs?*', lambda route: route.fulfill(json=costs()))
            page.route('**/rest/v1/customer_payments?*', lambda route: route.fulfill(json=[payment()] if state['advance'] else []))
            page.route('**/rest/v1/payment_applications?*', lambda route: route.fulfill(json=[application()] if state['applied'] else []))
            page.route('**/rest/v1/estimate_versions?*', lambda route: route.fulfill(json=([state['revised'], quote] if state['revised'] else [quote])))
            page.route('**/rest/v1/rpc/vehicle_case_file', case_response)
            page.route('**/rest/v1/rpc/cash_diary', diary_response)
            page.route('**/rest/v1/rpc/workshop_expense_inbox', lambda route: route.fulfill(json=[] if state['linked'] else [expense]))
            page.route('**/rest/v1/rpc/receivables_at', lambda route: route.fulfill(json=[document()] if state['charged'] else []))
            page.route('**/rest/v1/rpc/link_workshop_expense', simulate_link)
            page.route('**/rest/v1/rpc/record_linked_expense', simulate_expense)
            page.route('**/rest/v1/rpc/record_linked_receipt', simulate_receipt)
            page.route('**/rest/v1/rpc/execute_case_command', simulate_case_command)
            page.route('**/rest/v1/rpc/record_connected_quote', simulate_quote)

            page.goto(base + '/libro-diario/', wait_until='networkidle')
            page.get_by_role('button', name='Asociar a trabajo', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.get_by_label('Trabajo / folio', exact=True).select_option(jobs[0]['id'])
            dialog.get_by_role('button', name='Repartir entre más trabajos', exact=True).click()
            dialog.get_by_role('button', name='Repartir entre más trabajos', exact=True).click()
            for index, amount in enumerate(['75', '100', '5']):
                dialog.get_by_label(f'Trabajo {index + 1}', exact=True).select_option(jobs[index]['id'])
                dialog.get_by_label('Importe para este trabajo (USD)', exact=True).nth(index).fill(amount)
            dialog.get_by_label('Motivo de la asociación', exact=True).fill('Browser-only reviewed split')
            dialog.get_by_role('button', name='Confirmar vínculo sin duplicar gasto', exact=True).click()
            expect(dialog).to_have_count(0)
            expect(page.get_by_role('article', name='Egreso · ' + expense['concept'], exact=True)).to_contain_text('$180.00')
            page.goto(base + '/taller/ingreso/?id=' + jobs[0]['id'] + '&seccion=Costos', wait_until='networkidle')
            page.get_by_role('button', name='Registrar gasto de este trabajo', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.get_by_label('Concepto', exact=True).fill(extra['concept'])
            dialog.get_by_label('Importe (USD)', exact=True).fill('20')
            dialog.get_by_label('Categoría', exact=True).fill('Material')
            dialog.get_by_label('Cuenta o caja', exact=True).fill(expense['account'])
            dialog.get_by_role('button', name='Guardar registro', exact=True).click()
            expect(dialog).to_have_count(0)
            expect(page.get_by_text('Costo real total: $95.00', exact=True)).to_be_visible()

            page.goto(base + '/libro-diario/', wait_until='networkidle')
            page.get_by_role('button', name='Registrar cobro', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.get_by_label('Cliente del cobro', exact=True).select_option(customer['id'])
            dialog.get_by_label('Folio de taller o contrato del cobro (opcional)', exact=True).select_option('order:' + jobs[0]['id'])
            dialog.get_by_label('Destino del abono', exact=True).select_option('advance')
            dialog.get_by_label('Importe del abono (USD)', exact=True).fill('200')
            dialog.get_by_label('Cuenta o caja receptora', exact=True).fill(expense['account'])
            dialog.get_by_label('Referencia del pago', exact=True).fill(payment()['reference'])
            dialog.get_by_role('button', name='Guardar anticipo vinculado', exact=True).click()
            expect(dialog).to_have_count(0)

            page.goto(base + '/taller/ingreso/?id=' + jobs[0]['id'] + '&seccion=Cargos%20y%20abonos', wait_until='networkidle')
            expect(page.get_by_text(re.compile(r'Anticipo disponible: \$200.00'))).to_be_visible()
            page.get_by_role('button', name='Emitir solamente la diferencia pendiente', exact=True).click()
            page.get_by_label('Origen del dinero', exact=True).select_option(receipt_id)
            page.get_by_label('Destino del abono', exact=True).select_option(document_id)
            page.get_by_label('Importe del abono (USD)', exact=True).fill('100')
            page.get_by_role('button', name='Aplicar recibo sin nuevo ingreso', exact=True).click()
            expect(page.get_by_text(re.compile(r'Anticipo disponible: \$100.00'))).to_be_visible()

            page.goto(base + '/presupuestos/', wait_until='networkidle')
            page.get_by_role('button', name='Editar presupuesto', exact=True).click()
            expect(page.get_by_label('Descripción 1', exact=True)).to_have_value('Browser-only original scope')
            page.get_by_role('button', name='Incorporar al presupuesto', exact=True).first.click()
            page.get_by_label('Precio unitario 2', exact=True).fill('90')
            page.get_by_label(re.compile(r'^Observaciones')).fill('Browser-only linked extra')
            page.get_by_role('button', name='Guardar presupuesto', exact=True).click()
            expect(page.locator('.grand-total')).to_contain_text('$590.00')
            assert actions == ['link-existing', 'capture-in-folio', 'advance-in-diary', 'issue-charge', 'apply-existing', 'link-cost-to-quote']

            page.goto(base + '/presupuestos/?id=' + quote['id'], wait_until='networkidle')
            page.locator('.page-heading').get_by_role('button', name='Editar presupuesto', exact=True).click()
            expect(page.get_by_label('Precio unitario 1', exact=True)).to_have_value('500')
            expect(page.get_by_label('Precio unitario 2', exact=True)).to_have_value('90')
            expect(page.get_by_label('Cliente del presupuesto', exact=True)).to_be_disabled()
            expect(page.locator('.grand-total')).to_contain_text('$590.00')
            page.get_by_role('button', name='Cancelar', exact=True).click()

            for width in [1440, 768, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                for route in ['/libro-diario/', '/taller/ingreso/?id=' + jobs[0]['id'] + '&seccion=Costos',
                              '/presupuestos/?id=' + state['revised']['id'], '/cobros/']:
                    page.goto(base + route, wait_until='networkidle')
                    assert_fits(page, f'{width}px connected money {route}')
                    if route == '/libro-diario/':
                        expect(page.get_by_role('article', name=re.compile(r'^(Egreso|Ingreso) · '))).to_have_count(3)
                        page.screenshot(path=f'test-results/connected-diary-{width}.png', full_page=True)
                page.get_by_role('button', name='Registrar abono', exact=True).first.click()
                assert_fits(page, f'{width}px shared receipt dialog')
                page.get_by_role('button', name='Cerrar', exact=True).click()

            rental_id = str(uuid4())
            rental = {'id': rental_id, 'vehicle_id': cars[1]['id'], 'vehicleId': cars[1]['id'],
                      'customer_id': customer['id'], 'customerId': customer['id'], 'starts_at': today + 'T08:00:00-06:00',
                      'start': today + 'T08:00:00-06:00', 'ends_at': 'infinity', 'end': 'infinity', 'status': 'Confirmada',
                      'rental_state': 'Entregado', 'rentalState': 'Entregado', 'folio_number': 99003, 'folioNumber': 99003,
                      'customer_snapshot': customer, 'vehicle_snapshot': cars[1], 'version': 1,
                      'daily_rate': 40, 'total': 0, 'open_ended': True}
            page.route('**/rest/v1/reservations?*', lambda route: route.fulfill(json=[rental]))
            page.route('**/rest/v1/rpc/rental_case_file', lambda route: route.fulfill(json={
                'vehicle': cars[1], 'financialAccess': True, 'orders': [], 'reservations': [rental],
                'expenses': [], 'payments': [], 'advances': [], 'documents': [], 'applications': []}))
            for width in [1440, 768, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                page.goto(base + '/presupuestos/', wait_until='networkidle')
                expect(page.get_by_role('button', name='Editar presupuesto', exact=True)).to_be_visible()
                assert_fits(page, f'{width}px visible budget edit action')
                page.screenshot(path=f'test-results/budget-edit-action-{width}.png', full_page=True)
                page.goto(base + '/libro-diario/', wait_until='networkidle')
                selector = page.get_by_label('Folio de taller o contrato de alquiler', exact=True)
                assert selector.locator('optgroup').evaluate_all('(groups) => groups.map(group => group.label)') == [
                    'Folios de taller', 'Contratos / reservas de alquiler']
                selector.select_option('order:' + jobs[0]['id'])
                page.get_by_role('button', name='Registrar gasto', exact=True).click()
                dialog = page.get_by_role('dialog')
                expect(dialog.get_by_label('Vincular gasto a', exact=True)).to_have_value('workshop')
                expect(dialog.get_by_label('Trabajo / folio', exact=True)).to_have_value(jobs[0]['id'])
                assert_fits(page, f'{width}px diary preselected workshop folio')
                dialog.get_by_role('button', name='Cancelar', exact=True).click()
                selector.select_option('reservation:' + rental_id)
                expect(selector.locator('option:checked')).to_contain_text('ALQ-99003')
                assert_fits(page, f'{width}px diary explicit rental selection')
                page.screenshot(path=f'test-results/diary-rental-selector-{width}.png', full_page=True)
                page.get_by_role('button', name='Registrar gasto', exact=True).click()
                dialog = page.get_by_role('dialog')
                expect(dialog.get_by_label('Vincular gasto a', exact=True)).to_have_value('reservation')
                expect(dialog.get_by_label('Contrato / alquiler del gasto', exact=True)).to_have_value(rental_id)
                assert_fits(page, f'{width}px diary preselected rental expense')
                dialog.get_by_role('button', name='Cancelar', exact=True).click()
                page.get_by_role('button', name='Registrar cobro', exact=True).click()
                expect(page.get_by_role('dialog')).to_contain_text('ALQ-99003')
                assert_fits(page, f'{width}px diary preselected rental receipt')
                page.get_by_role('button', name='Cerrar', exact=True).click()
                page.get_by_label('Desde', exact=True).fill(today[:8] + '01')
                expect(page).to_have_url(re.compile(r'[?&]desde=' + today[:8] + '01'))
                page.reload(wait_until='networkidle')
                expect(selector).to_have_value('reservation:' + rental_id)
                expect(page.get_by_label('Desde', exact=True)).to_have_value(today[:8] + '01')
                assert 'operacion=' + rental_id in page.url, 'Diary scope is not retained in its URL'

            def external_revision(total):
                revised = copy.deepcopy(state['revised'])
                revised.update({'id': str(uuid4()), 'revision': revised['revision'] + 1,
                                'folio_number': revised['folio_number'] + 1})
                revised['snapshot'].update({'total': total, 'subtotal': total, 'commercial': total})
                revised['snapshot']['lines'][1].update({'unitPrice': total - 500, 'price': total - 500})
                state['revised'] = revised

            page.goto(base + '/taller/ingreso/?id=' + jobs[0]['id'], wait_until='networkidle')
            expect(page.locator('.case-money dd').first).to_have_text('$590.00')
            held = []

            def delayed_case(route):
                if not held:
                    held.append((route, case_data(route.request.post_data_json)))
                else:
                    case_response(route)

            page.route('**/rest/v1/rpc/vehicle_case_file', delayed_case)
            with page.expect_request('**/rest/v1/rpc/vehicle_case_file'):
                page.get_by_role('button', name='Actualizar expediente', exact=True).click()
            external_revision(640)
            with page.expect_response(lambda response: '/rest/v1/work_orders?' in response.url):
                page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(page.locator('.case-money dd').first).to_have_text('$640.00')
            assert held, 'The older case response was not captured'
            held[0][0].fulfill(json=held[0][1])
            page.wait_for_load_state('networkidle')
            expect(page.locator('.case-money dd').first).to_have_text('$640.00')
            expect(page.locator('.case-money .amount-outstanding dd')).to_have_text('$400.00')

            page.goto(base + '/cobros/', wait_until='networkidle')
            expect(page.locator('.collection-card .operation-amounts dd').first).to_have_text('$640.00')
            external_revision(690)
            with page.expect_response(lambda response: '/rest/v1/work_orders?' in response.url):
                page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(page.locator('.collection-card .operation-amounts dd').first).to_have_text('$690.00')

            page.goto(base + '/presupuestos/', wait_until='networkidle')
            expect(page.locator('tbody').first).to_contain_text('$690.00')
            page.get_by_role('button', name='Editar presupuesto', exact=True).click()
            parent_id = state['revised']['id']
            page.get_by_label('Descripción 1', exact=True).fill('Keep this unsaved description')
            page.get_by_label('Precio unitario 2', exact=True).fill('195')
            external_revision(740)
            with page.expect_response(lambda response: '/rest/v1/work_orders?' in response.url):
                page.evaluate("window.dispatchEvent(new Event('focus'))")
            page.wait_for_load_state('networkidle')
            expect(page.get_by_label('Descripción 1', exact=True)).to_have_value('Keep this unsaved description')
            expect(page.get_by_label('Precio unitario 2', exact=True)).to_have_value('195')
            expect(page.locator('.grand-total')).to_contain_text('$695.00')

            def stale_save(route):
                payload = route.request.post_data_json['payload']
                assert payload['parentId'] == parent_id, 'A refresh silently rebased the unsaved scope'
                route.fulfill(status=400, json={'code': 'P0001', 'message': 'PARENT_VERSION_CONFLICT'})

            page.route('**/rest/v1/rpc/record_connected_quote', stale_save)
            page.get_by_label(re.compile(r'^Observaciones')).fill('Browser-only stale revision attempt')
            page.get_by_role('button', name='Guardar presupuesto', exact=True).click()
            expect(page.get_by_role('alert').filter(has_text='versión más reciente')).to_be_visible()
            expect(page.get_by_label('Descripción 1', exact=True)).to_have_value('Keep this unsaved description')
            page.get_by_role('button', name='Cancelar', exact=True).click()
            expect(page.locator('tbody').first).to_contain_text('$740.00')

            page.goto(base + '/vehiculos/alquiler/?id=' + rental_id, wait_until='networkidle')
            expect(page.locator('.detail-list dd').nth(2)).to_have_text('$40.00')
            rental['daily_rate'] = 45
            with page.expect_response(lambda response: '/rest/v1/reservations?' in response.url):
                page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(page.locator('.detail-list dd').nth(2)).to_have_text('$45.00')

            jobs[2].update({'internal_job': True, 'internalJob': True, 'customer_id': None, 'customerId': None})
            page.goto(base + '/libro-diario/', wait_until='networkidle')
            page.get_by_label('Folio de taller o contrato de alquiler', exact=True).select_option('order:' + jobs[2]['id'])
            expect(page.get_by_role('button', name='Registrar cobro', exact=True)).to_be_disabled()
            expect(page.get_by_role('button', name='Registrar gasto', exact=True)).to_be_enabled()
            expect(page.get_by_text('El mantenimiento interno solo registra costos y gastos; no recibe cobros de clientes.', exact=True)).to_be_visible()

            assert not denied, 'Unintercepted business writes: ' + str(denied)
            assert not errors, 'Browser errors: ' + str(errors)
            after = {name: read_table(name) for name in tables}
            assert json.dumps(before, sort_keys=True) == json.dumps(after, sort_keys=True), 'Real business data changed'
            print('PASS: diary split180=75+100+5, folio expense20, linked advance200, existing receipt application100, traceable budget590; four widths, no business writes.')
            print('PASS: visible budget editing keeps latest complete scope; diary distinguishes and preselects workshop folios and rental contracts at four widths.')
            print('PASS: diary scope survives reload; external revisions refresh case/billing/budgets, ignore stale responses and preserve unsaved edits without rebasing.')
        except Exception as error:
            try:
                page.screenshot(path='test-results/connected-money-failure.png', full_page=True, timeout=5000,
                                mask=[page.locator('#aj-login-email'), page.locator('#aj-login-password')])
            except Exception as capture_error:
                print('Failure screenshot unavailable: ' + type(capture_error).__name__)
            safe = str(error).replace(config['AJ_LOCAL_OWNER_PASSWORD'], '[REDACTED]').replace(config['AJ_LOCAL_OWNER_EMAIL'], '[LOCAL USER]')
            raise RuntimeError(safe) from None
        finally:
            browser.close()


if __name__ == '__main__':
    main()
