"""Persist real UI operations in aj_showcase, then restore only its verified baseline."""
import argparse
import json
import re
import subprocess
from datetime import date, timedelta

from playwright.sync_api import expect, sync_playwright
from showcase_acceptance import APP, API, ROOT, assert_fits, go


def rpc(page, name: str, args: dict) -> dict:
    assert name in ['cash_diary', 'vehicle_case_file']
    return page.evaluate("""async ({name,args}) => {
      const session = JSON.parse(localStorage.getItem('sb-aj-showcase-auth-token'));
      const response = await fetch('http://127.0.0.1:56321/rest/v1/rpc/' + name, {
        method: 'POST', headers: {'Content-Type':'application/json', Authorization:'Bearer ' + session.access_token},
        body: JSON.stringify(args)
      });
      if (!response.ok) throw new Error('Showcase verification read failed: ' + response.status);
      return response.json();
    }""", {'name': name, 'args': args})


def submit(page, button, name: str) -> dict:
    with page.expect_response(lambda response: response.url == API + '/rest/v1/rpc/' + name) as pending:
        button.click()
    response = pending.value
    result = response.json()
    assert response.ok, name + ': ' + json.dumps(result)
    page.wait_for_load_state('networkidle')
    return result


def main() -> None:
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['workspace'] == 'aj-rentacar-showcase-v1'
    vehicle_id = manifest['vehicles'][6]['id']
    job_id = manifest['activeJobs'][1]
    started = False
    completed = False
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        errors: list[str] = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def protect(route) -> None:
            if route.request.url.startswith((APP + '/', API + '/')):
                route.continue_()
            else:
                route.abort()

        page.route(re.compile(r'^https?://'), protect)
        try:
            page.goto(APP + '/inicio', wait_until='networkidle')
            page.get_by_role('button', name='Ingresar', exact=True).click()
            expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
            page.wait_for_load_state('networkidle')

            def case() -> dict:
                return rpc(page, 'vehicle_case_file', {'vehicle_id': vehicle_id, 'order_id': job_id})

            def diary() -> dict:
                return rpc(page, 'cash_diary', {'from_date': manifest['today'], 'to_date': manifest['today'], 'account_filter': 'Caja DEMO'})

            baseline = diary()
            initial = case()
            assert baseline['income'] == 1013 and baseline['outgoing'] == 535 and baseline['balanceAfter'] == 1478
            assert len(initial['quotes']) == 2 and len(initial['advances']) == 1
            assert not initial['documents'] and initial['advances'][0]['available_amount'] == 100
            advance_id = initial['advances'][0]['id']

            go(page, 'presupuestos/?id=' + manifest['quotes'][1])
            expect(page.locator('.grand-total')).to_contain_text('$850.00')
            page.locator('.page-heading').get_by_role('button', name='Editar presupuesto', exact=True).click()
            expect(page.locator('.budget-line')).to_have_count(2)
            page.get_by_role('button', name='Agregar mano de obra', exact=True).click()
            page.get_by_label('Descripción 3', exact=True).fill('DEMO E2E · Additional finishing review')
            page.get_by_label('Precio unitario 3', exact=True).fill('50')
            page.get_by_label('Observaciones / motivo del cambio *', exact=True).fill('DEMO E2E · Complete replacement scope; restore baseline after acceptance.')
            expect(page.locator('.grand-total')).to_contain_text('$900.00')
            started = True
            revision = submit(page, page.get_by_role('button', name='Guardar presupuesto', exact=True), 'record_connected_quote')
            expect(page.locator('.grand-total')).to_contain_text('$900.00')
            page.reload(wait_until='networkidle')
            go(page, 'presupuestos/?id=' + revision['id'])
            expect(page.locator('.grand-total')).to_contain_text('$900.00')
            after_quote = case()
            assert len(after_quote['quotes']) == 3 and not after_quote['documents']
            assert diary()['income'] == baseline['income'] and diary()['outgoing'] == baseline['outgoing']
            print('PASS: complete $900 budget revision persists; previous versions, cash and debt remain separate.')

            page.get_by_role('button', name='Aprobar presupuesto', exact=True).click()
            page.get_by_label('Persona que aprueba', exact=True).fill('DEMO E2E · Simulated approval')
            page.get_by_label('Confirmación del cliente', exact=True).fill('DEMO E2E · Fictitious acceptance; no legal validity.')
            submit(page, page.get_by_role('button', name='Confirmar aprobación', exact=True), 'execute_estimate_command')
            assert not case()['documents'], 'Approval must not create debt'

            go(page, 'taller/ingreso/?id=' + job_id + '&seccion=Costos')
            cost_row = page.locator('tbody tr').filter(has_text='DEMO · Pintura y materiales de preparación')
            cost_row.get_by_text('Clasificar costo', exact=True).click()
            cost_row.get_by_label('Disposición de DEMO · Pintura y materiales de preparación', exact=True).select_option('Incluido')
            cost_row.get_by_label('Alcance aprobado de DEMO · Pintura y materiales de preparación', exact=True).select_option(revision['id'])
            cost_row.get_by_label('Motivo de disposición de DEMO · Pintura y materiales de preparación', exact=True).fill('DEMO E2E · Already included in the approved full scope.')
            submit(page, cost_row.get_by_role('button', name='Guardar disposición', exact=True), 'execute_cost_command')
            assert case()['costs'][0]['disposition'] == 'Incluido'

            go(page, 'cobros/?operacion=' + job_id)
            card = page.locator('.collection-card')
            expect(card).to_have_count(1)
            card.get_by_role('button', name='Crear cargo del presupuesto', exact=True).click()
            submit(page, card.get_by_role('button', name='Confirmar cargo', exact=True), 'execute_case_command')
            expect(card.locator('.amount-outstanding dd')).to_have_text('$900.00')
            charge_id = case()['documents'][0]['id']
            card.get_by_role('button', name='Registrar abono', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.get_by_label('Origen del dinero', exact=True).select_option(advance_id)
            dialog.get_by_label('Destino del abono', exact=True).select_option(charge_id)
            dialog.get_by_label('Importe del abono (USD)', exact=True).fill('100')
            submit(page, dialog.get_by_role('button', name='Aplicar recibo sin nuevo ingreso', exact=True), 'record_linked_receipt')
            expect(card.locator('.amount-outstanding dd')).to_have_text('$800.00')
            applied = diary()
            assert applied['income'] == baseline['income'] and len(applied['rows']) == len(baseline['rows'])
            assert not case()['advances']
            print('PASS: existing $100 advance reduces the new charge to $800 without another cash receipt.')

            card.get_by_role('button', name='Registrar abono', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.get_by_label('Destino del abono', exact=True).select_option(charge_id)
            dialog.get_by_label('Importe del abono (USD)', exact=True).fill('25')
            dialog.get_by_label('Cuenta o caja receptora', exact=True).fill('Caja DEMO')
            dialog.get_by_label('Referencia del pago', exact=True).fill('DEMO E2E · Additional receipt')
            submit(page, dialog.get_by_role('button', name='Guardar cobro y aplicar al cargo', exact=True), 'record_linked_receipt')
            expect(card.locator('.amount-outstanding dd')).to_have_text('$775.00')
            assert diary()['income'] == baseline['income'] + 25

            card.get_by_role('button', name='Registrar gasto', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.get_by_label('Concepto', exact=True).fill('DEMO E2E · Finishing consumables')
            dialog.get_by_label('Importe (USD)', exact=True).fill('15')
            dialog.get_by_label('Categoría', exact=True).fill('DEMO consumables')
            dialog.get_by_label('Cuenta o caja', exact=True).fill('Caja DEMO')
            submit(page, dialog.get_by_role('button', name='Guardar registro', exact=True), 'record_linked_expense')
            expect(card.locator('.amount-outstanding dd')).to_have_text('$775.00')
            final_case = case()
            assert sum(cost['amount'] for cost in final_case['costs']) == 105
            assert len(final_case['documents']) == 1 and final_case['documents'][0]['scope_amount'] == 900
            final_diary = diary()
            assert final_diary['income'] == 1038 and final_diary['outgoing'] == 550 and final_diary['balanceAfter'] == 1488
            assert len(final_diary['rows']) == len(baseline['rows']) + 2
            page.reload(wait_until='networkidle')
            expect(page.locator('.amount-outstanding dd')).to_have_text('$775.00')
            print('PASS: new $25 receipt and $15 expense persist once across modules; expense does not change customer debt.')

            go(page, 'calendario')
            page.get_by_role('button', name='Nueva reserva', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.get_by_label('Cliente de reserva', exact=True).select_option(manifest['customers'][0])
            dialog.get_by_label('Vehículo de reserva', exact=True).select_option(manifest['vehicles'][0]['id'])
            anchor = date.fromisoformat(manifest['today'])
            dialog.get_by_label('Inicio de reserva', exact=True).fill(str(anchor + timedelta(days=13)) + 'T23:59')
            dialog.get_by_label('Fin de reserva', exact=True).fill(str(anchor + timedelta(days=14)) + 'T01:00')
            dialog.get_by_label('Tarifa diaria de reserva (USD)', exact=True).fill('40')
            submit(page, dialog.get_by_role('button', name='Guardar borrador de reserva', exact=True), 'execute_reservation_command')
            dialog = page.get_by_role('dialog')
            submit(page, dialog.get_by_role('button', name='Confirmar reserva', exact=True), 'execute_reservation_command')
            dialog.get_by_role('button', name='Cerrar', exact=True).click()
            gantt = page.get_by_role('region', name='Planificación Gantt de vehículos', exact=True)
            expect(gantt.get_by_role('listitem')).to_have_count(3)
            expect(gantt.get_by_role('button', name=re.compile('^DEMO-101 · Reservado'))).to_be_visible()
            assert_fits(page, '1440px minimum-width Gantt marker at the final minute of the period')
            page.reload(wait_until='networkidle')
            expect(gantt.get_by_role('listitem')).to_have_count(3)
            assert diary()['income'] == 1038, 'Reservation confirmation must not create cash'
            assert not errors, str(errors)
            completed = True
            print('PASS: a real confirmed reservation refreshes monthly/Gantt views, persists and fits the period edge.')
        finally:
            if not completed:
                try:
                    page.screenshot(path=str(ROOT / 'transaction-failure.png'), timeout=5000)
                except Exception:
                    pass
            browser.close()
            if started:
                subprocess.run(['node', '--import', 'tsx', 'scripts/showcase.mjs', 'restore', '--confirm-showcase-only'], check=True)
                print('PASS: only aj_showcase restored to its verified baseline; original hashes checked unchanged.')
    if completed:
        (ROOT / 'transaction-verification.json').write_text(json.dumps({
            'passed': True, 'realUiWrites': True, 'budgetRevision': 900, 'existingAdvanceApplied': 100,
            'newReceipt': 25, 'newExpense': 15, 'doublePostedCash': False, 'confirmedReservation': True,
            'baselineRestored': True, 'originalUnchanged': True,
        }, indent=2), encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--confirm-showcase-only', action='store_true', required=True)
    parser.parse_args()
    main()
