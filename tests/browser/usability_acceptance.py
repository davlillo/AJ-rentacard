"""Read-only checks of the real-data workspace, including inner-container overflow."""
import json
import re
from pathlib import Path
from playwright.sync_api import expect, sync_playwright


def assert_fits(page, context: str) -> None:
    issues = page.evaluate("""() => {
      const issues = [];
      if (document.documentElement.scrollWidth > innerWidth + 2) issues.push('page');
      for (const el of document.querySelectorAll('main *, [role=dialog] *')) {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (r.width < 4 || r.height < 4 || r.right <= 0 || s.display === 'none' ||
            s.visibility === 'hidden' || el.closest('.sr-only, [aria-hidden=true]') ||
            ['INPUT','TEXTAREA','SELECT','OPTION','SVG','PATH'].includes(el.tagName)) continue;
        if (el.scrollWidth > el.clientWidth + 3 && el.clientWidth > 0)
          issues.push(el.tagName + '.' + String(el.className).slice(0,90) + ':' + el.scrollWidth + '/' + el.clientWidth);
        if (r.right > innerWidth + 3 || r.left < -3) issues.push('outside:' + el.tagName + '.' + String(el.className).slice(0,60));
      }
      return [...new Set(issues)].slice(0,20);
    }""")
    assert not issues, context + ': ' + json.dumps(issues)


