import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const owner = '00000000-0000-4000-8000-000000000001';
const reception = '00000000-0000-4000-8000-000000000002';
const technician = '00000000-0000-4000-8000-000000000003';
const unassigned = '00000000-0000-4000-8000-000000000004';
const migration = readFileSync('supabase/migrations/20261022000100_operational_foundation.sql', 'utf8');
const rollback = readFileSync('supabase/rollback/20261022000100_operational_foundation.sql', 'utf8');

// Real PostgreSQL SQL/RLS execution in WASM, not a JS replica of business rules.
// Only Supabase's auth identity infrastructure is supplied by this fixture.
// HTTP/Auth, multi-connection concurrency and network durability need local Supabase tests as well.
test('HU01–HU04 PostgreSQL acceptance', async t => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
      grant usage on schema auth, public to authenticated, anon;
      grant execute on function auth.uid() to authenticated, anon;
    `);
    await t.test('migrations apply, roll back on an empty schema and reapply', async () => {
      await db.exec(migration);
      await db.exec(rollback);
      const result = await db.query<{name: string | null}>("select to_regclass('public.customers') as name");
      assert.equal(result.rows[0].name, null);
      await db.exec(migration);
    });
    for (const [id, role] of [[owner,'owner'],[reception,'reception'],[technician,'technician'],[unassigned,null]]) {
      await db.query('insert into auth.users values ($1)', [id]);
      if (role) await db.query('insert into public.user_roles values ($1,$2)', [id, role]);
    }
    async function asUser(id: string) {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
      await db.exec('set role authenticated');
    }
    async function command(name: string, payload: Record<string, unknown>, key = crypto.randomUUID()) {
      const result = await db.query<{result: {id: string}}>(
        'select public.execute_command($1,$2::jsonb,$3::uuid) as result', [name, JSON.stringify(payload), key],
      );
      return result.rows[0].result;
    }
    await asUser(owner);
    const firstPayload = {name:'Original Customer',phone:'7890-1234',document:'ABC-123',email:'',type:'Personal'};
    let firstId = '';
    let secondId = '';
    let vehicleId = '';
    let orderId = '';
    await t.test('HU01 creates once, finds normalized matches, rejects duplicate and changed key body', async () => {
      const key = crypto.randomUUID();
      const first = await command('create_customer', firstPayload, key);
      firstId = first.id;
      assert.deepEqual(await command('create_customer', firstPayload, key), first);
      await assert.rejects(command('create_customer', {...firstPayload,name:'Changed'}, key), /IDEMPOTENCY_CONFLICT/);
      const result = await db.query<{id: string}>("select id from public.customer_matches('(7890) 1234','ABC123')");
      assert.equal(result.rows[0].id, firstId);
      await assert.rejects(command('create_customer', {...firstPayload,phone:'(7890) 1234'}), /CUSTOMER_MATCH_EXISTS/);
      secondId = (await command('create_customer', {...firstPayload,name:'Survivor',phone:'7000-0000',document:'XYZ-789'})).id;
    });
    await t.test('HU02 validates ownership and normalized unique plates', async () => {
      const car = {plate:'P 123-456',brand:'Toyota',model:'Corolla',year:2024,category:'Sedán',color:'Plata',
        daily:0,km:12000,ownership:'Cliente',ownerCustomerId:firstId};
      vehicleId = (await command('create_vehicle', car)).id;
      await assert.rejects(command('create_vehicle', {...car,plate:'p123456'}), /unique/i);
      await assert.rejects(command('create_vehicle', {...car,plate:'P999999',ownerCustomerId:null}), /INVALID_OWNER/);
      const result = await db.query<{ownership: string; owner_customer_id: string}>(
        'select ownership,owner_customer_id from public.vehicles where id = $1', [vehicleId],
      );
      assert.equal(result.rows[0].owner_customer_id, firstId);
      assert.equal(result.rows[0].ownership, 'Cliente');
    });
    await t.test('HU03 minimal reception creates unique folio, pending fields, actor and vehicle block', async () => {
      const payload = {customerId:firstId,vehicleId,area:'Mecánica',service:'Brake inspection'};
      const key = crypto.randomUUID();
      const order = await command('receive_vehicle', payload, key);
      orderId = order.id;
      assert.match(orderId, /^OT-\d+$/);
      assert.deepEqual(await command('receive_vehicle', payload, key), order);
      await assert.rejects(command('receive_vehicle', payload), /VEHICLE_UNAVAILABLE/);
      const result = await db.query<{pending_fields: string[]; created_by: string}>(
        'select pending_fields,created_by from public.work_orders where id = $1', [orderId],
      );
      assert.equal(result.rows[0].pending_fields.length, 4);
      assert.equal(result.rows[0].created_by, owner);
      assert.equal((await db.query<{status: string}>('select status from public.vehicles where id=$1', [vehicleId])).rows[0].status,'En taller');
    });
    await t.test('HU04 requires exactly one valid destination; expense, folio and audit persist atomically once', async () => {
      const expense = {date:'2026-10-22',concept:'Brake fluid',category:'Materials',amount:'35.10',
        method:'Efectivo',account:'Main cashbox',operationId:orderId,costCenterId:null};
      const key = crypto.randomUUID();
      const result = await command('record_expense', expense, key);
      assert.match(result.id, /^EG-\d+$/);
      assert.deepEqual(await command('record_expense', expense, key), result);
      await assert.rejects(command('record_expense', {...expense,operationId:null}), /constraint/);
      await assert.rejects(command('record_expense', {...expense,costCenterId:'administration'}), /constraint/);
      await assert.rejects(command('record_expense', {...expense,operationId:'OT-NOT-FOUND'}), /INVALID_OPERATION/);
      await assert.rejects(command('record_expense', {...expense,amount:'-1'}), /constraint/);
      await assert.rejects(command('record_expense', {...expense,amount:'NaN'}), /constraint/);
      await command('record_expense', {...expense,operationId:null,costCenterId:'administration'});
      const total = await db.query<{total: string}>(
        'select sum(amount)::text as total from public.expenses where operation_id=$1', [orderId],
      );
      assert.equal(total.rows[0].total,'35.10');
      assert.equal((await db.query('select id from public.audit_events where entity_id=$1', [result.id])).rows.length,1);
    });
    await t.test('HU01 merge preserves ownership, operations, expenses and search aliases; stale versions conflict', async () => {
      const payload = {sourceId:firstId,targetId:secondId,sourceVersion:1,targetVersion:1,reason:'Duplicate identity verified'};
      await assert.rejects(command('merge_customer', {...payload,sourceVersion:0}), /VERSION_CONFLICT/);
      const key = crypto.randomUUID();
      const result = await command('merge_customer', payload, key);
      assert.deepEqual(await command('merge_customer', payload, key), result);
      assert.equal((await db.query<{customer_id: string}>(
        'select customer_id from public.work_orders where id=$1', [orderId],
      )).rows[0].customer_id,secondId);
      assert.equal((await db.query<{owner_customer_id: string}>(
        'select owner_customer_id from public.vehicles where id=$1', [vehicleId],
      )).rows[0].owner_customer_id,secondId);
      const matches = await db.query<{id: string}>("select id from public.customer_matches('78901234','ABC123')");
      assert.deepEqual(matches.rows.map(row => row.id),[secondId]);
      assert.equal((await db.query('select id from public.expenses where operation_id=$1', [orderId])).rows.length,1);
      assert.equal((await db.query('select source_id from public.customer_aliases')).rows.length,1);
      await assert.rejects(command('create_customer', firstPayload), /CUSTOMER_MATCH_EXISTS/);
    });
    await t.test('HU01–HU04 direct SQL writes and role escalation denied', async () => {
      await assert.rejects(db.query('update public.customers set name=$1 where id=$2', ['Injected',secondId]), /permission denied/);
      await assert.rejects(db.query('insert into public.user_roles values ($1,$2)', [unassigned,'owner']), /permission denied/);
      await assert.rejects(db.query('select * from private.command_results'), /permission denied/);
    });
    await t.test('HU28 foundation: reception cannot read or write cash even directly; technician and unassigned denied', async () => {
      await asUser(reception);
      assert.equal((await db.query('select * from public.expenses')).rows.length,0);
      await assert.rejects(command('record_expense', {}), /PERMISSION_DENIED/);
      await assert.rejects(command('merge_customer', {}), /PERMISSION_DENIED/);
      assert.equal((await db.query('select id from public.customers')).rows.length,2);
      for (const user of [technician,unassigned]) {
        await asUser(user);
        assert.equal((await db.query('select * from public.expenses')).rows.length,0);
        assert.equal((await db.query('select * from public.customers')).rows.length,0);
        await assert.rejects(command('create_customer', firstPayload), /PERMISSION_DENIED/);
      }
    });
    await t.test('anonymous RPC execution is denied', async () => {
      await db.exec('reset role; set role anon;');
      await assert.rejects(command('create_customer', firstPayload), /permission denied/);
      await assert.rejects(db.query('select * from public.expenses'), /permission denied/);
    });
  } finally {await db.close();}
});
