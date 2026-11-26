"""Presupuestos clarity and the extra-item flow against synthetic HTTP only; unknown business requests abort.

No real API, database or business write is performed: every request is intercepted and
fulfilled with a synthetic fixture, and any request the fixture does not know is aborted.
"""
import copy
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
import workshop_pipeline_readonly as fixture

APP = os.environ.get('AJ_APP', 'http://127.0.0.1:3030')
ROOT = Path('test-results/workshop-budgets')
USER = fixture.USER
CUSTOMER = fixture.CUSTOMER
VEHICLE = fixture.VEHICLE
JOB = fixture.JOB
QUOTE = {**copy.deepcopy(fixture.QUOTE), 'id': 'synthetic-quote', 'status': 'Aprobado'}
STATE = fixture.STATE
STATE['quotes'] = [copy.deepcopy(QUOTE)]
STATE['status'] = 'Presupuesto'
STATE['active'] = 'synthetic-quote'
BOOK = {'id': 'synthetic-book', 'file_name': 'presupuesto-original.xlsx', 'file_hash': 'synthetic',
        'format': 'budget', 'parser_version': '1', 'created_at': '2026-11-10T12:00:00Z'}
SHEET = {'name': 'Presupuestos', 'range': 'A1:B2',
         'rows': [{'number': 1, 'cells': [{'address': 'A1', 'value': 'Parabrisas', 'display': 'Parabrisas'}]},
                  {'number': 2, 'cells': [{'address': 'A2', 'value': 120, 'display': '120'}]}],
         'merges': []}
BLOCKED, ERRORS, SAVES, COMMANDS = [], [], [], []
FAIL_SAVE = {'on': False}


def case_file():
    return {**copy.deepcopy(fixture.case_file()), 'quotes': copy.deepcopy(STATE['quotes']),
            'costs': copy.deepcopy(STATE.get('costs') or [fixture.COST])}


def saved_quote(payload):
    lines = []
    for line in payload['lines']:
        quantity = float(line['quantity'])
        price = float(line['unitPrice'])
        cost = line.get('unitCost')
        known = cost not in (None, '')
        lines.append({'description': line['description'], 'kind': line['kind'], 'quantity': quantity,
                      'unitPrice': price, 'unitCost': float(cost) if known else None,
                      'cost': round(float(cost) * quantity, 2) if known else None,
                      'price': round(price * quantity, 2)})
    subtotal = round(sum(line['price'] for line in lines), 2)
    discount = float(payload.get('discount') or 0)
    costs = [line['cost'] for line in lines]
    cost_complete = all(cost is not None for cost in costs)
    total = round(subtotal - discount, 2)
    internal_cost = round(sum(cost for cost in costs if cost is not None), 2)
    return {'id': 'synthetic-quote-v2', 'order_id': payload['orderId'], 'revision': 2,
            'parent_id': payload['parentId'], 'status': 'Borrador', 'folio_number': 99002,
            'snapshot': {'cost': internal_cost, 'costComplete': cost_complete, 'subtotal': subtotal,
                         'discount': discount, 'total': total,
                         'margin': round(total - internal_cost, 2) if cost_complete else None,
                         'marginPct': None, 'commercial': total, 'currency': 'USD', 'lines': lines},
            'customer_snapshot': CUSTOMER, 'vehicle_snapshot': VEHICLE, 'reason': payload['reason'],
            'created_at': '2026-11-10T13:00:00Z'}


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
        if resource == 'record_connected_quote':
            SAVES.append(copy.deepcopy(body['payload']))
            assert body['idempotency_key'], 'A quote revision needs an idempotency key'
            if FAIL_SAVE['on']:
                FAIL_SAVE['on'] = False
                route.fulfill(status=400, json={'code': 'P0001', 'message': 'PARENT_VERSION_CONFLICT',
                                               'details': None, 'hint': None})
                return
            saved = saved_quote(body['payload'])
            STATE['quotes'] = [copy.deepcopy(saved)] + STATE['quotes']
            route.fulfill(json=saved)
            return
        if resource == 'source_workbook_bundle':
            route.fulfill(json={'book': {**copy.deepcopy(BOOK), 'preview': {'sheets': [copy.deepcopy(SHEET)]}},
                               'items': []})
            return
        if resource in ['workshop_assignees', 'receivables_at', 'workshop_expense_inbox']:
            route.fulfill(json=[])
            return
        if resource == 'execute_estimate_command':
            COMMANDS.append(copy.deepcopy(body))
            route.fulfill(json={})
            return
    elif '/rest/v1/' in url.path and request.method == 'GET':
        records = {'customers': [CUSTOMER], 'customer_aliases': [], 'vehicles': [VEHICLE],
                   'work_orders': [{**copy.deepcopy(JOB), 'status': STATE['status'],
                                    'internal_job': STATE['internal'], 'internalJob': STATE['internal'],
                                    'active_estimate_id': STATE['active']}],
                   'expenses': [], 'workshop_tasks': [], 'reservations': [], 'vehicle_files': [],
                   'workshop_costs': [], 'workshop_tariffs': [], 'estimate_versions': STATE['quotes'],
                   'estimate_approvals': [], 'workshop_deliveries': [], 'customer_payments': [],
                   'payment_applications': [], 'payment_refunds': [], 'expense_origin_links': [],
                   'task_timers': [], 'task_time_spans': [], 'source_workbooks': [BOOK]}
        if resource in records:
            route.fulfill(json=copy.deepcopy(records[resource]))
            return
    BLOCKED.append(resource)
    route.abort()


