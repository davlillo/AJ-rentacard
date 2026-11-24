"""Verify targeted UI fixes against live reads; intercept every proposed business write."""
import base64
import json
import re
import struct
import subprocess
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
from showcase_acceptance import assert_fits

APP = 'http://127.0.0.1:3030'
ROOT = Path('test-results/polish')
READS = {'has_permission', 'has_task_access', 'vehicle_case_file', 'rental_case_file', 'vehicle_file_content',
         'receivables_at', 'reservation_payment_summary', 'rental_paid_through', 'cash_diary',
         'workshop_assignees', 'workshop_expense_inbox', 'rental_alternatives', 'customer_document_list'}


def query(sql):
    result = subprocess.run(['docker', 'exec', '-i', 'supabase_db_aj-rentacar', 'psql', '-X', '-U', 'postgres',
        '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], input='begin read only;' + sql + ';commit;',
        capture_output=True, text=True, check=True, timeout=45)
    return json.loads(result.stdout)


def snapshot():
    before = json.loads((ROOT / 'before-migration.json').read_text(encoding='utf8'))
    pieces = [f"select '{table}' name,count(*) n,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) hash from public.\"{table}\" t" for table in before]
    return query("select jsonb_object_agg(name,jsonb_build_object('count',n,'hash',hash)) from (" + ' union all '.join(pieces) + ') s')


def go(page, path):
    page.goto(APP + '/' + path, wait_until='networkidle')
    expect(page.locator('main h1')).to_be_visible()


def main():
    ROOT.mkdir(exist_ok=True, parents=True)
    env = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf8').splitlines()
               if '=' in line and not line.startswith('#'))
    context = query("select jsonb_build_object('customer',(select to_jsonb(c) from public.customers c where merged_into is null order by name limit 1),"
        "'job',(select to_jsonb(o) from public.work_orders o where id='OT-31'),"
        "'rental',(select to_jsonb(r) from public.reservations r where folio_number=6),"
        "'collection',(select to_jsonb(o) from public.work_orders o where id='OT-33'),"
        "'quote',(select to_jsonb(q) from public.estimate_versions q where "
        "jsonb_array_length(coalesce(q.snapshot->'lines','[]'::jsonb))>0 "
        "and exists(select 1 from public.work_orders w where w.id=q.order_id and w.status<>'Entregado') "
        "and not exists(select 1 from public.estimate_versions o where o.order_id=q.order_id and o.revision>q.revision) "
        "order by q.created_at desc limit 1),"
        "'detailQuote',(select to_jsonb(q) from public.estimate_versions q where "
        "jsonb_array_length(coalesce(q.snapshot->'lines','[]'::jsonb))>0 "
        "and not exists(select 1 from public.estimate_versions o where o.order_id=q.order_id and o.revision>q.revision) "
        "order by q.created_at desc limit 1),"
        "'approvedQuotes',(select count(*) from public.estimate_versions where status='Aprobado'),"
        "'latestQuoteStatuses',(select coalesce(jsonb_agg(q.status),'[]'::jsonb) from public.estimate_versions q where "
        "not exists(select 1 from public.estimate_versions o where o.order_id=q.order_id and o.revision>q.revision)),"
        "'clientVehicle',(select id from public.vehicles where not in_rental_fleet and ownership<>'Propio' order by id limit 1),"
        "'returnedRental',(select jsonb_build_object('vehicle_id',r.vehicle_id,'folio','ALQ-'||lpad(r.folio_number::text,5,'0')) "
        "from public.reservations r where r.rental_state='Devuelto' order by r.folio_number limit 1),"
        "'intakeOrder',(select id from public.work_orders o where status<>'Entregado' and not exists(select 1 from public.workshop_inspections i where i.order_id=o.id) order by id limit 1))")
    before = snapshot()
    browser_errors, blocked, proposals, skipped = [], [], [], []
    fake_documents = []
    fake_photo = {}
    preview_intake = False
    expect.set_options(timeout=45000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        page.on('pageerror', lambda error: browser_errors.append(str(error)))

        def protect(route):
            request = route.request
            url = urlparse(request.url)
            if url.hostname != '127.0.0.1' or url.port not in [3030, 55321]:
                route.abort()
                return
            if url.port != 55321 or '/rest/v1/' not in url.path or request.method in ['GET', 'HEAD', 'OPTIONS']:
                route.continue_()
                return
            rpc = url.path.split('/rpc/')[-1]
            payload = request.post_data_json
            if rpc == 'vehicle_case_file' and preview_intake and context['job'] and payload.get('order_id') == context['job']['id']:
                # Existing live visits may all be inspected. Preview the new-visit form without creating a visit.
                response = route.fetch()
                file = response.json()
                file['inspections'] = []
                route.fulfill(response=response, json=file)
            elif rpc == 'customer_document_list' and fake_documents and payload['customer_id'] == context['customer']['id']:
                route.fulfill(json=fake_documents)
            elif rpc in READS:
                route.continue_()
            elif rpc == 'save_customer_document':
                body = payload['payload']
                assert body['customerId'] == context['customer']['id']
                assert body['mime'] == 'image/jpeg' and body['base64'].startswith('/9j/')
                fake_photo.update(body)
                record = {'id': '00000000-0000-4000-8000-000000000001', 'customer_id': body['customerId'],
                    'kind': body['kind'], 'name': body['name'], 'mime': body['mime'], 'size': 100, 'created_at': '2026-11-09T12:00:00Z'}
                fake_documents.append(record)
                proposals.append('private identity photo upload (intercepted)')
                route.fulfill(json=record)
            elif rpc == 'customer_document_content' and payload['file_id'] == '00000000-0000-4000-8000-000000000001':
                route.fulfill(json={key: fake_photo[key] for key in ['mime', 'name', 'base64']})
            elif rpc == 'save_registry_details':
                body = payload['payload']
                assert body['id'] == context['customer']['id']
                assert body['expectedVersion'] == context['customer']['version']
                assert body['name'] == 'UI verification only - not saved'
                proposals.append('versioned customer correction (intercepted)')
                route.fulfill(json={**context['customer'], **body, 'version': body['expectedVersion'] + 1})
            elif rpc == 'receive_workshop_vehicle':
                body = payload['payload']
                assert body['newVehicle']['brand'] == 'UI verification only'
                assert not body.get('vehicleId') and not body['internalJob']
                proposals.append('atomic new customer-car intake (intercepted)')
                route.fulfill(json={'id': 'UI-NOT-SAVED', 'command': 'receive_workshop_vehicle'})
            else:
                blocked.append(rpc)
                route.abort()

        page.route(re.compile(r'^https?://'), protect)
        try:
            go(page, 'inicio/')
            page.locator('#aj-login-email').fill(env['AJ_LOCAL_OWNER_EMAIL'])
            page.locator('#aj-login-password').fill(env['AJ_LOCAL_OWNER_PASSWORD'])
            page.get_by_role('button', name='Ingresar', exact=True).click()
            try:
                expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
            except AssertionError:
                # Do not let Playwright's form snapshot print a local password on failure.
                if page.locator('#aj-login-password').count():
                    page.locator('#aj-login-password').fill('')
                raise AssertionError('The authenticated workspace did not become available; check local Auth and API health.') from None
            for width in [1440, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                for route in ['inicio', 'clientes', 'vehiculos', 'calendario', 'taller', 'presupuestos', 'cobros', 'libro-diario']:
                    go(page, route + '/')
                    assert_fits(page, f'{route} {width}px', 'main *:not(svg *), [role=dialog] *:not(svg *)')
                print('PASS: eight modules without page or internal horizontal overflow at', width)

            go(page, 'taller/')
            clients = page.locator('details').filter(has_text='Vehículos de clientes del taller').first
            assert clients.evaluate('(element) => element.open')
            page.get_by_role('button', name='Nueva entrada', exact=True).click()
            dialog = page.get_by_role('dialog')
            # The intake is a three step wizard: client, vehicle, folio. Each step is reached
            # with its own advance control before the fields of the next step become visible.
            expect(dialog.get_by_label('Cliente del trabajo', exact=True)).to_be_visible()
            dialog.get_by_label('Cliente del trabajo', exact=True).select_option(context['customer']['id'])
            dialog.get_by_role('button', name='Continuar', exact=True).click()
            # The vehicle field belongs to the second step; it is addressed through the visible one.
            vehicle_step = dialog.locator('section:not([hidden])')
            expect(vehicle_step.get_by_label('Vehículo del cliente', exact=True)).to_be_visible()
            vehicle_step.get_by_label('Vehículo del cliente', exact=True).select_option('new')
            expect(dialog).to_contain_text('fuera de la flota')
            # The step indicator draws a connector that reaches the next step circle on purpose;
            # the visible labels themselves must still fit their column.
            for step in dialog.locator('ol[aria-label="Progreso de la entrada"] li').all():
                label = step.locator('span').last
                assert label.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1'), \
                    'Wizard step label does not fit its column'
            assert_fits(page, 'new customer workshop vehicle at 320px',
                        'main *:not(svg *), [role=dialog] *:not(svg *):not(ol[aria-label="Progreso de la entrada"] li)')
            dialog.get_by_label('Marca', exact=True).fill('UI verification only')
            dialog.get_by_label('Modelo', exact=True).fill('Not a real car')
            dialog.get_by_label('Año', exact=True).fill('2020')
            dialog.get_by_role('button', name='Continuar', exact=True).click()
            review_step = dialog.locator('section:not([hidden])')
            expect(review_step.get_by_label('Motivo del ingreso', exact=True)).to_be_visible()
            review_step.get_by_label('Motivo del ingreso', exact=True).fill('Intercepted UI proposal; never reaches the database')
            dialog.screenshot(path=str(ROOT / 'new-workshop-client-car.png'))
            dialog.get_by_role('button', name='Crear folio OT', exact=True).click()
            expect(dialog).to_contain_text('La entrada quedó registrada')
            expect(dialog.get_by_role('link', name='Abrir folio OT', exact=True)).to_be_visible()

            go(page, 'clientes/')
            page.get_by_role('link', name=context['customer']['name'], exact=True).click()
            expect(page.get_by_role('heading', name=context['customer']['name'], exact=True).first).to_be_visible()
            expect(page.get_by_role('dialog')).to_have_count(0)
            page.get_by_role('navigation', name='Secciones del cliente').get_by_role('link', name='Datos y documentos', exact=True).click()
            profile = page.locator('main')
            expect(profile.get_by_role('button', name='Guardar cambios del cliente')).to_be_visible()
            profile.get_by_label('Nombre o razón social', exact=True).fill('UI verification only - not saved')
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            page.wait_for_load_state('networkidle')
            expect(profile.get_by_label('Nombre o razón social', exact=True)).to_have_value('UI verification only - not saved')
            profile.get_by_label('Motivo o evidencia de la corrección *', exact=True).fill('UI verification only')
            profile.get_by_role('button', name='Guardar cambios del cliente', exact=True).click()
            expect(page.get_by_text('Registro confirmado y vinculado al expediente.', exact=True)).to_be_visible()
            synthetic = page.evaluate("""() => {const canvas=document.createElement('canvas');canvas.width=100;canvas.height=60;
              const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,100,60);ctx.fillStyle='#222';ctx.fillText('UI TEST ONLY',5,30);return canvas.toDataURL('image/png').split(',')[1];}""")
            profile.get_by_label('Foto de DUI', exact=True).set_input_files({'name': 'synthetic.png', 'mimeType': 'image/png', 'buffer': base64.b64decode(synthetic)})
            profile.get_by_role('button', name='Guardar foto de DUI', exact=True).click()
            expect(profile.get_by_role('button', name='Ver foto de DUI', exact=True)).to_be_visible()
            profile.get_by_role('button', name='Ver foto de DUI', exact=True).click()
            # The private photo opens in its own dialog, not inside the profile panel.
            expect(page.get_by_role('img', name='Documento privado: DUI', exact=True)).to_be_visible()
            page.get_by_role('dialog').get_by_role('button', name='Cerrar', exact=True).click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            assert_fits(page, 'editable customer and private document at 320px')
            profile.screenshot(path=str(ROOT / 'customer-edit-private-photos.png'))
            page.get_by_role('link', name='Volver a clientes', exact=True).click()

            go(page, 'presupuestos/')
            # The quote list loads asynchronously; the editor only offers a saved scope afterwards.
            expect(page.get_by_text('Cargando presupuestos', exact=False)).to_have_count(0)
            page.get_by_label('Estado del presupuesto', exact=True).select_option('Aprobado')
            approved_rows = page.locator('tbody tr')
            if context['latestQuoteStatuses']:
                # The list shows the latest version of every quote; the filter must match that set.
                approved = [status for status in context['latestQuoteStatuses'] if status == 'Aprobado']
                assert approved_rows.count() == len(approved)
                assert all('Aprobado' in text for text in approved_rows.all_text_contents())
            else:
                skipped.append('approved quote rows (no quote exists in this database)')
            page.get_by_role('button', name='Nuevo presupuesto', exact=True).click()
            if context['quote']:
                # The customer and vehicle of the saved quote load its scope into the editor.
                page.get_by_label('Cliente del presupuesto', exact=True).select_option(context['quote']['customer_snapshot']['id'])
                page.get_by_label('Vehículo del presupuesto', exact=True).select_option(context['quote']['vehicle_snapshot']['id'])
                assert page.get_by_label('Descripción 1', exact=True).input_value()
                assert page.locator('.budget-line').count() == len(context['quote']['snapshot']['lines'])
            else:
                page.get_by_label('Cliente del presupuesto', exact=True).select_option(context['customer']['id'])
                page.get_by_label('Vehículo del presupuesto', exact=True).select_option(context['clientVehicle'])
                # A new quote starts with an empty first line; the seeded prefill is gone.
                expect(page.get_by_label('Descripción 1', exact=True)).to_have_value('')
                assert page.locator('.budget-line').count() == 1
                skipped.append('existing quote scope in Descripción 1 (requires a quote of an open work order)')
            assert_fits(page, 'budget editor at 320px')
            page.screenshot(path=str(ROOT / 'loaded-existing-estimate.png'))
            if context['detailQuote']:
                go(page, 'presupuestos/?id=' + context['detailQuote']['id'])
                page.evaluate("""() => {window.quoteImageTexts=[];const original=CanvasRenderingContext2D.prototype.fillText;
                  CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.quoteImageTexts.push(text);return original.call(this,text,...args);};}""")
                with page.expect_download(timeout=60000) as pending:
                    page.get_by_role('button', name='Descargar imagen para el cliente', exact=True).click()
                pending.value.save_as(ROOT / 'quote.png')
                image = (ROOT / 'quote.png').read_bytes()
                assert image.startswith(b'\x89PNG\r\n\x1a\n') and len(image) > 10000
                assert struct.unpack('>II', image[16:24]) == (1224, 1584)
                texts = page.evaluate('window.quoteImageTexts')
                assert 'TOTAL · USD' in texts and 'PRESUPUESTO DE SERVICIO' in texts
                assert not any(re.search(r'costo|ganancia|margen|unitCost', text, re.I) for text in texts)
                print('PASS: client-only PNG export downloaded without a business write')
            else:
                skipped.append('client-only PNG export of a quote (requires a seeded quote)')

            intake = context['intakeOrder'] or (context['job'] or {}).get('id')
            if intake:
                preview_intake = context['intakeOrder'] is None
                go(page, 'taller/ingreso/?id=' + intake)
                # The reception form lives in the diagnosis section of the case file.
                page.get_by_role('region', name='Fases del trabajo').get_by_role('button', name='Ingreso y diagnóstico').click()
                expect(page.get_by_label('Revisión general del vehículo (360°)', exact=True)).to_be_visible()
                assert page.locator('main form textarea').count() == 1
                assert page.locator('main form input[type=number]').count() == 0
                assert_fits(page, 'single workshop review at 320px')
            else:
                skipped.append('workshop reception review (requires a seeded work order)')
            if context['returnedRental']:
                go(page, 'vehiculos/expediente/?id=' + context['returnedRental']['vehicle_id'])
                page.get_by_role('navigation', name='Secciones del expediente').get_by_role('button', name='Historial de alquileres', exact=True).click()
                history = page.get_by_role('table', name='Historial de alquileres')
                expect(history).to_be_visible()
                row = history.locator('tbody tr').filter(has_text=context['returnedRental']['folio'])
                expect(row).to_have_count(1)
                # The dossier shows the real state of the rental it actually has.
                expect(row).to_contain_text('Alquiler finalizado')
                row.get_by_role('button', name='Ver detalle', exact=True).click()
                page.get_by_role('link', name='Abrir folio', exact=True).click()
                expect(page.get_by_text('Alquiler finalizado', exact=True).first).to_be_visible()
                expect(page.locator('dt', has_text='Devolución').first).to_be_visible()
            else:
                skipped.append('vehicle dossier real return (requires a returned rental)')
            if context['collection']:
                go(page, 'cobros/?operacion=' + context['collection']['id'])
                expect(page.locator('.collection-card')).to_contain_text('Revise el tipo de ingreso antes de facturar')
                assert page.get_by_role('button', name='Crear cargo del presupuesto', exact=True).count() == 0
            else:
                skipped.append('collection card for OT-33 (requires the seeded work order OT-33)')
            assert not blocked, blocked
            assert not browser_errors, browser_errors
        finally:
            browser.close()
    after = snapshot()
    changed = [table for table in before if before[table] != after.get(table)]
    assert not changed, 'Live records changed during the read-only UI verification: ' + ', '.join(changed)
    result = {'browserErrors': browser_errors, 'unexpectedWritesBlocked': blocked, 'interceptedProposals': proposals,
        'realBusinessWrites': 0, 'unchangedPublicTables': len(before), 'widths': [1440, 390, 320],
        'skippedRequiresSeededData': skipped,
        'removedSeededRecords': ['ALQ-00006', 'OT-31', 'OT-33', 'quote line "Descripción 1"']}
    (ROOT / 'ui-evidence.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
