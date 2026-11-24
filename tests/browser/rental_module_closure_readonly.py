"""Synthetic checks for the rental module closure: identity document modal, agreement card,
cleaned folio navigation, legacy URL resolution and the three-fact money block.
Every API request is fulfilled with local synthetic data or aborted; nothing is ever written."""
import copy
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
import rental_folio_readonly as fixture

APP = fixture.APP
ROOT = Path('test-results/rental-module-closure')
blocked, errors, downloads = [], [], []
created = []
# A one pixel PNG is enough to prove that the document is rendered inside the modal.
PHOTO = ('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==')
document = {'id': 'fixture-document-dui', 'customer_id': fixture.customer['id'], 'kind': 'DUI',
            'name': 'DUI.jpg', 'mime': 'image/png', 'size': 1024,
            'created_at': (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()}


def protect(route):
    request = route.request
    url = urlparse(request.url)
    resource = url.path.split('/')[-1]
    if '/rest/v1/rpc/' in url.path:
        # The private identity files are synthetic: the authorization path is never contacted.
        if resource == 'customer_document_list':
            route.fulfill(json=[document])
            return
        if resource == 'customer_document_content':
            route.fulfill(json={'mime': 'image/png', 'base64': PHOTO})
            return
        if resource == 'execute_reservation_command':
            body = request.post_data_json
            command = body.get('command')
            if command in ['create', 'confirm']:
                # The reservation is created and confirmed locally; no server is contacted.
                created.append(copy.deepcopy(body))
                record = dict(fixture.booking)
                record.update(id=fixture.FIXTURE_ID, version=1 if command == 'create' else 2,
                              status='Borrador' if command == 'create' else 'Confirmada',
                              rental_state='Preparado', folio_number=99001,
                              customer_snapshot=fixture.customer, vehicle_snapshot=fixture.vehicle,
                              customer_id=fixture.customer['id'], vehicle_id=fixture.vehicle['id'])
                route.fulfill(json=record)
                return
    fixture.protect(route)


def open_folio(page, section=None):
    path = '/alquileres/folio/?id=' + fixture.FIXTURE_ID + ('&seccion=' + section if section else '')
    page.goto(APP + path, wait_until='networkidle')
    expect(page.get_by_role('heading', level=1, name=re.compile('ALQ-99001'))).to_be_visible()


def fits(page, name, full=True):
    for width in [1440, 1024, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), \
            'Horizontal overflow at ' + str(width) + 'px in ' + name
        page.evaluate('window.scrollTo(0, 0)')
        page.screenshot(path=str(ROOT / f'{name}-{width}.png'), full_page=full)


def documents_checks(page):
    page.goto(APP + '/clientes/expediente/?id=' + fixture.customer['id'] + '&seccion=Datos+y+documentos',
              wait_until='networkidle')
    profile = page.locator('main')
    expect(profile.get_by_role('heading', name='Documentos de identidad', exact=True)).to_be_visible()
    expect(profile.get_by_text('Fotos privadas de DUI y licencia', exact=False)).to_be_visible()
    # One card per document kind and an honest empty state for the missing licence.
    expect(profile.get_by_role('heading', name='Documento de identidad (DUI)', exact=True)).to_be_visible()
    expect(profile.get_by_role('heading', name='Licencia de conducir', exact=True)).to_be_visible()
    expect(profile.get_by_text('Sin foto registrada', exact=True)).to_be_visible()
    expect(profile.get_by_role('button', name='Ver foto de Licencia', exact=True)).to_have_count(0)

    trigger = profile.get_by_role('button', name='Ver foto de DUI', exact=True)
    expect(trigger).to_be_visible()
    trigger.click()
    dialog = page.get_by_role('dialog')
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role('heading', name='DUI · ' + fixture.customer['name'])).to_be_visible()
    expect(dialog.get_by_role('img', name='Documento privado: DUI', exact=True)).to_be_visible()
    # The photo is inside the modal: it is not appended under the list of documents.
    assert page.locator('main img[alt="Documento privado: DUI"]').count() == 0, \
        'the photo is still appended under the list of documents'
    assert dialog.locator('img[alt="Documento privado: DUI"]').count() == 1
    page.screenshot(path=str(ROOT / 'identity-modal-1440.png'))
    # Escape closes the modal and the focus returns to the trigger.
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(trigger).to_be_focused()
    # The keyboard alone opens the same modal.
    trigger.press('Enter')
    expect(page.get_by_role('dialog')).to_be_visible()
    page.get_by_role('button', name='Cerrar', exact=True).click()
    expect(page.get_by_role('dialog')).not_to_be_visible()
    expect(trigger).to_be_focused()
    fits(page, 'identity-documents')


