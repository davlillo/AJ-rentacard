import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {API,CONTAINER,DATABASE,assertLocalTarget,operationalTables} from '../scripts/replace-local-records.mjs';
import {CASH,LABEL,ROOT,fleetSpecs} from '../scripts/local-workspace/scenario.mjs';

test('Local replacement is fixed to the existing AJ local test workspace',()=>{
  const target={api:API,database:DATABASE,container:CONTAINER};
  assert.equal(API,'http://127.0.0.1:55321');assert.equal(DATABASE,'postgres');
  assert.doesNotThrow(()=>assertLocalTarget(target));
  for(const change of [{api:'https://example.com'},{database:'aj_showcase'},
    {container:'supabase_db_other-project'}])assert.throws(()=>assertLocalTarget({...target,...change}));
  assert.equal(ROOT,'test-results/local-workspace');
  assert.notEqual(LABEL,'aj-rentacar-showcase-v1');
  assert.notEqual(CASH,'Caja DEMO');assert.equal(fleetSpecs.length,7);
});

test('Replacement cannot truncate identities, settings, audit history or workbook evidence',()=>{
  assert.ok(operationalTables.includes('public.receipt_operation_contexts'));
  assert.ok(operationalTables.includes('private.command_results'));
  for(const protectedTable of ['auth.users','auth.identities','public.user_roles','public.audit_events',
    'public.source_workbooks','public.source_workbook_items','private.source_workbook_bytes',
    'public.commission_rules','public.cost_centers','public.workshop_tariffs','public.operating_budgets'])
    assert.ok(!operationalTables.includes(protectedTable));
  assert.equal(new Set(operationalTables).size,operationalTables.length);
});

test('Replacement requires backup verification, an unchanged snapshot, rehearsal and explicit confirmation',()=>{
  const source=readFileSync('scripts/replace-local-records.mjs','utf8');
  for(const guard of ['BACKUP_CHECKSUM_MISMATCH','WORKSPACE_CHANGED','ROLLBACK_REHEARSAL_REQUIRED',
    'EXPLICIT_LOCAL_REPLACEMENT_CONFIRMATION_REQUIRED','PROTECTED_DATA_CHANGED','LOCAL_CLEANUP_MARKER_MISSING'])
    assert.ok(source.includes(guard));
  assert.ok(source.includes('continue identity restrict'));
  assert.ok(source.includes("'pg_restore','--file=/dev/null'"));
  assert.ok(source.includes("record_type=null,record_id=null,proposal=null"));
  assert.ok(!/truncate[^;]*cascade|disable trigger|session_replication_role|drop database|drop schema/i.test(source));
});

test('New scenario uses normal operational copy and a resumable, separate command journal',()=>{
  const source=readFileSync('scripts/local-workspace/scenario.mjs','utf8');
  assert.ok(!/DEMO|demostraci[oó]n|fictici/i.test(source));
  assert.ok(source.includes('journal.replacementId!==replacementId'));
  assert.ok(source.includes('idempotency_key:entry.key'));
  assert.ok(source.includes('renameSync(temporary,path)'));
  assert.ok(!/auth\.admin|createUser|updateUser/.test(source));
});