def main() -> None:
    config = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf-8').splitlines()
                  if '=' in line and not line.startswith('#'))
    assert config['NEXT_PUBLIC_SUPABASE_URL'] == 'http://127.0.0.1:55321'
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True, reduced_motion='reduce')
        errors: list[str] = []
        mutations: list[str] = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: mutations.append(request.url) if re.search(
            r'/rpc/(execute_|record_|issue_|save_|collect_|pay_|stage_|publish_|review_)', request.url) else None)
        try:
            page.goto('http://127.0.0.1:3030/inicio', wait_until='networkidle')
            page.get_by_label('Correo electrónico', exact=True).fill(config['AJ_LOCAL_OWNER_EMAIL'])
            page.get_by_label('Contraseña', exact=True).fill(config['AJ_LOCAL_OWNER_PASSWORD'])
            with page.expect_response(lambda response: '/auth/v1/token?grant_type=password' in response.url) as sign_in:
                page.get_by_role('button', name='Ingresar', exact=True).click()
            assert sign_in.value.status == 200, f'Local Auth returned HTTP {sign_in.value.status}; retry after heavy test workloads finish.'
            expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
            page.wait_for_load_state('networkidle')
            nav = page.get_by_role('navigation', name='Navegación principal', exact=True)
            expect(nav.get_by_role('link')).to_have_count(8)
            assert nav.get_by_role('link').all_text_contents() == [
                'Inicio', 'Clientes', 'Vehículos', 'Calendario', 'Taller', 'Presupuestos', 'Cargos y cobros', 'Libro diario']
            expect(page.locator('.business-metric')).to_have_count(4)
            assert 'Supabase' not in page.locator('main').inner_text()

            for width, height in [(1440, 1000), (768, 1024), (390, 844), (320, 740)]:
                page.set_viewport_size({'width': width, 'height': height})
                for route in ['inicio', 'clientes', 'vehiculos', 'taller', 'presupuestos', 'calendario', 'cobros', 'libro-diario']:
                    page.goto('http://127.0.0.1:3030/' + route, wait_until='networkidle')
                    expect(page.locator('main h1')).to_be_visible()
                    assert_fits(page, f'{width}px {route}')
                    page.screenshot(path=f'test-results/real-ui-{route}-{width}.png', full_page=True)
                    if route == 'clientes':
                        expect(page.locator('tbody tr')).to_have_count(10)
                        page.get_by_role('button', name='Siguiente', exact=True).click()
                        expect(page.locator('tbody tr')).to_have_count(6)
                        page.get_by_role('button', name='Anterior', exact=True).click()
                        page.get_by_placeholder('Buscar nombre, teléfono o documento…').fill('Rafael')
                        expect(page.locator('tbody').first).to_contain_text('Rafael Vargas')
                        page.get_by_role('button', name='Ver cliente Rafael Vargas', exact=True).click()
                        expect(page.get_by_role('dialog')).to_contain_text('Sin registrar')
                        assert_fits(page, f'{width}px customer dialog')
                        page.get_by_text('Completar o corregir datos', exact=True).click()
                        assert_fits(page, f'{width}px verified customer form')
                        page.get_by_role('button', name='Cerrar', exact=True).click()
                    if route == 'vehiculos':
                        tabs = page.get_by_role('tablist', name='Estado de la flota', exact=True)
                        expect(tabs.get_by_role('tab')).to_have_count(4)
                        expect(page.locator('.vehicle-card')).to_have_count(12)
                        expect(page.locator('.vehicle-no-photo')).to_have_count(0)
                        expect(page.locator('.vehicle-card').first).to_contain_text('Por confirmar')
                        page.get_by_role('button', name='Siguiente', exact=True).click()
                        assert_fits(page, f'{width}px fleet second page')
                        page.get_by_role('button', name='Agregar vehículo', exact=True).click()
                        dialog = page.get_by_role('dialog')
                        assert dialog.get_by_label('Kilometraje (si se conoce)', exact=True).get_attribute('required') is None
                        assert dialog.get_by_label('Tarifa diaria de renta (opcional)', exact=True).get_attribute('required') is None
                        assert_fits(page, f'{width}px vehicle registration with unknown facts')
                        dialog.get_by_role('button', name='Cancelar', exact=True).click()
                    if route == 'taller':
                        page.get_by_label('Estado de los trabajos', exact=True).select_option('Por recibir')
                        expect(page.locator('tbody').first).to_contain_text('Rafael Vargas')
                        assert_fits(page, f'{width}px unreceived work')
                        page.get_by_role('button', name='Tareas', exact=True).click()
                        expect(page.get_by_label('Trabajo para las tareas', exact=True)).to_be_visible()
                    if route == 'presupuestos':
                        expect(page.locator('tbody')).to_contain_text('Rafael Vargas')
                        expect(page.locator('tbody')).to_contain_text('$2,190.00')
                        page.get_by_role('button', name='Ver detalle', exact=True).click()
                        expect(page.locator('.document-folio')).to_have_text(re.compile(r'^PRE-\d{5,}$'))
                        expect(page.locator('.source-reconciliation')).to_contain_text('$1,440.00')
                        assert_fits(page, f'{width}px real quote detail')
                        page.screenshot(path=f'test-results/real-ui-quote-detail-{width}.png', full_page=True)
                        page.get_by_role('button', name='Nuevo presupuesto', exact=True).click()
                        page.get_by_label('Cliente del presupuesto', exact=True).select_option(label='Rafael Vargas')
                        page.get_by_label('Trabajo del presupuesto', exact=True).fill('Reparación delantera')
                        page.get_by_label('Descripción 1', exact=True).fill('Material de reparación')
                        page.get_by_label('Cantidad 1', exact=True).fill('2')
                        page.get_by_label('Precio unitario 1', exact=True).fill('45')
                        page.get_by_role('button', name='Agregar mano de obra', exact=True).click()
                        page.get_by_label('Descripción 2', exact=True).fill('Mano de obra')
                        page.get_by_label('Precio unitario 2', exact=True).fill('45')
                        page.get_by_label('Descuento', exact=True).fill('5')
                        expect(page.locator('.grand-total')).to_contain_text('$130.00')
                        assert_fits(page, f'{width}px quote editor')
                        page.evaluate('window.scrollTo(0, 0)')
                        page.screenshot(path=f'test-results/real-ui-quote-editor-{width}.png', full_page=True)
                        page.get_by_role('button', name='Cancelar', exact=True).click()
                        page.get_by_role('button', name='Nuevo presupuesto', exact=True).click()
                        page.get_by_label('Mantenimiento interno de la flota', exact=True).check()
                        expect(page.get_by_label('Precio unitario 1', exact=True)).to_have_count(0)
                        page.get_by_label('Cantidad 1', exact=True).fill('2')
                        page.get_by_label('Costo unitario 1', exact=True).fill('50')
                        page.get_by_role('button', name='Agregar mano de obra', exact=True).click()
                        page.get_by_label('Costo unitario 2', exact=True).fill('20')
                        expect(page.locator('.grand-total')).to_contain_text('$120.00')
                        expect(page.get_by_label('Descuento', exact=True)).to_have_count(0)
                        assert_fits(page, f'{width}px internal cost-only budget')
                        page.get_by_role('button', name='Cancelar', exact=True).click()
                    if route == 'calendario':
                        for section in ['Reservas', 'Bloqueos', 'Agenda']:
                            page.get_by_role('button', name=section, exact=True).click()
                            assert_fits(page, f'{width}px calendar {section}')
                    if route in ['calendario', 'presupuestos', 'cobros', 'libro-diario']:
                        page.get_by_role('button', name='Archivo original', exact=True).click()
                        expect(page.get_by_role('region', name='Datos del archivo original', exact=True)).to_be_visible()
                        expect(page.get_by_role('button', name='Descargar original', exact=True)).to_be_visible()
                        expect(page.locator('article').first).to_be_visible()
                        assert_fits(page, f'{width}px {route} source facts')
                        page.screenshot(path=f'test-results/real-ui-{route}-source-{width}.png', full_page=True)
                        if route == 'presupuestos':
                            page.get_by_label('Sección del archivo', exact=True).select_option('Resumen del archivo')
                            expect(page.locator('article')).to_contain_text(['$1,856.00', '$334.00', '$750.00', '$1,440.00'])
                print(f'PASS: eight modules and real source facts at {width}px; no page or inner horizontal overflow.')

            page.goto('http://127.0.0.1:3030/presupuestos', wait_until='networkidle')
            page.get_by_role('button', name='Ver detalle', exact=True).click()
            page.get_by_role('link', name='Abrir expediente del trabajo →', exact=True).click()
            expect(page.locator('main h1')).to_contain_text('OT-')
            for section in ['Resumen', 'Recepción', 'Presupuestos', 'Costos', 'Cargos y abonos', 'Fotos y documentos', 'Tareas', 'Salida']:
                page.get_by_role('button', name=section, exact=True).click()
                page.wait_for_load_state('networkidle')
                assert_fits(page, '320px workshop case ' + section)
            page.screenshot(path='test-results/real-ui-case-320.png', full_page=True)
            print('PASS: source quote links to its workshop case; all eight case sections fit at 320px.')

            page.goto('http://127.0.0.1:3030/vehiculos', wait_until='networkidle')
            page.get_by_role('button', name='Abrir menú', exact=True).click()
            expect(page.locator('.mobile-overlay')).to_be_visible()
            nav.get_by_role('link', name='Clientes', exact=True).click()
            expect(page.get_by_role('heading', name='Clientes', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='Abrir menú', exact=True)).to_have_attribute('aria-expanded', 'false')
            assert not errors, str(errors)
            assert not mutations, 'Read-only acceptance attempted a business mutation.'
            print('PASS: readable real folios, clear budget totals, pagination and navigation; no fixture records created.')
        except Exception as error:
            page.screenshot(path='test-results/real-ui-failure.png', full_page=True,
                            mask=[page.locator('#aj-login-email'), page.locator('#aj-login-password')])
            safe = str(error).replace(config['AJ_LOCAL_OWNER_PASSWORD'], '[REDACTED]')
            safe = safe.replace(config['AJ_LOCAL_OWNER_EMAIL'], '[LOCAL USER]')
            raise RuntimeError(safe) from None
        finally:
            browser.close()


if __name__ == '__main__':
    main()
