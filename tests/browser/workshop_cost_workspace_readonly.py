"""Cost UX behavior against synthetic HTTP only; unknown requests are aborted."""
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import expect, sync_playwright
import workshop_pipeline_readonly as fixture

ROOT = Path('test-results/workshop-cost-workspace')
COSTS, PAYMENTS, ALLOCATIONS, COMMANDS = [], [], [], []
FAIL = {'allocation': True, 'reads': False, 'case_after_payment': False}
QUOTE = {**copy.deepcopy(fixture.QUOTE), 'status': 'Aprobado'}
fixture.STATE['quotes'] = [QUOTE]
fixture.STATE['open_timer'] = False


def fail(route, message):
    route.fulfill(status=400, json={'code': 'P0001', 'message': message, 'details': None, 'hint': None})


def protect(route):
    request, url = route.request, urlparse(route.request.url)
    resource = url.path.split('/')[-1]
    if '/rest/v1/rpc/' in url.path:
        body = request.post_data_json
        if resource == 'vehicle_case_file':
            if FAIL['case_after_payment']:
                FAIL['case_after_payment'] = False
                fail(route, 'SYNTHETIC_POST_PAYMENT_REFRESH_FAILURE')
                return
            result = fixture.case_file()
            result.update(costs=copy.deepcopy(COSTS), allocations=copy.deepcopy(ALLOCATIONS),
                          expenses=copy.deepcopy(PAYMENTS), documents=[], applications=[], payments=[], advances=[])
            if COSTS and COSTS[0].get('linked_expense_id'):
                result['expenses'].append({'id': 'shared-expense', 'amount': 1000, 'scope_amount': 500,
                                           'shared': True, 'date': '2026-11-10', 'concept': 'Shared receipt',
                                           'account': 'Synthetic cash', 'support': ''})
            route.fulfill(json=result)
            return
        if resource in ['execute_cost_command', 'execute_delivery_cost_adjustment']:
            COMMANDS.append(copy.deepcopy(body))
            assert body['idempotency_key']
            payload = body['payload']
            if body['command'] == 'purchase':
                assert not COSTS, 'No duplicate purchase after a saved parent'
                COSTS.append({**copy.deepcopy(fixture.COST), 'id': 'motor', 'description': payload['description'],
                              'amount': 500, 'unit_cost': 500, 'version': 1})
            else:
                assert body['command'] == 'classify'
                cost = next(row for row in COSTS if row['id'] == payload['costId'])
                assert payload['expectedVersion'] == cost['version']
                assert payload['reason'].strip() and payload['disposition'] in ['Incluido', 'Adicional autorizado', 'Interno', 'Absorbido']
                cost.update(disposition=payload['disposition'], version=cost['version'] + 1)
            route.fulfill(json=copy.deepcopy(COSTS[0]))
            return
        if resource == 'execute_case_command':
            assert body['command'] == 'allocate_cost', body
            COMMANDS.append(copy.deepcopy(body))
            payload = body['payload']
            cost = next(row for row in COSTS if row['id'] == payload['costId'])
            assert payload['expectedVersion'] == cost['version']
            assert payload['reason'].strip()
            assert not payload['lines'] or round(sum(float(row['amount']) for row in payload['lines']), 2) == cost['amount']
            if FAIL['allocation']:
                FAIL['allocation'] = False
                fail(route, 'SYNTHETIC_ALLOCATION_FAILURE')
                return
            ALLOCATIONS[:] = [{'id': f'line-{i}', 'cost_id': cost['id'], 'description': line['description'],
                               'amount': float(line['amount']), 'estimate_id': line['estimateId'],
                               'line_index': line['lineIndex']} for i, line in enumerate(payload['lines'])]
            cost['version'] += 1
            route.fulfill(json={})
            return
        if resource == 'pay_direct_purchase':
            COMMANDS.append(copy.deepcopy(body))
            assert body['cost_id'] == 'motor' and body['idempotency_key']
            assert body['payload']['amount'] == '200'
            PAYMENTS.append({'id': 'supplier-pay', 'direct_purchase_cost_id': 'motor', 'amount': 200,
                             'date': '2026-11-10', 'operation_id': fixture.JOB['id']})
            FAIL['case_after_payment'] = True
            route.fulfill(json=copy.deepcopy(PAYMENTS[-1]))
            return
    if '/rest/v1/' in url.path and '/rpc/' not in url.path and request.method == 'GET':
        if resource in ['workshop_costs', 'expenses']:
            if FAIL['reads'] and resource == 'workshop_costs':
                fail(route, 'SYNTHETIC_READ_FAILURE')
            else:
                # Keep the provider's generic movement count stable to prove the
                # confirmed response, not an incidental reload, updates the UI.
                rows = COSTS if resource == 'workshop_costs' else (
                    [] if parse_qs(url.query).get('select') == ['*'] else PAYMENTS)
                route.fulfill(json=copy.deepcopy(rows))
            return
    fixture.protect(route)


