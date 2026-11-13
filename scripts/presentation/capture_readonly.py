"""Capture presenter evidence without submitting business mutations."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path('test-results/presentation')
ROOT.mkdir(parents=True, exist_ok=True)
env = dict(line.split('=', 1) for line in Path('.env.local').read_text(encoding='utf8').splitlines()
           if '=' in line and not line.startswith('#'))
manifest = json.loads(Path('test-results/local-workspace/manifest.json').read_text(encoding='utf8'))
mutations = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')

    def protect(route):
        url = route.request.url
        if not url.startswith(('http://127.0.0.1:3030/', 'http://127.0.0.1:55321/')):
            route.abort()
            return
        if '/rpc/' in url and any('/rpc/' + name in url for name in [
                'execute_', 'record_', 'save_', 'issue_', 'deliver_', 'stage_', 'review_', 'link_']):
            mutations.append(url.split('/rpc/')[1])
            route.abort()
            return
        route.continue_()

    page.route('**/*', protect)
    try:
        page.goto('http://127.0.0.1:3030/inicio', wait_until='networkidle')
        page.get_by_label('Correo electrónico', exact=True).fill(env['AJ_LOCAL_OWNER_EMAIL'])
        page.get_by_label('Contraseña', exact=True).fill(env['AJ_LOCAL_OWNER_PASSWORD'])
        page.get_by_role('button', name='Ingresar', exact=True).click()
        expect(page.get_by_role('heading', name='Resumen del negocio', exact=True)).to_be_visible()
        page.wait_for_load_state('networkidle')
        page.screenshot(path=str(ROOT / 'inicio.png'))
        page.goto('http://127.0.0.1:3030/libro-diario', wait_until='networkidle')
        page.get_by_role('button', name='Hoy', exact=True).click()
        page.get_by_label('Cuenta o caja', exact=True).select_option('Caja principal')
        page.wait_for_load_state('networkidle')
        page.screenshot(path=str(ROOT / 'diario.png'))
        page.get_by_role('button', name='Registrar cobro', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.locator('fieldset')).to_be_enabled()
        label = 'Folio de taller o contrato del cobro (opcional)'
        select = dialog.get_by_label(label, exact=True)
        initial = select.locator('option').all_text_contents()
        dialog.get_by_label('Cliente del cobro', exact=True).select_option(manifest['customers'][5])
        after = select.locator('option').all_text_contents()
        select.select_option('order:' + manifest['activeJobs'][0])
        targets = dialog.get_by_label('Destino del abono', exact=True).locator('option').all_text_contents()
        page.wait_for_load_state('networkidle')
        dialog.screenshot(path=str(ROOT / 'cobro-folio.png'))
        dialog.get_by_role('button', name='Cerrar', exact=True).click()
        diary_label = 'Folio de taller o contrato de alquiler'
        page.get_by_label(diary_label, exact=True).select_option('order:' + manifest['activeJobs'][0])
        page.wait_for_load_state('networkidle')
        page.get_by_role('button', name='Registrar cobro', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.locator('fieldset')).to_be_enabled()
        contextual = dialog.inner_text()
        contextual_picker = dialog.get_by_label(label, exact=True).count()
        dialog.screenshot(path=str(ROOT / 'cobro-contexto.png'))
        dialog.get_by_role('button', name='Cerrar', exact=True).click()
        page.get_by_label(diary_label, exact=True).select_option('')
        page.get_by_role('button', name='Registrar cobro', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.locator('fieldset')).to_be_enabled()
        dialog.get_by_label('Cliente del cobro', exact=True).select_option(manifest['customers'][6])
        escape_operations = dialog.get_by_label(label, exact=True).locator('option').all_text_contents()
        dialog.get_by_label(label, exact=True).select_option('order:' + manifest['activeJobs'][1])
        escape_targets = dialog.get_by_label('Destino del abono', exact=True).locator('option').all_text_contents()
        dialog.get_by_role('button', name='Cerrar', exact=True).click()
        page.goto('http://127.0.0.1:3030/vehiculos', wait_until='networkidle')
        page.screenshot(path=str(ROOT / 'flota.png'))
        page.goto('http://127.0.0.1:3030/calendario', wait_until='networkidle')
        page.get_by_role('region', name='Planificación Gantt de vehículos', exact=True).screenshot(path=str(ROOT / 'gantt.png'))
        assert not mutations, str(mutations)
    finally:
        browser.close()

report = {'beforeChoosingCustomer': initial, 'afterChoosingMiguel': after, 'miguelChargeTargets': targets,
          'contextualPickerCount': contextual_picker, 'contextualText': contextual,
          'escapeOperations': escape_operations, 'escapeChargeTargets': escape_targets,
          'blockedBusinessWrites': mutations}
(ROOT / 'receipt-probe.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps(report, ensure_ascii=False, indent=2))
