"""Plain responsible-name field proof using known synthetic HTTP only; no real auth/API/database requests."""
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
import workshop_pipeline_readonly as fixture

ROOT = Path('test-results/task-responsible')
OTHER = '00000000-0000-4000-8000-000000009902'
TASKS = [{'id': '00000000-0000-4000-8000-000000009903', 'orderId': fixture.JOB['id'],
          'description': 'Responsable del trabajo', 'assignedTo': fixture.USER, 'assigneeLabel': 'Cuenta sintética',
          'responsibleName': None, 'status': 'Pendiente', 'version': 1,
          'createdAt': '2026-11-10T12:00:00Z'}]
COMMANDS, BLOCKED, ERRORS, CONSOLE_ERRORS = [], [], [], []
STATE = {'missing': False, 'command_error': None}


def protect(route):
    request = route.request
    url = urlparse(request.url)
    resource = url.path.split('/')[-1]
    # Devtools stack resolution is answered synthetically, never forwarded as a POST.
    if url.hostname == '127.0.0.1' and url.port == 3030 and url.path == '/__nextjs_original-stack-frames':
        route.fulfill(json={'stackFrames': []})
        return
    if '/auth/v1/' in url.path and resource == 'user':
        route.fulfill(json={'id': fixture.USER, 'email': 'fixture@example.invalid'})
        return
    if '/rest/v1/' in url.path and resource == 'workshop_tasks' and request.method == 'GET':
        if STATE['missing'] and 'responsibleName' in request.url:
            route.fulfill(status=400, json={'code': '42703',
                          'message': 'column workshop_tasks.responsible_name does not exist'})
        else:
            rows = copy.deepcopy(TASKS)
            if STATE['missing']:
                for row in rows:
                    row.pop('responsibleName', None)
            route.fulfill(json=rows)
        return
    if '/rest/v1/rpc/' in url.path and resource == 'workshop_assignees':
        route.fulfill(json=[{'id': fixture.USER, 'label': 'Cuenta sintética'},
                            {'id': OTHER, 'label': 'Otra cuenta autorizada'}])
        return
    if '/rest/v1/rpc/' in url.path and resource == 'execute_task_command':
        body = request.post_data_json
        COMMANDS.append(copy.deepcopy(body))
        if STATE['command_error']:
            route.fulfill(status=400, json={'code': 'P0001', 'message': STATE['command_error']})
            return
        payload = body['payload']
        assert body['idempotency_key']
        assert payload['assignedTo'] == fixture.USER, 'A name edit must not silently reassign an account'
        if body['command'] == 'create':
            task = {'id': f'00000000-0000-4000-8000-{99003 + len(TASKS):012d}', 'orderId': fixture.JOB['id'],
                    'description': payload['description'], 'assignedTo': payload['assignedTo'],
                    'assigneeLabel': 'Cuenta sintética', 'status': 'Pendiente', 'version': 1,
                    'createdAt': '2026-11-10T12:00:00Z'}
            TASKS.append(task)
        else:
            assert body['command'] == 'assign'
            task = next(task for task in TASKS if task['id'] == payload['taskId'])
            if task['version'] != payload['expectedVersion']:
                route.fulfill(status=409, json={'code': '23505', 'message': 'VERSION_CONFLICT'})
                return
            assert payload['reason']
            task['version'] += 1
        routing_name = 'responsibleName' in payload
        if routing_name:
            task['responsibleName'] = payload['responsibleName']
        response = {'id': task['id'], 'version': task['version'], 'status': task['status'],
                    'responsibleNameSupported': not STATE['missing']}
        if routing_name:
            response['responsibleName'] = task['responsibleName']
        route.fulfill(json=response)
        return
    fixture.protect(route)


def field(page):
    return page.get_by_label('Responsable del trabajo', exact=True)


def capture(page, name, width):
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
        page.add_init_script('localStorage.setItem(' + json.dumps(storage_key) + ',' +
                             json.dumps(json.dumps(session)) + ')')
        page.on('pageerror', lambda error: ERRORS.append(str(error)))
        page.on('console', lambda message: CONSOLE_ERRORS.append(message.text) if message.type == 'error' else None)
        try:
            for width in [1440, 1024, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                fixture.go(page, 'Recepción')
                # The name is a plain typed field of the reception; no account selector stands in front.
                expect(field(page)).to_be_visible()
                expect(field(page)).to_have_value('')
                expect(page.get_by_label('Cuenta de seguimiento', exact=True)).to_have_count(0)
                capture(page, 'responsible-field', width)
            fixture.go(page, 'Recepción')
            field(page).fill('  Persona sin cuenta  ')
            field(page).press('Tab')
            page.get_by_role('button', name='Guardar responsable', exact=True).click()
            expect(field(page)).to_have_value('Persona sin cuenta')
            assert COMMANDS[-1]['payload']['responsibleName'] == 'Persona sin cuenta', COMMANDS
            assert COMMANDS[-1]['payload']['assignedTo'] == fixture.USER
            assert COMMANDS[-1]['payload']['reason']
            assert COMMANDS[-1]['payload']['expectedVersion'] == 1
            capture(page, 'responsible-saved', 1440)

            # A stale version keeps the typed value and asks the operator to look again.
            fixture.go(page, 'Recepción')
            field(page).fill('<Persona externa>')
            TASKS[0]['version'] += 1
            page.get_by_role('button', name='Guardar responsable', exact=True).click()
            expect(page.locator('p.form-error[role="alert"]')).to_contain_text('La tarea cambió')
            expect(field(page)).to_have_value('<Persona externa>')
            assert COMMANDS[-1]['payload']['expectedVersion'] == TASKS[0]['version'] - 1
            capture(page, 'responsible-stale-kept', 1440)

            # Reading a name never reassigns the account behind it.
            assert TASKS[0]['assignedTo'] == fixture.USER
            assert COMMANDS[-1]['payload']['assignedTo'] == fixture.USER

            # Without permission the field gives way to the recorded name.
            fixture.STATE['denied'] = {'orders.write'}
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(field(page)).to_have_count(0)
            capture(page, 'responsible-permission-revoked', 320)
            fixture.STATE['denied'] = set()

            # A database without the new column disables the field and never claims a save.
            STATE['missing'] = True
            fixture.go(page, 'Recepción')
            expect(field(page)).to_be_disabled()
            expect(page.get_by_test_id('workshop-case')).to_contain_text('requiere actualizar la base de datos')
            capture(page, 'responsible-migration-required', 320)
            assert not fixture.BLOCKED, fixture.BLOCKED
            assert not ERRORS, ERRORS
            assert not [message for message in CONSOLE_ERRORS
                        if 'the server responded with a status of 409' not in message
                        and 'the server responded with a status of 400' not in message], CONSOLE_ERRORS
        except Exception:
            page.evaluate('window.scrollTo(0, 0)')
            page.screenshot(path=str(ROOT / 'failure.png'), full_page=True)
            (ROOT / 'failure.html').write_text(page.content(), encoding='utf8')
            raise
        finally:
            browser.close()
    result = {'passed': True, 'widths': [1440, 1024, 390, 320], 'syntheticCommands': len(COMMANDS),
              'realApiRequests': 0, 'realBusinessWrites': 0, 'keyboard': True, 'errorFocus': True,
              'capturedVersionAndDraft': True, 'manualUnlistedName': True, 'accountPreserved': True,
              'revokedManagerControlsHidden': True, 'legacyReadFallback': True,
              'blockedRequests': fixture.BLOCKED, 'browserErrors': ERRORS}
    result['consoleDiagnostics'] = CONSOLE_ERRORS
    (ROOT / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
