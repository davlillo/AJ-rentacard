import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const owner = '00000000-0000-4000-8000-000000000011';
const technician = '00000000-0000-4000-8000-000000000012';
const mapping = Object.fromEntries(['date','concept','category','amount','method','account','costCenterId','sourceKey']
  .map(field => [field,field]));
const base = {date:'2026-10-22',concept:'Paint supplies',category:'Materials',amount:'12.34',method:'Efectivo',
  account:'Cashbox',costCenterId:'workshop',sourceKey:'SOURCE-1'};
interface Batch {id: string; version: number; status: string; summary: {valid: number; rejected: number;
  duplicate: number; ambiguous: number; excluded: number; newTotal: number;};}
interface Row {status: string; issue: string; expense_id: string | null; payload: {amount: string};}

test('HU05/HU06 SQL import acceptance', async t => {
  const db = await PGlite.create();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,public to authenticated,anon;
      grant execute on function auth.uid() to authenticated,anon;`);
    await db.exec(readFileSync('supabase/migrations/20261022000100_operational_foundation.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261022000200_expense_imports.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261022000200_expense_imports.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261022000200_expense_imports.sql','utf8'));
    await db.query("insert into auth.users values ($1),($2)",[owner,technician]);
    await db.query("insert into public.user_roles values ($1,'owner'),($2,'technician')",[owner,technician]);
    async function asUser(id: string) {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
      await db.exec('set role authenticated');
    }
    await asUser(owner);
    const raw = (cells: Record<string, unknown>, rowNumber = 2, hasFormula = false) => ({rowNumber,cells,hasFormula});
    async function stage(name: string, rows: ReturnType<typeof raw>[], original = name) {
      const result = await db.query<{batch: Batch}>(
        'select public.stage_expense_import($1,$2,$3,$4::jsonb,$5::jsonb) as batch',
        [name+'.csv',Buffer.from(original).toString('base64'),'Sheet1',JSON.stringify(Object.keys(base)),JSON.stringify(rows)],
      );
      return result.rows[0].batch;
    }
    async function validate(batch: Batch, decisions = {}, customMapping = mapping) {
      const result = await db.query<{batch: Batch}>(
        'select public.validate_expense_import($1,$2,$3::jsonb,$4,$5::jsonb) as batch',
        [batch.id,batch.version,JSON.stringify(customMapping),'daily-ledger',JSON.stringify(decisions)],
      );
      return result.rows[0].batch;
    }
    async function commit(batch: Batch, total = batch.summary.newTotal) {
      const result = await db.query<{batch: Batch}>(
        'select public.commit_expense_import($1,$2,$3) as batch',[batch.id,batch.version,total],
      );
      return result.rows[0].batch;
    }
    const rows = async (batch: Batch) => (await db.query<Row>(
      'select * from public.expense_import_rows where import_id=$1 order by row_number',[batch.id],
    )).rows;
    const count = async () => (await db.query<{n: number}>('select count(*)::int as n from public.expenses')).rows[0].n;
    let expenseId = '';
    await t.test('HU05 stages privately; invalid rows block every write until explicitly excluded and reconciled', async () => {
      const sourceRows = [raw(base),raw({...base,sourceKey:'BAD',amount:'NaN'},3)];
      const staged = await stage('first-file',sourceRows);
      assert.equal(await count(),0);
      assert.equal((await stage('first-file',sourceRows)).id,staged.id);
      let batch = await validate(staged);
      assert.equal(batch.summary.valid,1); assert.equal(batch.summary.rejected,1);
      await assert.rejects(commit(batch),/IMPORT_HAS_UNRESOLVED_ROWS/);
      assert.equal(await count(),0);
      batch = await validate(batch,{'3':{action:'exclude',reason:'Invalid source row; owner reviewed'}});
      assert.equal(batch.summary.excluded,1);
      await assert.rejects(commit(batch,99),/RECONCILIATION_MISMATCH/);
      assert.equal(await count(),0);
      const published = await commit(batch);
      assert.equal(published.status,'committed');
      assert.equal(await count(),1);
      expenseId = (await rows(batch))[0].expense_id!;
      assert.equal((await rows(batch))[0].status,'published');
      assert.equal((await commit(batch)).id,published.id);
      assert.equal(await count(),1);
      assert.equal((await stage('renamed-file',sourceRows,'first-file')).status,'committed');
      const original = await db.query<{file: string}>('select public.expense_import_original($1) as file',[batch.id]);
      assert.equal(Buffer.from(original.rows[0].file,'base64').toString(),'first-file');
      await assert.rejects(validate(published),/IMPORT_NOT_EDITABLE/);
    });
    await t.test('HU06 stable origin in another file links once; changed origin data is a conflict', async () => {
      const batch = await validate(await stage('second-book',[raw(base)]));
      assert.equal(batch.summary.duplicate,1); assert.equal(batch.summary.newTotal,0);
      await commit(batch);
      assert.equal((await rows(batch))[0].expense_id,expenseId); assert.equal(await count(),1);
      const conflict = await validate(await stage('changed-origin',[raw({...base,amount:'55'})]));
      assert.equal(conflict.summary.rejected,1);
      assert.equal((await rows(conflict))[0].issue,'SOURCE_KEY_CONFLICT');
      await assert.rejects(commit(conflict),/IMPORT_HAS_UNRESOLVED_ROWS/);
      assert.equal(await count(),1);
    });
    await t.test('HU06 similar records require an explicit decision; equal date/amount alone never deduplicates', async () => {
      let batch = await validate(await stage('ambiguous-book',[raw({...base,sourceKey:''})]));
      assert.equal(batch.summary.ambiguous,1);
      await assert.rejects(commit(batch),/IMPORT_HAS_UNRESOLVED_ROWS/);
      batch = await validate(batch,{'2':{action:'link',expenseId,reason:'Same expense verified in both books'}});
      assert.equal(batch.summary.duplicate,1);
      await commit(batch); assert.equal(await count(),1);
      const different = await validate(await stage('different-expense',[raw({...base,sourceKey:'SOURCE-2',concept:'Fuel'})]));
      assert.equal(different.summary.valid,1); await commit(different); assert.equal(await count(),2);
    });
    await t.test('HU05 formulas and impossible dates are rejected; localized decimal input is exact', async () => {
      const bad = await validate(await stage('formula-and-date',[
        raw({...base,sourceKey:'F',amount:'12.34'},2,true),
        raw({...base,sourceKey:'D',date:'2026-02-31'},3),
        raw({...base,sourceKey:'M',amount:'1,50'},4),
      ]));
      assert.equal(bad.summary.rejected,3);
      assert.equal((await rows(bad))[0].issue,'FORMULA_REQUIRES_REVIEW');
      const localized = await validate(await stage('localized',[
        raw({...base,sourceKey:'LOCAL',date:'22/10/2026',amount:'1.234,56'}),
      ]),{}, {...mapping,dateFormat:'DMY',decimalSeparator:','});
      assert.equal(localized.summary.newTotal,1234.56);
      await commit(localized);
    });
    await t.test('HU06 repeated source keys or identical rows within a batch are not silently published', async () => {
      let batch = await validate(await stage('repeated-key',[
        raw({...base,sourceKey:'REPEAT',concept:'Other'}),raw({...base,sourceKey:'REPEAT',concept:'Other'},3),
      ]));
      assert.equal(batch.summary.rejected,2);
      batch = await validate(batch,{'3':{action:'exclude',reason:'Duplicate source line confirmed'}});
      assert.equal(batch.summary.valid,1); await commit(batch);
      const similar = await validate(await stage('similar-rows',[
        raw({...base,sourceKey:'A',concept:'Same-day supplies'}),
        raw({...base,sourceKey:'B',concept:'Same-day supplies'},3),
      ]));
      assert.equal(similar.summary.ambiguous,2);
      await assert.rejects(commit(similar),/IMPORT_HAS_UNRESOLVED_ROWS/);
    });
    await t.test('HU05 stale previews and mismatched versions cannot publish partial data', async () => {
      const cells = {...base,sourceKey:'STALE',concept:'Concurrent source'};
      const batch = await validate(await stage('stale-preview',[raw(cells)]));
      await assert.rejects(validate({...batch,version:1}),/VERSION_CONFLICT/);
      await db.query('select public.execute_command($1,$2::jsonb,$3)',[
        'record_expense',JSON.stringify({...cells,operationId:null}),crypto.randomUUID(),
      ]);
      const before = await count();
      await assert.rejects(commit(batch),/IMPORT_PREVIEW_CHANGED/);
      assert.equal(await count(),before);
      const refreshed = await validate(batch);
      assert.equal(refreshed.summary.ambiguous,1);
    });
    await t.test('HU28 import raw files and commands remain inaccessible to technician/anonymous', async () => {
      await assert.rejects(db.exec("update public.expense_imports set status='committed'"),/permission denied/);
      await asUser(technician);
      assert.equal((await db.query('select * from public.expense_import_rows')).rows.length,0);
      await assert.rejects(stage('forbidden',[raw(base)]),/PERMISSION_DENIED/);
      await assert.rejects(db.query('select public.expense_import_original($1)',[crypto.randomUUID()]),/PERMISSION_DENIED/);
      await db.exec('reset role; set role anon');
      await assert.rejects(stage('anonymous',[raw(base)]),/permission denied/);
    });
  } finally {await db.close();}
});