def screenshot(page, name, width):
    page.evaluate('window.scrollTo(0, 0)')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name
    page.screenshot(path=str(ROOT / f'{name}-{width}.png'), full_page=True)
    # The visible text is stored next to the picture as inspectable evidence.
    (ROOT / f'{name}-{width}.txt').write_text(page.locator('body').inner_text(), encoding='utf8')


def open_detail(page):
    page.goto(APP + '/presupuestos/?id=' + QUOTE['id'], wait_until='networkidle')
    expect(page.get_by_role('button', name='Agregar adicional al cliente')).to_be_visible()


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
            # The detail view offers the extra item as a first class action.
            open_detail(page)
            expect(page.get_by_role('button', name='Nuevo presupuesto')).to_be_visible()
            assert not SAVES and not COMMANDS, 'Reading a quote never writes anything'
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                open_detail(page)
                expect(page.get_by_role('button', name='Agregar adicional al cliente')).to_be_visible()
                screenshot(page, 'quote-detail', width)

            # One click lands in the client pricing tab with one empty line ready to fill.
            page.set_viewport_size({'width': 1440, 'height': 1000})
            open_detail(page)
            page.get_by_role('button', name='Agregar adicional al cliente').click()
            expect(page.get_by_role('button', name='2. Precio del presupuesto · cliente')).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.budget-line')).to_have_count(2)
            expect(page.get_by_label('Descripción 2')).to_have_value('')
            expect(page.get_by_label('Precio unitario 2')).to_have_value('')
            # The internal cost of the extra line stays optional.
            expect(page.get_by_label('Costo unitario 2')).to_have_value('')
            expect(page.get_by_text('Costo interno unitario (opcional)').first).to_be_visible()
            # The appended line is marked as an additional item from the first click.
            expect(page.locator('.budget-line').nth(1).get_by_text('Adicional', exact=True)).to_be_visible()
            # The parent version was approved, so the client has to agree again.
            expect(page.get_by_text('El cliente debe aprobar el nuevo total')).to_be_visible()
            expect(page.get_by_text('sigue vigente')).to_be_visible()
            # The old jargon is gone from the workspace.
            body = page.locator('body')
            for jargon in ['Costo previsto', 'Costo unitario previsto', 'Margen previsto · interno',
                           'Por completar', 'Por definir']:
                expect(body).not_to_contain_text(jargon)
            screenshot(page, 'extra-item-ready', 1440)
            for width in [1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                expect(page.get_by_role('button', name='Agregar partida (material o adicional)')).to_be_visible()
                expect(page.get_by_role('button', name='Agregar mano de obra')).to_be_visible()
                screenshot(page, 'extra-item-ready', width)
            page.set_viewport_size({'width': 1440, 'height': 1000})

            # Keyboard: the new line can be typed into without touching the mouse.
            page.get_by_label('Descripción 2').focus()
            assert page.evaluate('document.activeElement.getAttribute("aria-label")') == 'Descripción 2'
            page.keyboard.type('Parabrisas de repuesto')
            page.get_by_label('Precio unitario 2').fill('120')
            page.get_by_label('Observaciones / motivo del cambio').fill('Adicional acordado con el cliente por mensaje')
            # The editor splits the client total by kind and prints no empty row.
            expect(page.locator('.budget-tally').get_by_text('Repuestos (material)').first).to_be_visible()
            expect(page.locator('.budget-tally').get_by_text('Mano de obra')).to_have_count(0)
            # The editor splits the client total by kind and prints no empty row.
            expect(page.locator('.budget-tally').get_by_text('Repuestos (material)').first).to_be_visible()
            expect(page.locator('.budget-tally').get_by_text('Mano de obra')).to_have_count(0)

            # A rejected save keeps every value the operator typed.
            FAIL_SAVE['on'] = True
            # The development overlay renders a toast for the failed request and covers the
            # button, so the click is forced on the element itself.
            page.get_by_role('button', name='Guardar presupuesto').click(force=True)
            expect(page.locator('p.form-error')).to_contain_text('versión más reciente')
            expect(page.get_by_label('Descripción 2')).to_have_value('Parabrisas de repuesto')
            expect(page.get_by_label('Precio unitario 2')).to_have_value('120')
            screenshot(page, 'extra-item-error-kept', 1440)

            # The saved revision is a new Borrador that the client still has to approve.
            page.get_by_role('button', name='Guardar presupuesto').click(force=True)
            expect(page.locator('p.form-error')).to_have_count(0)
            assert len(SAVES) == 2, SAVES
            payload = SAVES[-1]
            assert payload['parentId'] == QUOTE['id'], payload
            assert payload['reason'].strip(), payload
            assert len(payload['lines']) == 2, payload
            extra = payload['lines'][-1]
            assert extra['description'] == 'Parabrisas de repuesto', extra
            assert extra['unitPrice'] == '120', extra
            assert not extra['unitCost'], 'The internal cost of the extra line stays optional'
            assert payload['lines'][0]['description'] == 'Synthetic replacement', payload
            assert not COMMANDS, 'Saving a revision never approves by itself'
            assert STATE['active'] == 'synthetic-quote', 'The approved version stays active'
            expect(page.get_by_text('El cliente debe aprobar el nuevo total')).to_be_visible()
            expect(page.get_by_text('Borrador').first).to_be_visible()
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                expect(page.get_by_text('El cliente debe aprobar el nuevo total')).to_be_visible()
                screenshot(page, 'revision-needs-approval', width)

            # The legacy spreadsheet import is a secondary action, not a primary tab.
            page.set_viewport_size({'width': 1440, 'height': 1000})
            page.goto(APP + '/presupuestos/', wait_until='networkidle')
            expect(page.locator('nav.module-tabs button')).to_have_count(1)
            # The filter lists quote states only, never the states of the work order.
            expect(page.get_by_label('Estado del presupuesto', exact=True).locator('option')).to_have_text(
                ['Todos', 'Borrador', 'Aprobado', 'Rechazado'])
            expect(page.get_by_role('button', name='Archivo original')).to_be_visible()
            page.get_by_role('button', name='Archivo original').click()
            expect(page.get_by_role('region', name='Datos del archivo original')).to_be_visible()
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                screenshot(page, 'legacy-import-secondary', width)

            # The folio link opens the same extra item flow through the ?adicional=1 hint.
            page.set_viewport_size({'width': 1440, 'height': 1000})
            page.goto(APP + '/presupuestos/?id=' + QUOTE['id'] + '&adicional=1', wait_until='networkidle')
            expect(page.get_by_role('button', name='2. Precio del presupuesto · cliente')).to_have_attribute('aria-pressed', 'true')
            # The latest revision of the work carries two lines, so the hint copies them and
            # leaves one empty line ready to fill.
            expect(page.locator('.budget-line')).to_have_count(3)
            expect(page.get_by_label('Precio unitario 3')).to_have_value('')
            expect(page.get_by_label('Descripción 2')).to_have_value('Parabrisas de repuesto')
            expect(page.get_by_text('El cliente debe aprobar el nuevo total')).to_be_visible()
            screenshot(page, 'extra-item-hint', 1440)

            # Labor and material are separated in the quote detail, and a zero kind prints no row.
            STATE['quotes'] = [{**copy.deepcopy(QUOTE), 'status': 'Aprobado'}]
            STATE['active'] = 'synthetic-quote'
            STATE['costs'] = [copy.deepcopy(fixture.COST)]
            page.set_viewport_size({'width': 1440, 'height': 1000})
            page.goto(APP + '/presupuestos/?id=' + QUOTE['id'], wait_until='networkidle')
            expect(page.locator('.budget-tally').get_by_text('Repuestos (material)').first).to_be_visible()
            expect(page.locator('.budget-tally').get_by_text('Mano de obra')).to_have_count(0)
            expect(page.get_by_text('Adicional', exact=True)).to_have_count(0)

            # An additional item keeps its badge, its amount and the state of its revision,
            # and an authorized cost outside the approved scope is shown with its amount.
            EXTRA = {'description': 'Parabrisas adicional', 'kind': 'Trabajo', 'quantity': 1, 'unitPrice': 120,
                     'unitCost': 40, 'cost': 40, 'price': 120}
            approved = {**copy.deepcopy(QUOTE), 'status': 'Aprobado'}
            draft = {**copy.deepcopy(QUOTE), 'id': 'synthetic-quote-v2', 'revision': 2,
                     'parent_id': QUOTE['id'], 'status': 'Borrador',
                     'snapshot': {**copy.deepcopy(QUOTE['snapshot']),
                                  'lines': [copy.deepcopy(fixture.LINE), EXTRA], 'subtotal': 220, 'total': 220,
                                  'cost': 80, 'margin': 140}}
            STATE['quotes'] = [draft, approved]
            STATE['costs'] = [{**copy.deepcopy(fixture.COST), 'description': 'Inyectores', 'amount': 40,
                               'disposition': 'Adicional autorizado', 'estimate_id': QUOTE['id']}]
            DRAFT_URL = APP + '/presupuestos/?id=synthetic-quote-v2'
            page.goto(DRAFT_URL, wait_until='networkidle')
            tally = page.locator('.budget-tally')
            expect(tally.get_by_text('Repuestos (material)').first).to_be_visible()
            expect(tally.get_by_text('Mano de obra').first).to_be_visible()
            expect(page.get_by_text('Adicional', exact=True).first).to_be_visible()
            block = page.get_by_role('region', name='Adicionales del presupuesto')
            expect(block).to_be_visible()
            expect(block).to_contain_text('Parabrisas adicional')
            expect(block).to_contain_text('120')
            expect(block).to_contain_text('pendiente de aprobación')
            expect(block).to_contain_text('Adicional autorizado fuera del presupuesto:')
            expect(block).to_contain_text('Inyectores')
            # The editor repeats the same summary for the work it is editing.
            page.goto(APP + '/presupuestos/?trabajo=OT-99001', wait_until='networkidle')
            editor_block = page.get_by_role('region', name='Adicionales del presupuesto')
            expect(editor_block).to_contain_text('Parabrisas adicional')
            expect(editor_block).to_contain_text('pendiente de aprobación')
            expect(editor_block).to_contain_text('Adicional autorizado fuera del presupuesto:')
            page.goto(DRAFT_URL, wait_until='networkidle')
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                page.goto(DRAFT_URL, wait_until='networkidle')
                expect(block).to_be_visible()
                screenshot(page, 'labor-material-additional', width)

            assert not BLOCKED, BLOCKED
            assert not ERRORS, ERRORS
        finally:
            browser.close()


if __name__ == '__main__':
    main()