def stage(page, label):
    # The circles are the only navigation of the folio.
    return page.get_by_role('region', name='Fases del folio').get_by_role('button', name=re.compile('^' + label + ':'))


def agreement_checks(page):
    open_folio(page)
    # There is one navigation: the ordered stages. The old tab bar is gone.
    expect(page.get_by_role('navigation', name='Secciones del alquiler')).to_have_count(0)
    progress = page.get_by_role('region', name='Fases del folio')
    expect(progress.get_by_role('button')).to_have_count(5)
    for label in ['Acuerdo', 'Alquilado', 'Devolución', 'Cuentas', 'Finalizado']:
        expect(progress.get_by_role('button', name=re.compile('^' + label + ':'))).to_be_visible()
    expect(page.locator('main')).not_to_contain_text('Consulta y gestión del folio')
    # The agreement belongs to the first stage of the flow.
    stage(page, 'Acuerdo').click()
    agreement = page.get_by_role('region', name='Acuerdo del alquiler')
    expect(agreement).to_be_visible()
    for fact in ['Cliente', 'Vehículo', 'Entrega prevista', 'Devolución prevista', 'Duración',
                 'Tarifa diaria', 'Total acordado', 'Estado del alquiler', 'Estado del vehículo']:
        expect(agreement).to_contain_text(fact)
    expect(agreement).to_contain_text(fixture.customer['name'])
    expect(agreement).to_contain_text('$50.00')
    # The client document is offered at agreement time.
    expect(agreement.get_by_role('heading', name='Descargar el detalle para el cliente')).to_be_visible()
    expect(agreement.get_by_role('button', name='Descargar detalle (PDF)', exact=True)).to_be_visible()
    expect(agreement.get_by_text('no emite importes a cobrar, no registra cobros', exact=False)).to_be_visible()
    with page.expect_download(timeout=60000) as pending:
        agreement.get_by_role('button', name='Descargar detalle (PDF)', exact=True).click()
    pending.value.save_as(ROOT / 'client-detail.pdf')
    downloads.append('client-detail.pdf')
    page.evaluate('window.scrollTo(0, 0)')
    page.screenshot(path=str(ROOT / 'agreement-card-1440.png'), full_page=True)


def delivery_checks(page):
    # The return stage holds the delivery or the return of the vehicle, and nothing else.
    stage(page, 'Devolución').click()
    section = page.get_by_role('region', name='Devolución del vehículo')
    expect(section).to_be_visible()
    expect(section.get_by_role('heading', name='Registrar devolución del vehículo')).to_be_visible()
    # The duplicated client document and the cleaning review are gone from the folio.
    expect(page.get_by_role('heading', name='Entregar el detalle al cliente', exact=True)).to_have_count(0)
    expect(page.get_by_role('heading', name='Limpieza y liberación del vehículo', exact=True)).to_have_count(0)
    expect(page.locator('main')).not_to_contain_text('Limpieza')
    expect(page.locator('main')).not_to_contain_text('limpieza')
    # One primary action: the readings and the registration of the return.
    expect(section.get_by_role('button', name='Iniciar devolución', exact=True)).to_have_count(1)
    expect(section.get_by_role('button', name='Registrar devolución', exact=True)).to_have_count(0)
    page.evaluate('window.scrollTo(0, 0)')
    page.screenshot(path=str(ROOT / 'delivery-1440.png'), full_page=True)


