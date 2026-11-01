import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('HU07 task assignment, transitions and independent closure', async t => {
  const db = await PGlite.create();
  const owner = '00000000-0000-4000-8000-000000000021';
  const technician = '00000000-0000-4000-8000-000000000022';
  const other = '00000000-0000-4000-8000-000000000023';
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
      create table auth.users(id uuid primary key,email varchar(255));
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,public to authenticated,anon;
      grant execute on function auth.uid() to authenticated,anon;`);
    await db.exec(readFileSync('supabase/migrations/20261022000100_operational_foundation.sql','utf8'));
    const migration = readFileSync('supabase/migrations/20261022000300_workshop_tasks.sql','utf8');
    await db.exec(migration);
    const labelFix = readFileSync('supabase/migrations/20261022000400_assignee_label_type.sql','utf8');
    await db.exec(labelFix);
    await db.exec(readFileSync('supabase/rollback/20261022000300_workshop_tasks.sql','utf8'));
    await db.exec(migration);
    await db.exec(labelFix);
    for (const [id,role] of [[owner,'owner'],[technician,'technician'],[other,'technician']]) {
      await db.query('insert into auth.users values ($1,$2)',[id,`${role}-${id}@aj.local`]);
      await db.query('insert into public.user_roles values ($1,$2)',[id,role]);
    }
    async function asUser(id: string) {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
      await db.exec('set role authenticated');
    }
    async function core(command: string, payload: Record<string, unknown>) {
      return (await db.query<{result: {id: string}}>('select public.execute_command($1,$2::jsonb,$3) as result',
        [command,JSON.stringify(payload),crypto.randomUUID()])).rows[0].result;
    }
    async function task(command: string, payload: Record<string, unknown>, key = crypto.randomUUID()) {
      return (await db.query<{result: {id: string; version: number; status: string}}>(
        'select public.execute_task_command($1,$2::jsonb,$3) as result',[command,JSON.stringify(payload),key],
      )).rows[0].result;
    }
    await asUser(owner);
    const customer = await core('create_customer',{name:'Task customer',phone:'78901122',type:'Personal'});
    const car = await core('create_vehicle',{plate:'TASK-1',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',
      daily:0,km:0,ownership:'Propio'});
    const order = await core('receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Mecánica',service:'Inspection'});
    let first = {id:'',version:0,status:''};
    let second = {id:'',version:0,status:''};
    await t.test('every task requires a responsible eligible user and retains idempotent identity', async () => {
      const payload = {orderId:order.id,description:'Inspect brakes',assignedTo:technician};
      const key = crypto.randomUUID();
      first = await task('create',payload,key);
      assert.deepEqual(await task('create',payload,key),first);
      await assert.rejects(task('create',{...payload,description:'Changed'},key),/IDEMPOTENCY_CONFLICT/);
      await assert.rejects(task('create',{...payload,assignedTo:null}),/INVALID_ASSIGNEE/);
      second = await task('create',{orderId:order.id,description:'Inspect paint',assignedTo:other});
      assert.equal((await db.query('select * from public.workshop_tasks')).rows.length,2);
      assert.equal((await db.query('select * from public.workshop_assignees()')).rows.length,3);
    });
    await t.test('technicians only see assigned tasks, cannot reassign/create, and still cannot read cash', async () => {
      await asUser(technician);
      assert.equal((await db.query('select * from public.workshop_tasks')).rows.length,1);
      assert.equal((await db.query('select * from public.expenses')).rows.length,0);
      assert.equal((await db.query('select * from public.customers')).rows.length,0);
      await assert.rejects(task('create',{orderId:order.id,description:'Unauthorized',assignedTo:technician}),/PERMISSION_DENIED/);
      await assert.rejects(task('assign',{taskId:first.id,expectedVersion:1,assignedTo:other,reason:'Self reassignment'}),/PERMISSION_DENIED/);
      await assert.rejects(task('transition',{taskId:second.id,expectedVersion:1,status:'En proceso'}),/PERMISSION_DENIED/);
      await assert.rejects(task('transition',{taskId:crypto.randomUUID(),expectedVersion:1,status:'En proceso'}),/PERMISSION_DENIED/);
      await assert.rejects(db.query('select * from public.workshop_assignees()'),/PERMISSION_DENIED/);
    });
    await t.test('finishing one task never finishes siblings or the work order', async () => {
      await assert.rejects(task('transition',{taskId:first.id,expectedVersion:1,status:'Finalizada'}),/INVALID_TASK_TRANSITION/);
      first = await task('transition',{taskId:first.id,expectedVersion:1,status:'En proceso'});
      const payload = {taskId:first.id,expectedVersion:first.version,status:'Finalizada'};
      const key = crypto.randomUUID();
      first = await task('transition',payload,key);
      assert.deepEqual(await task('transition',payload,key),first);
      await asUser(owner);
      assert.equal((await db.query<{status: string}>('select status from public.workshop_tasks where id=$1',[second.id])).rows[0].status,'Pendiente');
      assert.equal((await db.query<{status: string}>('select status from public.work_orders where id=$1',[order.id])).rows[0].status,'Diagnóstico');
      assert.equal((await db.query<{status: string}>('select status from public.vehicles where id=$1',[car.id])).rows[0].status,'En taller');
    });
    await t.test('reassignment is versioned, reasoned and audited; completed tasks are immutable', async () => {
      const payload = {taskId:second.id,expectedVersion:1,assignedTo:technician,reason:'Coverage change'};
      await assert.rejects(task('assign',{...payload,reason:''}),/ASSIGNMENT_REASON_REQUIRED/);
      second = await task('assign',payload);
      assert.equal(second.version,2);
      await assert.rejects(task('assign',payload),/VERSION_CONFLICT/);
      await assert.rejects(task('assign',{taskId:first.id,expectedVersion:first.version,assignedTo:other,reason:'Change'}),/TASK_ALREADY_COMPLETED/);
      const audit = await db.query<{after_data: {last_reason: string}}>(
        "select after_data from public.audit_events where entity='workshop_tasks' and entity_id=$1 and action='UPDATE'",[second.id],
      );
      assert.equal(audit.rows[0].after_data.last_reason,'Coverage change');
      await asUser(other);
      assert.equal((await db.query('select * from public.workshop_tasks')).rows.length,0);
      await assert.rejects(task('transition',{taskId:second.id,expectedVersion:2,status:'En proceso'}),/PERMISSION_DENIED/);
      await assert.rejects(db.exec("update public.workshop_tasks set status='Finalizada'"),/permission denied/);
    });
  } finally {await db.close();}
});
