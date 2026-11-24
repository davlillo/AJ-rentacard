"""Verify live rental navigation and responsive actions without business mutations."""
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
from showcase_acceptance import assert_fits

APP = 'http://127.0.0.1:3030'
API = 'http://127.0.0.1:55321'
ROOT = Path('test-results/rental-workflow')
ROOT.mkdir(parents=True, exist_ok=True)
env = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf8').splitlines()
           if '=' in line and not line.startswith('#'))
manifest = json.loads(Path('test-results/local-workspace/manifest.json').read_text(encoding='utf8'))
current_id = manifest['currentRental']
tables = ['public.customers', 'public.vehicles', 'public.reservations', 'public.vehicle_commitments',
          'public.rental_inspections', 'public.rental_extra_proposals', 'public.customer_payments',
          'public.payment_applications', 'public.billing_documents', 'public.expenses', 'private.command_results']


def snapshot():
    parts = [f"select '{table}' name,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) hash from {table} t"
             for table in tables]
    sql = 'begin read only;select jsonb_object_agg(name,hash) from (' + ' union all '.join(parts) + ') s;commit;'
    result = subprocess.run(['docker', 'exec', '-i', 'supabase_db_aj-rentacar', 'psql', '-X', '-U', 'postgres',
                             '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], input=sql, capture_output=True,
                            text=True, check=True, timeout=40)
    return json.loads(result.stdout)


def go(page, route):
    page.goto(APP + '/' + route, wait_until='networkidle')
    expect(page.locator('main h1')).to_be_visible()


before = snapshot()
blocked = []
errors = []
reads = {'has_permission', 'has_task_access', 'vehicle_case_file', 'rental_case_file', 'vehicle_file_content',
         'receivables_at', 'reservation_payment_summary', 'rental_paid_through'}
expect.set_options(timeout=30000)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    # A non-Salvador browser timezone must not change the business dates.
    page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce', timezone_id='Asia/Tokyo')
    page.on('pageerror', lambda error: errors.append(str(error)))

    def protect(route):
        request = route.request
        url = urlparse(request.url)
        if url.hostname != '127.0.0.1' or url.port not in [3030, 55321]:
            route.abort()
        elif url.port == 55321 and '/rest/v1/' in url.path and request.method not in ['GET', 'HEAD', 'OPTIONS']:
            if '/rpc/' in url.path and url.path.split('/rpc/')[1] in reads:
                route.continue_()
            else:
                blocked.append(url.path)
                route.abort()
        else:
            route.continue_()

    page.route(re.compile(r'^https?://'), protect)
    try:
        go(page, 'vehiculos/')
        page.locator('#aj-login-email').fill(env['AJ_LOCAL_OWNER_EMAIL'])
        page.locator('#aj-login-password').fill(env['AJ_LOCAL_OWNER_PASSWORD'])
        page.get_by_role('button', name='Ingresar', exact=True).click()
        expect(page.get_by_role('heading', name='Vehículos', exact=True)).to_be_visible()
        expect(page.get_by_role('navigation', name='Navegación principal').get_by_role('link')).to_have_count(9)
        expect(page.get_by_role('tablist', name='Estado de la flota').get_by_role('tab')).to_have_count(4)
        page.locator('.vehicle-card').filter(has_text='P101-004').get_by_role('link', name='Ver expediente').click()
        expect(page.locator('.rental-operation h2')).to_contain_text('ALQ-00006')
        vehicle_url = page.url
        future_href = page.get_by_role('region', name='Reservas por entregar').get_by_role('link', name='Preparar entrega →').first.get_attribute('href')
        historical_href = None
        # The collection control lives only in the Cuentas stage of the folio.
        page.get_by_role('link', name='Abrir alquiler', exact=True).click()
        page.get_by_role('button', name=re.compile('^Cuentas')).first.click()
        page.get_by_role('button', name='Realizar cobro', exact=True).click()
        draft = page.get_by_role('dialog')
        expect(draft.locator('fieldset')).to_be_enabled()
        draft.get_by_label('Importe recibido (USD)', exact=True).fill('25')
        draft.get_by_label('Cuenta o caja receptora', exact=True).fill('Draft cash')
        draft.get_by_label('Referencia del pago', exact=True).fill('Keep this unsaved draft')
        with page.expect_response(lambda response: '/rpc/rental_case_file' in response.url):
            page.evaluate("window.dispatchEvent(new Event('focus'))")
        page.wait_for_load_state('networkidle')
        expect(draft).to_be_visible()
        expect(draft.get_by_label('Importe recibido (USD)', exact=True)).to_have_value('25')
        expect(draft.get_by_label('Referencia del pago', exact=True)).to_have_value('Keep this unsaved draft')
        draft.get_by_role('button', name='Cerrar', exact=True).click()
        for width, height in [(1440, 1000), (768, 1024), (390, 844), (320, 740)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.goto(vehicle_url, wait_until='networkidle')
            current = page.locator('.rental-operation')
            expect(current.get_by_role('heading', name='ALQ-00006 · Daniel Torres', exact=True)).to_be_visible()
            expect(current.locator('.rental-money dd')).to_have_text(['$315.00', '$180.00', '$80.00', '$235.00'])
            expect(current.locator('[aria-current=step]')).to_have_text('2Alquilado')
            expect(page.get_by_role('region', name='Reservas por entregar')).to_contain_text('david hernandez')
            expect(page.locator('main')).not_to_contain_text(re.compile(r'\d{4}-\d\d-\d\dT\d\d:'))
            assert_fits(page, str(width) + 'px current rental and next reservation')
            page.screenshot(path=str(ROOT / f'vehicle-{width}.png'))

            # The collection control lives only in the Cuentas stage of the folio.
            current.get_by_role('link', name='Abrir alquiler', exact=True).click()
            page.get_by_role('button', name=re.compile('^Cuentas')).first.click()
            page.get_by_role('button', name='Realizar cobro', exact=True).click()
            dialog = page.get_by_role('dialog')
            expect(dialog.locator('fieldset')).to_be_enabled()
            expect(dialog).to_contain_text('Daniel Torres')
            expect(dialog).to_contain_text('ALQ-00006')
            expect(dialog.get_by_label('Importe recibido (USD)', exact=True)).to_have_value('100.00')
            expect(dialog.get_by_label('A qué documento se aplica el cobro', exact=True).locator('option:checked')).to_contain_text('saldo $100.00')
            assert dialog.get_by_label('A qué documento se aplica el cobro', exact=True).locator('option').count() == 3
            assert_fits(page, str(width) + 'px contextual rental receipt')
            dialog.screenshot(path=str(ROOT / f'receipt-{width}.png'))
            dialog.get_by_role('button', name='Cerrar', exact=True).click()

            current.get_by_role('link', name='Registrar devolución', exact=True).click()
            expect(page.get_by_role('heading', name='Registrar devolución del vehículo', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='Registrar devolución de alquiler', exact=True)).to_be_visible()
            assert_fits(page, str(width) + 'px return inspection')
            page.screenshot(path=str(ROOT / f'return-{width}.png'))

            go(page, 'vehiculos/alquiler/?id=' + current_id)
            page.get_by_role('button', name='Registrar devolución', exact=True).click()
            go(page, 'vehiculos/alquiler/?id=' + current_id + '&seccion=Limpieza')
            # The release of the vehicle moved to its dossier; the folio only points to it.
            expect(page.get_by_role('heading', name='Registrar devolución del vehículo', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='Confirmar limpieza y revisar disponibilidad', exact=True)).to_have_count(0)
            assert_fits(page, str(width) + 'px cleaning before return')

            page.goto(APP + future_href, wait_until='networkidle')
            expect(page.get_by_role('heading', name='Entrega del vehículo al cliente', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='Registrar salida de alquiler', exact=True)).to_be_visible()
            expect(page.locator('main')).to_contain_text('15 nov 2026')
            assert_fits(page, str(width) + 'px future reservation delivery')

            page.goto(vehicle_url, wait_until='networkidle')
            history = page.locator('.vehicle-rentals details')
            history.locator('summary').click()
            expect(history).to_contain_text('ALQ-00004')
            expect(history).to_contain_text('Alquiler finalizado')
            historical_href = history.get_by_role('link', name='Abrir alquiler →').first.get_attribute('href')
            assert_fits(page, str(width) + 'px rental history')
            page.goto(APP + historical_href, wait_until='networkidle')
            # The release of the vehicle is not in the rental folio any more.
            expect(page.locator('#rental-cleaning')).to_have_count(0)
            expect(page.get_by_role('button', name='Confirmar limpieza y revisar disponibilidad', exact=True)).to_have_count(0)
            assert_fits(page, str(width) + 'px reviewed cleaning')
            print('PASS: current, future, receipt, return and cleaning at', width)

        page.set_viewport_size({'width': 390, 'height': 844})
        go(page, 'calendario/?reserva=' + current_id)
        dialog = page.get_by_role('dialog')
        expect(dialog).to_contain_text('Alquiler en curso')
        expect(dialog.get_by_role('link', name='Registrar devolución', exact=True)).to_be_visible()
        expect(dialog).not_to_contain_text(re.compile(r'\d{4}-\d\d-\d\dT\d\d:'))
        assert_fits(page, 'calendar lifecycle dialog')

        # Isolated response fixtures exercise the pending-cleaning form without returning the live car.
        reviewed = False

        def cleaning_view(route):
            response = route.fetch()
            case = response.json()
            if route.request.post_data_json.get('reservation_id') == current_id:
                case['reservations'][0]['rental_state'] = 'Devuelto'
                case['vehicle']['status'] = 'Disponible' if reviewed else 'En taller'
                case['commitments'] = [{'id': '00000000-0000-4000-8000-000000000601',
                    'reservation_id': current_id, 'vehicle_id': case['vehicle']['id'], 'kind': 'Limpieza',
                    'active': not reviewed, 'starts_at': '2026-11-05T22:00:00Z',
                    'ends_at': '2026-11-05T23:00:00Z', 'order_id': None, 'reason': 'Isolated test response'}]
            route.fulfill(response=response, json=case)

        page.route('**/rest/v1/rpc/rental_case_file', cleaning_view)
        for width in [1440, 320]:
            page.set_viewport_size({'width': width, 'height': 1000})
            go(page, 'vehiculos/alquiler/?id=' + current_id)
            expect(page.locator('.rental-operation')).to_contain_text('Devuelto · pendiente de liberar')
            expect(page.get_by_role('button', name='Realizar cobro', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='Finalizar limpieza', exact=True)).to_have_count(0)
            assert_fits(page, str(width) + 'px isolated pending-cleaning form')
        reviewed = True
        go(page, 'vehiculos/alquiler/?id=' + current_id)
        expect(page.locator('.rental-operation')).to_contain_text('Alquiler finalizado')
        expect(page.get_by_role('button', name='Realizar cobro', exact=True)).to_have_count(0)
        expect(page.get_by_role('button', name='Finalizar limpieza', exact=True)).to_have_count(0)
        assert not blocked, blocked
        assert not errors, errors
    finally:
        browser.close()

after = snapshot()
changed = [table for table in tables if before[table] != after[table]]
# The owner may use this same workspace during acceptance. Never roll back concurrent changes.
result = {'passed': True, 'widths': [1440, 768, 390, 320], 'tablesUnchanged': len(tables) - len(changed),
          'concurrentUpdates': changed,
          'unsavedReceiptSurvivesRefresh': True,
          'businessWrites': 0, 'isolatedViewStates': ['returned, cleaning pending', 'reviewed, balance unpaid'],
          'blockedRequests': blocked, 'browserErrors': errors}
(ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
print(json.dumps(result))