def accounts_checks(page):
    stage(page, 'Cuentas').click()
    accounts = page.get_by_role('region', name='Cuentas del alquiler')
    expect(accounts).to_be_visible()
    # Three facts lead the section, each with its own plain explanation.
    for fact in ['Lo acordado', 'Lo cobrado', 'Lo pendiente']:
        expect(accounts.get_by_text(fact, exact=True)).to_be_visible()
    expect(accounts).to_contain_text('$350.00')
    expect(accounts).to_contain_text('$40.00')
    expect(accounts).to_contain_text('$80.00')
    expect(accounts).to_contain_text('El documento de cobro de ese importe es lo que deja el saldo pendiente registrado')
    expect(accounts).to_contain_text('Un anticipo sin aplicar todavía no cuenta aquí')
    # The pending amount tells the operator what the customer still owes.
    expect(accounts.get_by_test_id('reconciliation-alarm')).to_contain_text('Facturado $120.00 de $350.00 acordados')
    expect(accounts.get_by_test_id('reconciliation-alarm')).to_contain_text('faltan $230.00 por emitir')
    expect(accounts).to_contain_text('Pendiente del documento emitido: $80.00')
    expect(accounts).not_to_contain_text('Sin saldo pendiente')
    expect(accounts).not_to_contain_text('cargo')
    # The same difference is never stated twice: the alarm replaced the sentence about it.
    expect(accounts).not_to_contain_text('Pendiente de emitir el documento de cobro: $230.00')
    expect(accounts).not_to_contain_text('todavía falta emitir $230.00')
    # The technical detail stays available, collapsed.
    detail = accounts.get_by_text('Detalle de importes', exact=True)
    expect(detail).to_be_visible()
    expect(accounts.get_by_text('Importes emitidos al cliente', exact=True)).not_to_be_visible()
    detail.click()
    expect(accounts.get_by_text('Importes emitidos al cliente', exact=True)).to_be_visible()
    expect(accounts.get_by_text('Cobros aplicados (netos)', exact=True)).to_be_visible()
    expect(accounts.get_by_text('Saldo pendiente del documento de cobro', exact=True)).to_be_visible()
    expect(accounts.get_by_text('Anticipos por aplicar', exact=True)).to_be_visible()
    # The place that states what is owed is also where the amount is issued: a modal with the
    # agreed facts at hand, never an inline form that asks the operator to retype them.
    issue = accounts.get_by_role('button', name='Emitir importe a cobrar', exact=True)
    expect(issue).to_be_visible()
    expect(page.get_by_role('dialog')).to_have_count(0)
    issue.click()
    dialog = page.get_by_role('dialog')
    expect(dialog.get_by_role('heading', name='Emitir importe a cobrar', exact=True)).to_be_visible()
    expect(dialog).to_contain_text('Registra el documento de cobro de este período')
    expect(dialog).not_to_contain_text('cargo')
    expect(dialog.get_by_role('region', name='Datos ya conocidos del período')).to_contain_text('$350.00')
    expect(dialog.get_by_label('Importe del período USD', exact=True)).to_have_value('230.00')
    expect(dialog.get_by_text('Modificar las fechas del período', exact=True)).to_be_visible()
    expect(dialog.get_by_label('Período desde (inclusive)', exact=True)).not_to_have_value('')
    expect(dialog.get_by_label('Período hasta (inclusive)', exact=True)).not_to_have_value('')
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).to_have_count(0)
    fits(page, 'accounts')


