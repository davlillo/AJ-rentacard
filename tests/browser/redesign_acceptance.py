"""Exercise populated redesign states using browser-only responses, never persistent fixtures."""
import base64
import copy
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright
from usability_acceptance import assert_fits


BASE = 'http://127.0.0.1:3030'
PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='


def main() -> None:
    config = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf-8').splitlines()
                  if '=' in line and not line.startswith('#'))
    api = config['NEXT_PUBLIC_SUPABASE_URL']
    assert api == 'http://127.0.0.1:55321'
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        page = context.new_page()
        errors: list[str] = []
        denied: list[str] = []
        simulated: list[str] = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def block_write(route) -> None:
            denied.append(route.request.url.rsplit('/', 1)[-1])
            route.fulfill(status=403, json={'message': 'Persistent business writes are blocked by this test'})

        context.route(re.compile(r'.*/rest/v1/rpc/(execute_|record_|issue_|save_|collect_|pay_|stage_|publish_|review_|link_).*'), block_write)
        try:
            page.goto(BASE + '/inicio/', wait_until='networkidle')
            page.locator('#aj-login-email').fill(config['AJ_LOCAL_OWNER_EMAIL'])
            page.locator('#aj-login-password').fill(config['AJ_LOCAL_OWNER_PASSWORD'])
            page.locator('button[type=submit]').click()
            expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
            token = page.evaluate("""() => JSON.parse(localStorage.getItem(Object.keys(localStorage)
                .find(key => /^sb-.+-auth-token$/.test(key)))).access_token""")
            headers = {'apikey': config['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'], 'Authorization': 'Bearer ' + token}

            def read_table(name: str):
                response = context.request.get(api + '/rest/v1/' + name + '?select=*', headers=headers)
                assert response.ok, 'Authorized read failed for ' + name
                return response.json()

            cars = [car for car in read_table('vehicles') if car['in_rental_fleet']]
            quote = read_table('estimate_versions')[0]
            order_id, vehicle_id = quote['order_id'], quote['vehicle_snapshot']['id']
            today = datetime.now(timezone(timedelta(hours=-6))).date()
            first = today.replace(day=1)
            starts = (first + timedelta(days=2)).isoformat() + 'T00:00:00-06:00'
            ends = (first + timedelta(days=5)).isoformat() + 'T00:00:00-06:00'
            bookings = []
            for index, (status, state) in enumerate([('Confirmada', 'Preparado'), ('Confirmada', 'Entregado'),
                                                   ('Confirmada', 'Devuelto'), ('Borrador', 'Preparado')]):
                car = cars[index]
                bookings.append({'id': str(uuid4()), 'customer_id': quote['customer_snapshot']['id'], 'vehicle_id': car['id'],
                                 'starts_at': starts, 'ends_at': ends, 'status': status, 'rental_state': state,
                                 'customer_snapshot': {'name': f'Browser-only booking {index + 1}'}, 'vehicle_snapshot': car,
                                 'version': 1, 'daily_rate': 40, 'total': 120, 'cleaning_minutes': 0,
                                 'vehicleId': car['id'], 'customerId': quote['customer_snapshot']['id'],
                                 'start': starts, 'end': ends, 'rentalState': state})
            block = {'id': str(uuid4()), 'vehicle_id': cars[4]['id'], 'reservation_id': None, 'order_id': None,
                     'kind': 'Limpieza', 'starts_at': starts, 'ends_at': ends, 'active': True, 'reason': 'Browser-only cleaning'}
            reservation_pattern = '**/rest/v1/reservations?*'
            commitment_pattern = '**/rest/v1/vehicle_commitments?*'
            page.route(reservation_pattern, lambda route: route.fulfill(json=bookings))
            page.route(commitment_pattern, lambda route: route.fulfill(json=[block]))
            for width in [1440, 768, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                page.goto(BASE + '/calendario/', wait_until='networkidle')
                expect(page.get_by_role('gridcell')).to_have_count(42)
                expect(page.locator('.calendar-booking').nth(2)).to_contain_text('Devuelto')
                page.locator('.calendar-booking-select').first.click()
                expect(page.locator('.calendar-day[aria-selected=true]')).to_have_count(3)
                page.get_by_role('button', name='Mes siguiente', exact=True).click()
                expect(page.locator('.calendar-day[aria-selected=true]')).to_have_count(0)
                page.get_by_role('button', name='Mes anterior', exact=True).click()
                cell = page.locator(f'[data-date="{(first + timedelta(days=2)).isoformat()}"]')
                cell.get_by_role('button', name=re.compile(r'^Ver todos los eventos')).click()
                expect(cell.locator('.calendar-event')).to_have_count(3)
                cell.locator('.calendar-event-blocked').click()
                expect(page.get_by_role('dialog')).to_contain_text('Browser-only cleaning')
                assert_fits(page, f'{width}px calendar block dialog')
                page.get_by_role('button', name='Cerrar', exact=True).click()
                assert_fits(page, f'{width}px populated monthly calendar')
                page.evaluate('window.scrollTo(0, 0)')
                page.screenshot(path=f'test-results/redesign-populated-calendar-{width}.png', full_page=True)
            page.unroute(reservation_pattern)
            page.unroute(commitment_pattern)
            print('PASS: monthly ranges, month navigation, returned/draft states and all blocked events at four widths.')

            state = {'charged': False, 'paid': False, 'expense': False}
            document_id, payment_id, expense_id = str(uuid4()), str(uuid4()), str(uuid4())
            document = {'id': document_id, 'description': 'Browser-only approved scope', 'amount': 2190, 'scope_amount': 2190,
                        'scope_balance': 2190, 'issued_on': today.isoformat(), 'due_on': today.isoformat(), 'folio_number': 1}
            expense = {'id': expense_id, 'date': today.isoformat(), 'concept': 'Browser-only material', 'amount': 120,
                       'account': 'Browser-only cash', 'operation_id': order_id, 'cost_center_id': None, 'vehicle_id': None,
                       'reservation_id': None, 'method': 'Efectivo', 'category': 'Material', 'currency': 'USD', 'support': ''}

            def fake_case(route) -> None:
                response = route.fetch()
                data = response.json()
                if route.request.post_data_json.get('order_id') == order_id:
                    data['quotes'] = [copy.deepcopy(quote)]
                    data['quotes'][0]['status'] = 'Aprobado'
                    data['orders'][0]['active_estimate_id'] = quote['id']
                    current = {**document, 'scope_balance': 1440 if state['paid'] else 2190}
                    data['documents'] = [current] if state['charged'] else []
                    data['costs'] = [{'id': str(uuid4()), 'description': expense['concept'], 'amount': 120}] if state['expense'] else []
                    data['expenses'] = [expense] if state['expense'] else []
                    data['applications'] = [{'id': 'browser-application', 'kind': 'Aplicacion', 'scope_amount': 750,
                                             'effective_on': today.isoformat(), 'payment_id': payment_id}] if state['paid'] else []
                    data['payments'] = [{'id': payment_id, 'amount': 750}] if state['paid'] else []
                route.fulfill(response=response, json=data)

            def simulate_case_command(route) -> None:
                body = route.request.post_data_json
                assert body['payload']['orderId'] == order_id
                assert body['idempotency_key']
                if body['command'] == 'bill_scope':
                    state['charged'] = True
                elif body['command'] == 'collect':
                    assert body['payload']['documentId'] == document_id
                    assert body['payload']['amount'] == '750'
                    state['paid'] = True
                else:
                    block_write(route)
                    return
                simulated.append(body['command'])
                route.fulfill(json={'id': document_id})

            def simulate_expense(route) -> None:
                body = route.request.post_data_json
                assert body['payload']['allocations'] == [{'orderId': order_id, 'amount': '120'}]
                assert body['payload']['amount'] == '120'
                state['expense'] = True
                simulated.append('expense')
                route.fulfill(json={'id': expense_id, 'command': 'record_expense'})

            def simulate_receipt(route) -> None:
                payload = route.request.post_data_json['payload']
                assert payload['orderId'] == order_id and payload['documentId'] == document_id
                assert payload['amount'] == '750'
                state['paid'] = True
                simulated.append('collect')
                route.fulfill(json={'receipt': {'id': payment_id}, 'application': {'id': 'browser-application'}})

            page.route('**/rest/v1/rpc/vehicle_case_file', fake_case)
            page.route('**/rest/v1/rpc/receivables_at', lambda route: route.fulfill(json=[{
                **document, 'customer_snapshot': quote['customer_snapshot'], 'balance': 1440 if state['paid'] else 2190,
                'days_overdue': 0, 'customer_id': quote['customer_snapshot']['id'], 'order_id': order_id,
                'reservation_id': None}] if state['charged'] else []))
            page.route('**/rest/v1/rpc/execute_case_command', simulate_case_command)
            page.route('**/rest/v1/rpc/record_linked_expense', simulate_expense)
            page.route('**/rest/v1/rpc/record_linked_receipt', simulate_receipt)
            page.route('**/rest/v1/expenses?*', lambda route: route.fulfill(json=[expense] if state['expense'] else []))
            page.goto(BASE + '/cobros/', wait_until='networkidle')
            page.get_by_role('button', name='Crear cargo del presupuesto', exact=True).click()
            page.get_by_role('button', name='Confirmar cargo', exact=True).click()
            expect(page.locator('.amount-outstanding dd')).to_have_text('$2,190.00')
            page.get_by_role('button', name='Registrar gasto', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.get_by_label('Concepto', exact=True).fill(expense['concept'])
            dialog.get_by_label('Importe (USD)', exact=True).fill('120')
            dialog.get_by_label('Categoría', exact=True).fill('Material')
            dialog.get_by_label('Cuenta o caja', exact=True).fill(expense['account'])
            dialog.get_by_role('button', name='Guardar registro', exact=True).click()
            expect(dialog).to_have_count(0)
            expect(page.locator('.operation-amounts')).to_contain_text('Pagado en caja: $120.00')
            page.get_by_role('button', name='Registrar abono', exact=True).click()
            page.get_by_label('Destino del abono', exact=True).select_option(document_id)
            page.get_by_label('Importe del abono (USD)', exact=True).fill('750')
            page.get_by_label('Cuenta o caja receptora', exact=True).fill(expense['account'])
            page.get_by_label('Referencia del pago', exact=True).fill('Browser-only receipt')
            page.get_by_role('button', name='Guardar cobro y aplicar al cargo', exact=True).click()
            expect(page.locator('.amount-outstanding dd')).to_have_text('$1,440.00')
            expect(page.locator('.amount-paid')).to_have_text('$750.00')
            expect(page.locator('.collection-metrics strong').first).to_have_text('$1,440.00')
            for width in [1440, 768, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                assert_fits(page, f'{width}px populated operation collection')
                page.evaluate('window.scrollTo(0, 0)')
                page.screenshot(path=f'test-results/redesign-populated-collections-{width}.png', full_page=True)
            assert simulated == ['bill_scope', 'expense', 'collect']
            print('PASS: browser-only expense, approved charge and scoped receipt show2190/120/750/1440 without double counting.')

            photos = []

            def simulate_photo(route) -> None:
                payload = route.request.post_data_json['payload']
                assert payload['vehicleId'] == vehicle_id and payload['purpose'] == 'Vehículo'
                assert base64.b64decode(payload['base64'])[:8] == b'\x89PNG\r\n\x1a\n'
                photo = {'id': str(uuid4()), 'vehicle_id': vehicle_id, 'mime': 'image/png', 'purpose': 'Vehículo',
                         'financial': False, 'created_at': datetime.now(timezone.utc).isoformat()}
                photos.append(photo)
                route.fulfill(json=photo)

            page.route('**/rest/v1/vehicle_files?*', lambda route: route.fulfill(json=photos))
            page.route('**/rest/v1/rpc/save_vehicle_file', simulate_photo)
            page.route('**/rest/v1/rpc/vehicle_file_content', lambda route: route.fulfill(
                json={'mime': 'image/png', 'name': 'browser-only-pixel.png', 'base64': PIXEL}))
            page.goto(BASE + '/taller/ingreso/?id=' + order_id, wait_until='networkidle')
            page.locator('.vehicle-media-detail input[type=file]').set_input_files(
                {'name': 'browser-only-too-large.png', 'mimeType': 'image/png', 'buffer': bytes(2097153)})
            expect(page.locator('.vehicle-photo-error')).to_contain_text('2 MB')
            assert not photos
            page.locator('.vehicle-media-detail input[type=file]').set_input_files(
                {'name': 'browser-only-pixel.png', 'mimeType': 'image/png', 'buffer': base64.b64decode(PIXEL)})
            expect(page.locator('.vehicle-media-detail img')).to_be_visible()
            page.wait_for_function("document.querySelector('.vehicle-media-detail img')?.naturalWidth > 0")
            page.goto(BASE + '/presupuestos/?id=' + quote['id'], wait_until='networkidle')
            expect(page.locator('.budget-client-vehicle img')).to_be_visible()
            page.goto(BASE + '/cobros/', wait_until='networkidle')
            expect(page.locator('.collection-card img')).to_be_visible()
            assert len(photos) == 1
            assert not denied, 'Unexpected business mutation attempt: ' + str(denied)
            assert not errors, 'Browser runtime errors: ' + str(errors)
            print('PASS: private photo upload propagates to case, quote and collection thumbnails using only browser responses.')
        except Exception as error:
            try:
                page.screenshot(path='test-results/redesign-failure.png', full_page=True, timeout=5000,
                                mask=[page.locator('#aj-login-email'), page.locator('#aj-login-password')])
            except Exception as capture_error:
                print('Failure screenshot unavailable: ' + type(capture_error).__name__)
            safe = str(error).replace(config['AJ_LOCAL_OWNER_PASSWORD'], '[REDACTED]').replace(config['AJ_LOCAL_OWNER_EMAIL'], '[LOCAL USER]')
            raise RuntimeError(safe) from None
        finally:
            browser.close()


if __name__ == '__main__':
    main()