def region(page):
    return page.get_by_role('region', name=f"Costos de {fixture.JOB['id']}", exact=True)


def detail(page):
    return region(page).get_by_role('article', name='Detalle de Motor', exact=True)


def command_count(name):
    return len([body for body in COMMANDS if body.get('command') == name])


def double_submit(button):
    button.evaluate('(button) => { button.click(); button.click(); }')


def shot(page, name, width):
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
               'user': {'id': fixture.USER, 'email': 'fixture@example.invalid', 'aud': 'authenticated',
                        'role': 'authenticated', 'app_metadata': {}, 'user_metadata': {}}}
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: fixture.ERRORS.append(str(error)))
        try:
            fixture.go(page, 'Costos')
            expect(region(page)).to_contain_text('Aún no hay costos registrados')
            region(page).get_by_role('button', name='Registrar costo', exact=True).click()
            # The modal asks how much was paid; this flow acquires the cost on credit
            # and classifies it against the approved quote.
            entry = page.get_by_role('dialog')
            entry.get_by_role('button', name='Nada todavía', exact=False).click()
            entry.get_by_label('Repuesto o servicio adquirido').fill('Motor')
            entry.get_by_label('Costo unitario real (USD)').fill('500')
            entry.get_by_label('Proveedor de compra').fill('Synthetic supplier')
            entry.get_by_label('Referencia de factura y línea').fill('SYNTHETIC-ONLY-MOTOR')
            entry.get_by_role('button', name='Sí, ya está incluido', exact=True).click()
            entry.get_by_label('Motivo de la decisión').fill('Synthetic entry classification')
            double_submit(entry.get_by_role('button', name='Guardar costo de compra', exact=True))
            expect(page.get_by_role('dialog')).to_have_count(0)
            expect(detail(page)).to_be_visible()
            assert command_count('purchase') == 1 and len(COSTS) == 1
            assert command_count('classify') == 1
            expect(detail(page)).to_contain_text('Identificador: motor')
            detail(page).get_by_label('Concepto desglosado 1').fill('Repuesto')
            detail(page).get_by_label('Importe desglosado 1').fill('420')
            detail(page).get_by_role('button', name='Agregar concepto al mismo costo').click()
            detail(page).get_by_label('Concepto desglosado 2').fill('Envío')
            detail(page).get_by_label('Importe desglosado 2').fill('100')
            detail(page).get_by_label('Motivo del desglose').fill('Synthetic audit reason')
            detail(page).get_by_role('button', name='Guardar desglose sin duplicar costo').click()
            expect(detail(page)).to_contain_text('El desglose supera el costo por $20.00')
            assert command_count('allocate_cost') == 0
            detail(page).get_by_label('Importe desglosado 2').fill('80')
            double_submit(detail(page).get_by_role('button', name='Guardar desglose sin duplicar costo'))
            expect(detail(page).get_by_role('alert')).to_contain_text('El costo sigue guardado')
            expect(detail(page).get_by_label('Importe desglosado 1')).to_have_value('420')
            assert command_count('purchase') == 1 and command_count('allocate_cost') == 1
            shot(page, 'saved-parent-child-error', 1440)
            detail(page).get_by_role('button', name='Guardar desglose sin duplicar costo').click()
            expect(detail(page).get_by_label('Motivo del desglose')).to_have_value('')
            attempts = [body for body in COMMANDS if body.get('command') == 'allocate_cost']
            assert len(attempts) == 2 and attempts[0]['idempotency_key'] == attempts[1]['idempotency_key']
            assert attempts[1]['payload']['costId'] == 'motor'
            # Dirty child survives classification and both parent/row refreshes.
            detail(page).get_by_label('Importe desglosado 1').fill('421')
            detail(page).get_by_label('Importe desglosado 2').fill('79')
            detail(page).get_by_label('Motivo del desglose').fill('Preserve child reason')
            detail(page).get_by_text('Revisar relación con el presupuesto', exact=True).click()
            decision = detail(page).get_by_label('Relación con el presupuesto', exact=True)
            expect(decision).to_have_value('Incluido')
            save_decision = detail(page).get_by_role('button', name='Guardar relación con el presupuesto', exact=True)
            expect(save_decision).to_be_disabled()
            decision.select_option('Incluido')
            expect(save_decision).to_be_disabled()
            detail(page).get_by_label('Presupuesto aprobado de este trabajo').select_option(QUOTE['id'])
            detail(page).get_by_label('Motivo de la decisión').fill('Synthetic classification reason')
            double_submit(save_decision)
            expect(detail(page).get_by_text('El costo cambió durante la edición.', exact=False)).to_be_visible()
            expect(detail(page).get_by_label('Importe desglosado 1')).to_have_value('421')
            expect(detail(page).get_by_label('Motivo del desglose')).to_have_value('Preserve child reason')
            expect(detail(page).get_by_role('button', name='Guardar desglose sin duplicar costo')).to_be_disabled()
            detail(page).get_by_role('button', name='Revisé el costo actualizado; conservar mi desglose').click()
            detail(page).get_by_role('button', name='Guardar desglose sin duplicar costo').click()
            expect(detail(page).get_by_label('Motivo del desglose')).to_have_value('')
            assert command_count('classify') == 2
            expected_versions = [body['payload']['expectedVersion'] for body in COMMANDS
                                 if body.get('command') == 'classify']
            assert expected_versions == [1, 3]
            # Classification itself also requires explicit stale-version review.
            decision.select_option('Absorbido')
            detail(page).get_by_label('Motivo de la decisión').fill('Keep decision draft')
            COSTS[0]['version'] += 1
            page.get_by_role('button', name='Actualizar expediente', exact=True).click()
            expect(detail(page)).to_contain_text('El costo cambió. Revise la información actual')
            expect(decision).to_have_value('Absorbido')
            expect(detail(page).get_by_label('Motivo de la decisión')).to_have_value('Keep decision draft')
            expect(save_decision).to_be_disabled()
            detail(page).get_by_role('button', name='Revisé el costo actualizado; conservar mi decisión').click()
            save_decision.click()
            expect(detail(page).get_by_label('Motivo de la decisión')).to_have_value('')
            # Supplier cash is independent of cost and child lines.
            detail(page).get_by_text('Registrar pago al proveedor', exact=True).click()
            detail(page).get_by_label('Importe del pago (USD)').fill('200')
            detail(page).get_by_label('Fecha del pago', exact=True).fill('2026-11-10')
            detail(page).get_by_label('Cuenta del pago').fill('Synthetic cash')
            double_submit(detail(page).get_by_role('button', name='Guardar pago sin duplicar costo'))
            expect(region(page)).to_contain_text('Pago confirmado. Actualice la consulta antes de registrar otro pago.')
            expect(detail(page).locator('dl').last).to_contain_text('$300.00')
            assert len(PAYMENTS) == 1 and COSTS[0]['amount'] == 500 and len(COSTS) == 1
            # Parent identity and exact-cost reconciliation at each target width.
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                fixture.go(page, 'Costos')
                button = region(page).get_by_role('button', name=re.compile(r'Motor.*Compra directa'))
                button.focus()
                page.keyboard.press('Enter')
                expect(detail(page).get_by_role('heading', name='Motor', exact=True)).to_be_focused()
                expect(region(page).get_by_label('Lista de costos').locator('button')).to_have_count(1)
                expect(detail(page).locator('dl').last.locator('dd')).to_have_text(['$500.00', '$200.00', '$300.00'])
                expect(detail(page).get_by_label('Conciliación del desglose').locator('dd')).to_have_text(['$500.00', '$500.00', '$0.00'])
                shot(page, 'motor-cost-detail', width)
                if width < 700:
                    region(page).get_by_role('button', name='Volver a costos').click()
                    expect(button).to_be_focused()
                    expect(detail(page)).not_to_be_visible()
            # A shared $1000 receipt produces only this job's $500 cost share.
            page.set_viewport_size({'width': 1440, 'height': 1000})
            COSTS[0].update(kind='Gasto vinculado', linked_expense_id='shared-expense')
            fixture.go(page, 'Costos')
            expect(detail(page)).to_contain_text('Importe asignado a este trabajo')
            expect(detail(page).get_by_label('Conciliación del desglose').locator('dd')).to_have_text(['$500.00', '$500.00', '$0.00'])
            expect(detail(page)).to_contain_text('El pago corresponde al gasto original')
            expect(detail(page)).not_to_contain_text('$1,000.00')
            assert command_count('purchase') == 1
            shot(page, 'shared-expense-cost-scope', 1440)
            # Zero items is an explicit, reasoned retirement, not a partial split.
            detail(page).get_by_role('button', name='Quitar concepto 2').click()
            detail(page).get_by_role('button', name='Quitar concepto 1').click()
            expect(detail(page)).to_contain_text('se retirará el desglose existente')
            detail(page).get_by_label('Motivo del desglose').fill('Synthetic retirement reason')
            detail(page).get_by_role('button', name='Retirar desglose con motivo').click()
            expect(detail(page).get_by_label('Motivo del desglose')).to_have_value('')
            assert not ALLOCATIONS and COMMANDS[-1]['payload']['lines'] == []
            # Failed reads are not rendered as a zero balance.
            FAIL['reads'] = True
            fixture.go(page, 'Costos')
            expect(region(page)).to_contain_text('No se pudo actualizar la información financiera')
            expect(region(page).get_by_text('Costo registrado de este trabajo', exact=False)).to_have_count(0)
            FAIL['reads'] = False
            region(page).get_by_role('button', name='Reintentar consulta').click()
            expect(region(page)).not_to_contain_text('No se pudo actualizar')
            # Internal jobs retain the original three phases and non-sale choices.
            fixture.STATE['internal'] = True
            COSTS[0].update(kind='Compra directa', linked_expense_id=None)
            fixture.go(page, 'Costos')
            expect(page.get_by_role('region', name='Fases del trabajo').locator('li').first).to_be_visible()
            assert page.get_by_role('region', name='Fases del trabajo').locator('li').count() >= 3
            expect(region(page).get_by_role('link', name='Revisar presupuesto →')).to_have_count(0)
            detail(page).get_by_text('Revisar relación con el presupuesto', exact=True).click()
            expect(detail(page).get_by_label('Relación con el presupuesto', exact=True).locator('option[value="Incluido"]')).to_have_attribute('disabled', '')
            expect(detail(page).get_by_label('Relación con el presupuesto', exact=True).locator('option[value="Adicional autorizado"]')).to_have_attribute('disabled', '')
            expect(detail(page).locator('dl').last.locator('dd')).to_have_text(['$500.00', '$200.00', '$300.00'])
            shot(page, 'internal-non-sale', 1440)
            fixture.STATE['internal'] = False
            # Delivered classification still uses the canonical adjustment route.
            fixture.STATE['status'] = 'Entregado'
            fixture.go(page, 'Costos')
            expect(detail(page).get_by_label('Concepto desglosado 1')).to_have_count(0)
            detail(page).get_by_text('Revisar relación con el presupuesto', exact=True).click()
            detail(page).get_by_label('Relación con el presupuesto', exact=True).select_option('Interno')
            detail(page).get_by_label('Motivo de la decisión').fill('Synthetic management adjustment reason')
            detail(page).get_by_role('button', name='Guardar relación con el presupuesto', exact=True).click()
            expect(detail(page).get_by_label('Motivo de la decisión')).to_have_value('')
            assert COMMANDS[-1]['payload']['reason'] == 'Synthetic management adjustment reason'
            fixture.STATE['status'] = 'Diagnóstico'
            # Explicit false/unknown case gate and current cached permission revocation.
            for flag in [None, False]:
                fixture.STATE['finance'] = flag
                fixture.go(page, 'Costos')
                expect(region(page)).to_have_count(0)
                expect(page.get_by_test_id('workshop-case')).not_to_contain_text('$500.00')
            fixture.STATE['finance'] = True
            fixture.go(page, 'Costos')
            fixture.STATE['denied'] = {'expenses.read', 'expenses.write'}
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(region(page)).to_have_count(0)
            expect(page.get_by_test_id('workshop-case')).not_to_contain_text('shared-expense')
            expect(page.get_by_test_id('workshop-case')).not_to_contain_text('$500.00')
            shot(page, 'permission-revocation', 1440)
            assert not fixture.BLOCKED, fixture.BLOCKED
            assert not fixture.ERRORS, fixture.ERRORS
        except Exception:
            shot(page, 'failure', page.viewport_size['width'])
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'widths': [1440, 1024, 390, 320], 'realApiRequests': 0,
              'realBusinessWrites': 0, 'syntheticCommands': len(COMMANDS), 'behavioralDoubleSubmit': True,
              'savedParentChildRetrySameKey': True, 'dirtyVersionReview': True,
              'confirmedPaymentRefreshFailure': True, 'entryViaModal': True,
              'supplierPaymentIndependent': True, 'sharedExpenseCostScope': True,
              'keyboardFocus': True, 'permissionRevocation': True, 'unknownCaseGate': True,
              'internalNonSale': True, 'deliveredAdjustmentReason': True,
              'blockedRequests': fixture.BLOCKED, 'browserErrors': fixture.ERRORS}
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