def closing_checks(page):
    """The closing stage is a summary: one status line, collapsed optional extras and,
    while the vehicle is retained, one action that leads to the vehicle dossier."""
    fixture.booking.update(rental_state='Devuelto',
                           actual_return_at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
                           ends_at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat())
    fixture.vehicle.update(status='En taller', readiness_hold=True)
    fixture.commitments[:] = [{'id': 'fixture-closing-cleaning', 'reservation_id': fixture.FIXTURE_ID,
                               'vehicle_id': fixture.vehicle['id'], 'order_id': None, 'kind': 'Limpieza',
                               'active': True, 'starts_at': (datetime.now(timezone.utc) - timedelta(hours=20)).isoformat(),
                               'ends_at': (datetime.now(timezone.utc) - timedelta(hours=19)).isoformat(),
                               'reason': 'Revisión posterior a devolución'}]
    open_folio(page)
    stage(page, 'Finalizado').click()
    closing = page.get_by_role('region', name='Cierre del alquiler')
    expect(closing).to_be_visible()
    # ONE status: the facts are stated once and the detail list does not repeat the state.
    expect(closing).to_contain_text('cerrado operativamente')
    assert closing.get_by_text('Estado del alquiler', exact=True).count() == 0, \
        'the rental state is still duplicated in the closing detail list'
    expect(closing).to_contain_text('Pendiente por cobrar: $310.00')
    # The release is confirmed inline: an obvious action with its reason field, no navigation.
    release = closing.get_by_role('region', name='Liberación del vehículo', exact=True)
    expect(release).to_be_visible()
    expect(release.get_by_role('button', name='Confirmar entrega y liberar el vehículo', exact=True)).to_be_visible()
    assert closing.get_by_role('link', name='Liberar el vehículo', exact=True).count() == 0, \
        'the closing stage still sends the operator to the vehicle dossier'
    expect(release).to_contain_text('no cobra nada')
    # The three secondary blocks stay collapsed and clearly optional; no empty input shows.
    hints = ['Opcional · registre un gasto solo si pagó algo de este alquiler',
             'Opcional · guarde fotos o soportes',
             'Opcional · condiciones y aceptación del contrato']
    for hint in hints:
        # The extras are siblings of the summary panel inside the folio, not its children.
        block = page.locator('main details').filter(has_text=hint)
        assert block.count() == 1, hint
        expect(block.locator('summary')).to_contain_text(hint)
        assert block.locator('input, textarea').first.is_visible() is False, \
            'a required-looking input is visible before opening ' + hint
    # No primary button is visible before opening any collapsed block, except the
    # inline release confirm, which is the one meaningful action of this stage.
    assert primary_buttons(page) == ['Confirmar entrega y liberar el vehículo'], primary_buttons(page)
    page.evaluate('window.scrollTo(0, 0)')
    page.screenshot(path=str(ROOT / 'closing-collapsed-1440.png'), full_page=True)
    # The contract block keeps its commands under the plain wording.
    contract = page.locator('main details').filter(has_text='Opcional · condiciones y aceptación del contrato')
    contract.locator('summary').click()
    expect(contract).to_contain_text('no cobra nada y no entrega el vehículo')
    expect(contract.get_by_role('button', name='Guardar versión de contrato', exact=True)).to_be_visible()
    fits(page, 'closing-stage')


def primary_buttons(page):
    """Visible buttons whose own background is the brand red (the primary style)."""
    return page.evaluate("""() => {
      const visible = element => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden'
          && style.display !== 'none' && Number(style.opacity) > 0;
      };
      const isPrimary = element => {
        const match = getComputedStyle(element).backgroundColor.match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
        if (!match) return false;
        const [, red, green, blue] = match.map(Number);
        return red > 150 && green < 90 && blue < 100;
      };
      return Array.from(document.querySelectorAll('main button'))
        .filter(visible).filter(isPrimary).map(button => button.textContent.trim());
    }""")


def legacy_checks(page):
    # The legacy billing URL lands in the Cuentas stage with the billing detail inside it.
    for legacy in ['Cargos y abonos', 'Períodos y abonos']:
        open_folio(page, legacy.replace(' ', '%20'))
        expect(page.get_by_role('region', name='Cuentas del alquiler')).to_be_visible()
    # The legacy cleaning URL lands on the return stage; the release is inline there
    # for a returned rental and the folio never sends the operator to the dossier.
    open_folio(page, 'Limpieza')
    expect(page.get_by_role('region', name='Devolución del vehículo')).to_be_visible()
    assert page.get_by_role('link', name='Confirmar entrega y liberar el vehículo →', exact=True).count() == 0, \
        'the return stage still links to the vehicle dossier for the release'
    expect(page.locator('main')).not_to_contain_text('Limpieza')


