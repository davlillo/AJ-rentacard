import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operationalDb} from './helpers/operational-db';

const migrationPath = 'supabase/migrations/20261114000200_task_responsible_name.sql';
const rollbackPath = 'supabase/rollback/20261114000200_task_responsible_name.sql';

test('responsible names remain metadata inside the existing task command boundary', async t => {
  const {db, owner, technician, asUser, command} = await operationalDb();
  const other = crypto.randomUUID();
  type Result = {id: string; version: number; status: string; responsibleNameSupported?: boolean};
  const task = (name: string, payload: Record<string, unknown>, key = crypto.randomUUID()) =>
    command<Result>('execute_task_command', name, payload, key);
  async function row(id: string) {
    return (await db.query<{r: Record<string, unknown>}>(
      'select to_jsonb(t) r from public.workshop_tasks t where id=$1', [id])).rows[0]?.r;
  }
  try {
    await db.exec('reset role');
    await db.query('insert into auth.users values($1,$2)', [other, 'other@local']);
    await db.query('insert into public.user_roles values($1,$2)', [other, 'technician']);
    await asUser(owner);
    const customer = await command('execute_command', 'create_customer',
      {name:'Responsible fixture', phone:'78901499', type:'Personal'});
    const car = await command('execute_command', 'create_vehicle', {
      plate:'NAME-ONLY', brand:'Test', model:'Car', year:2026, category:'Sedán',
      color:'White', daily:0, km:0, ownership:'Propio',
    });
    const order = await command('execute_command', 'receive_vehicle',
      {customerId:customer.id, vehicleId:car.id, area:'Mecánica', service:'Metadata test'});
    const base = {orderId:order.id, description:'Name fixture', assignedTo:technician};
    const key = crypto.randomUUID();
    const payload = {...base, responsibleName:' \tUnlisted mechanic\n '};
    let first = await task('create', payload, key);

    await t.test('create persists a trimmed unlisted name without replacing account identity', async () => {
      const stored = await row(first.id);
      assert.equal(stored.responsible_name, 'Unlisted mechanic');
      assert.equal(stored.assigned_to, technician);
      assert.equal(stored.assignee_label, 'technician@local');
      assert.equal(first.version, 1);
      assert.equal(first.responsibleNameSupported, true);
      assert.deepEqual(await task('create', payload, key), first);
      await assert.rejects(task('create', {...payload, responsibleName:'Different'}, key), /IDEMPOTENCY_CONFLICT/);
    });
    // Stop before subsequent migration-specific assertions when exercising the behavioral RED baseline.
    assert.equal((await row(first.id)).responsible_name, 'Unlisted mechanic');

    await t.test('omission, null, blank, type and length contracts are explicit', async () => {
      for (const optional of [{}, {responsibleName:null}, {responsibleName:' \t\n '}]) {
        const created = await task('create', {...base, ...optional});
        assert.equal((await row(created.id)).responsible_name, null);
      }
      for (const responsibleName of [1, true, {}, [], 'a'.repeat(121)]) {
        await assert.rejects(task('create', {...base, responsibleName}), /INVALID_RESPONSIBLE_NAME/);
      }
      const exact = await task('create', {...base, responsibleName:'a'.repeat(120)});
      assert.equal(String((await row(exact.id)).responsible_name).length, 120);
      const legacy = await task('create', base);
      assert.deepEqual(Object.keys(legacy).sort(), ['id','status','version']);
    });
    await t.test('editing uses one version and audit, preserves assignment and original replay payload', async () => {
      const edit = {taskId:first.id, expectedVersion:first.version, assignedTo:technician,
        reason:'Correct work name', responsibleName:'  Outside specialist  '};
      const editKey = crypto.randomUUID();
      first = await task('assign', edit, editKey);
      assert.equal(first.version, 2);
      assert.deepEqual(await task('assign', edit, editKey), first);
      await assert.rejects(task('assign', {...edit, responsibleName:'Outside specialist'}, editKey), /IDEMPOTENCY_CONFLICT/);
      await assert.rejects(task('assign', edit), /VERSION_CONFLICT/);
      let stored = await row(first.id);
      assert.equal(stored.responsible_name, 'Outside specialist');
      assert.equal(stored.assigned_to, technician);
      assert.equal(stored.assignee_label, 'technician@local');
      const audits = await db.query("select id from public.audit_events where entity='workshop_tasks' and entity_id=$1 and action='UPDATE'", [first.id]);
      assert.equal(audits.rows.length, 1);
      first = await task('assign', {taskId:first.id, expectedVersion:first.version,
        assignedTo:technician, reason:'Legacy command'});
      assert.equal((await row(first.id)).responsible_name, 'Outside specialist');
      for (const responsibleName of [null, ' \t ']) {
        first = await task('assign', {taskId:first.id, expectedVersion:first.version,
          assignedTo:technician, reason:'Clear name', responsibleName});
        stored = await row(first.id);
        assert.equal(stored.responsible_name, null);
      }
      first = await task('assign', {taskId:first.id, expectedVersion:first.version,
        assignedTo:technician, reason:'Set metadata', responsibleName:'other@local'});
    });
    await t.test('names confer no technician visibility, transitions, assignment or timer authority', async () => {
      await asUser(other);
      assert.equal(await row(first.id), undefined);
      await assert.rejects(task('transition', {taskId:first.id, expectedVersion:first.version,
        status:'En proceso'}), /PERMISSION_DENIED/);
      await assert.rejects(command('execute_time_command', 'start', {taskId:first.id}), /PERMISSION_DENIED/);
      await asUser(technician);
      assert.ok(await row(first.id));
      await assert.rejects(task('assign', {taskId:first.id, expectedVersion:first.version,
        assignedTo:technician, reason:'Self edit', responsibleName:'Smuggled'}), /PERMISSION_DENIED/);
      await assert.rejects(task('create', {...base, responsibleName:'Smuggled'}), /PERMISSION_DENIED/);
      await assert.rejects(task('transition', {taskId:first.id, expectedVersion:first.version,
        status:'En proceso', responsibleName:'Smuggled'}), /UNSUPPORTED_TASK_METADATA/);
      assert.equal((await row(first.id)).responsible_name, 'other@local');
      first = await task('transition', {taskId:first.id, expectedVersion:first.version, status:'En proceso'});
      const timer = await command<{timer:{id:string;version:number}}>('execute_time_command', 'start', {taskId:first.id});
      await asUser(owner);
      await assert.rejects(task('assign', {taskId:first.id, expectedVersion:first.version,
        assignedTo:other, reason:'Change account', responsibleName:'A name'}), /TASK_HAS_OPEN_TIMER/);
      await assert.rejects(task('transition', {taskId:first.id, expectedVersion:first.version,
        status:'Finalizada'}), /TASK_HAS_OPEN_TIMER/);
      first = await task('assign', {taskId:first.id, expectedVersion:first.version,
        assignedTo:technician, reason:'Name only during timer', responsibleName:'Retained name'});
      await asUser(other);
      await assert.rejects(command('execute_time_command', 'finish',
        {timerId:timer.timer.id, expectedVersion:timer.timer.version}), /PERMISSION_DENIED/);
      await asUser(technician);
      await command('execute_time_command', 'finish', {timerId:timer.timer.id, expectedVersion:timer.timer.version});
      await asUser(owner);
    });
    await t.test('revoked permissions are checked before returning cached results', async () => {
      await db.exec('reset role');
      await db.query('delete from public.user_roles where user_id=$1', [owner]);
      await asUser(owner);
      await assert.rejects(task('create', payload, key), /PERMISSION_DENIED/);
      await db.exec('reset role');
      await db.query('insert into public.user_roles values($1,$2)', [owner, 'owner']);
      await asUser(owner);
    });
    await t.test('rollback rejects metadata writes, preserves names, and reapply restores support', async () => {
      const before = await row(first.id);
      await db.exec('reset role');
      const policies = (await db.query("select policyname,qual from pg_policies where tablename in ('workshop_tasks','task_timers') order by policyname")).rows;
      await db.exec(readFileSync(rollbackPath, 'utf8'));
      await asUser(owner);
      assert.equal((await row(first.id)).responsible_name, before.responsible_name);
      await assert.rejects(task('assign', {taskId:first.id, expectedVersion:first.version,
        assignedTo:technician, reason:'Rollback', responsibleName:'Not saved'}), /RESPONSIBLE_NAME_MIGRATION_REQUIRED/);
      first = await task('assign', {taskId:first.id, expectedVersion:first.version,
        assignedTo:technician, reason:'Legacy rollback command'});
      assert.equal((await row(first.id)).responsible_name, before.responsible_name);
      await db.exec('reset role');
      await db.exec(readFileSync(migrationPath, 'utf8'));
      assert.deepEqual((await db.query("select policyname,qual from pg_policies where tablename in ('workshop_tasks','task_timers') order by policyname")).rows, policies);
      const grants = (await db.query<{anonymous:boolean;authenticated:boolean;direct_write:boolean}>(`select
        has_function_privilege('anon','public.execute_task_command(text,jsonb,uuid)','execute') anonymous,
        has_function_privilege('authenticated','public.execute_task_command(text,jsonb,uuid)','execute') authenticated,
        has_table_privilege('authenticated','public.workshop_tasks','update') direct_write`)).rows[0];
      assert.deepEqual(grants, {anonymous:false, authenticated:true, direct_write:false});
      await asUser(owner);
      first = await task('assign', {taskId:first.id, expectedVersion:first.version,
        assignedTo:technician, reason:'Reapply', responsibleName:'Restored support'});
      assert.equal((await row(first.id)).responsible_name, 'Restored support');
    });
  } finally {await db.close();}
});