def wizard_checks(page):
    page.goto(APP + '/alquileres/nuevo/', wait_until='networkidle')
    expect(page.get_by_role('heading', name='Nuevo alquiler', exact=True)).to_be_visible()
    page.get_by_label('Cliente del alquiler', exact=True).select_option(fixture.customer['id'])
    page.get_by_label('Vehículo del alquiler', exact=True).select_option(fixture.vehicle['id'])
    page.get_by_label('Entrega prevista', exact=True).fill('2030-01-01T08:00')
    page.get_by_label('Devolución prevista', exact=True).fill('2030-01-03T08:00')
    page.get_by_label('Tarifa diaria acordada (USD)', exact=True).fill('50')
    page.get_by_label('Limpieza posterior (minutos)', exact=True).fill('60')
    page.get_by_role('button', name='Revisar acuerdo', exact=True).click()
    page.get_by_role('button', name='Guardar borrador', exact=True).click()
    expect(page.locator('main')).to_contain_text('Borrador guardado')
    # The client detail exists at agreement time, in the final stage of the wizard.
    detail = page.get_by_role('region', name='Detalle del alquiler para el cliente')
    expect(detail).to_be_visible()
    expect(detail).to_contain_text('antes de entregar el vehículo')
    expect(detail.get_by_role('button', name='Descargar detalle (PDF)', exact=True)).to_be_visible()
    with page.expect_download(timeout=60000) as pending:
        detail.get_by_role('button', name='Descargar detalle (PDF)', exact=True).click()
    pending.value.save_as(ROOT / 'client-detail-wizard.pdf')
    downloads.append('client-detail-wizard.pdf')
    page.evaluate('window.scrollTo(0, 0)')
    page.screenshot(path=str(ROOT / 'wizard-1440.png'), full_page=True)
    # Confirming the reservation navigates to the folio and never issues money.
    page.get_by_role('button', name='Confirmar reserva y abrir folio', exact=True).click()
    page.wait_for_url('**/alquileres/folio/**')
    assert [command['command'] for command in created] == ['create', 'confirm'], created


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    public_url = next(line.split('=', 1)[1].strip().strip('"')
                      for line in Path('.env.local').read_text(encoding='utf8').splitlines()
                      if line.startswith('NEXT_PUBLIC_SUPABASE_URL='))
    storage_key = 'sb-' + urlparse(public_url).hostname.split('.')[0] + '-auth-token'
    session = {'access_token': 'synthetic-token-never-sent-to-server', 'refresh_token': 'synthetic-refresh',
               'expires_at': 4102444800, 'expires_in': 3600, 'token_type': 'bearer',
               'user': {'id': fixture.USER_ID, 'email': 'fixture@example.invalid',
                        'aud': 'authenticated', 'role': 'authenticated', 'app_metadata': {}, 'user_metadata': {}}}
    fixture.mode.update(finance=True, fail=False, denied=set())
    now = datetime.now(timezone.utc)
    fixture.booking.update(starts_at=(now - timedelta(days=2)).isoformat(),
                           ends_at=(now + timedelta(days=5)).isoformat(),
                           status='Confirmada', rental_state='Entregado', total=350, daily_rate=50)
    expect.set_options(timeout=30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.route(re.compile(r'^https?://'), protect)
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' + json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            documents_checks(page)
            agreement_checks(page)
            delivery_checks(page)
            accounts_checks(page)
            legacy_checks(page)
            wizard_checks(page)
            closing_checks(page)
            fits(page, 'folio')
            assert not errors, errors
            assert not blocked, blocked
            assert downloads, 'the client document was never downloaded'
        except Exception:
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    main()
