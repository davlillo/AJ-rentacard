import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('HU11 server time excludes pauses and keeps correction evidence',async t=>{
  const db=await PGlite.create();const owner='00000000-0000-4000-8000-000000000051';
  const tech='00000000-0000-4000-8000-000000000052';const stranger='00000000-0000-4000-8000-000000000053';
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key,email varchar(255));
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
    for(const name of ['20261022000100_operational_foundation','20261022000300_workshop_tasks','20261022000400_assignee_label_type','20261022000700_task_timers'])
      await db.exec(readFileSync(`supabase/migrations/${name}.sql`,'utf8'));
    for(const[id,role]of[[owner,'owner'],[tech,'technician'],[stranger,'technician']]){
      await db.query('insert into auth.users values($1,$2)',[id,role+'@local']);await db.query('insert into public.user_roles values($1,$2)',[id,role]);}
    async function asUser(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
    interface Row {id:string;version:number;state:string;}
    async function rpc(name:string,command:string,payload:Record<string,unknown>,key=crypto.randomUUID()){
      return(await db.query<{r:Row}>('select public.'+name+'($1,$2::jsonb,$3) r',[command,JSON.stringify(payload),key])).rows[0].r;
    }
    async function time(command:string,payload:Record<string,unknown>,key=crypto.randomUUID()){
      return(await db.query<{r:{timer:Row}}>('select public.execute_time_command($1,$2::jsonb,$3) r',[command,JSON.stringify(payload),key])).rows[0].r.timer;
    }
    await asUser(owner);
    const customer=await rpc('execute_command','create_customer',{name:'Timer test',phone:'78901455',type:'Personal'});
    const car=await rpc('execute_command','create_vehicle',{plate:'TIMER-1',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:0,km:0,ownership:'Propio'});
    const order=await rpc('execute_command','receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Mecánica',service:'Timing test'});
    let task=await rpc('execute_task_command','create',{orderId:order.id,description:'Clocked task',assignedTo:tech});
    let timer:Row;
    await t.test('only assigned active task can start, retries do not create extra intervals',async()=>{
      await asUser(tech);await assert.rejects(time('start',{taskId:task.id}),/TIME_REQUIRES_ASSIGNED_ACTIVE_TASK/);
      task=await rpc('execute_task_command','transition',{taskId:task.id,expectedVersion:task.version,status:'En proceso'});
      const key=crypto.randomUUID();timer=await time('start',{taskId:task.id},key);
      assert.deepEqual(await time('start',{taskId:task.id},key),timer);
      await assert.rejects(time('start',{taskId:task.id}),/WORKER_HAS_OPEN_TIMER/);
      await assert.rejects(rpc('execute_task_command','transition',{taskId:task.id,expectedVersion:task.version,status:'Finalizada'}),/TASK_HAS_OPEN_TIMER/);
    });
    await t.test('pause closes only active interval; paused wall-clock duration adds no active seconds',async()=>{
      await db.exec('select pg_sleep(0.02)');timer=await time('pause',{timerId:timer.id,expectedVersion:timer.version});
      const before=(await db.query<{seconds:string}>('select sum(active_seconds)::text seconds from public.task_time_spans')).rows[0].seconds;
      await db.exec('select pg_sleep(0.02)');
      assert.equal((await db.query<{seconds:string}>('select sum(active_seconds)::text seconds from public.task_time_spans')).rows[0].seconds,before);
      timer=await time('resume',{timerId:timer.id,expectedVersion:timer.version});
      timer=await time('finish',{timerId:timer.id,expectedVersion:timer.version});
      assert.equal(timer.state,'Finalizado');
      const stats=(await db.query<{active:number;elapsed:number}>(`select sum(s.active_seconds)::float8 active,
        extract(epoch from (t.finished_at-t.started_at))::float8 elapsed from public.task_timers t
        join public.task_time_spans s on s.timer_id=t.id group by t.id`)).rows[0];
      assert.ok(stats.elapsed-stats.active>=.02);assert.ok(stats.active>0);
    });
    await t.test('edits preserve reason, author, old values and optimistic version; outsiders cannot read or edit',async()=>{
      const span=(await db.query<{id:string;version:number;startedAt:string;endedAt:string}>(`select id,version,started_at::text "startedAt",
        ended_at::text "endedAt" from public.task_time_spans order by started_at limit 1`)).rows[0];
      await assert.rejects(time('correct',{spanId:span.id,expectedVersion:span.version,startedAt:span.startedAt,endedAt:span.endedAt,reason:''}),/TIME_REASON_REQUIRED/);
      await time('correct',{spanId:span.id,expectedVersion:span.version,startedAt:span.startedAt,endedAt:span.startedAt,reason:'Removed accidental start, verified by technician'});
      const corrected=(await db.query<{reason:string;updated_by:string;active_seconds:number}>('select * from public.task_time_spans where id=$1',[span.id])).rows[0];
      assert.equal(corrected.updated_by,tech);assert.equal(Number(corrected.active_seconds),0);
      await assert.rejects(time('correct',{spanId:span.id,expectedVersion:span.version,startedAt:span.startedAt,endedAt:span.endedAt,reason:'Stale edit'}),/VERSION_CONFLICT/);
      await asUser(stranger);assert.equal((await db.query('select * from public.task_timers')).rows.length,0);
      assert.equal((await db.query('select * from public.task_time_spans')).rows.length,0);
      await assert.rejects(time('finish',{timerId:timer.id,expectedVersion:timer.version}),/PERMISSION_DENIED/);
      await asUser(owner);
      const audits=(await db.query<{before_data:unknown;after_data:{reason:string;updated_by:string}}>(
        "select before_data,after_data from public.audit_events where entity='task_time_spans' and entity_id=$1 order by created_at desc",[span.id])).rows;
      assert.ok(audits.some(event=>event.before_data&&event.after_data.reason===corrected.reason&&event.after_data.updated_by===tech));
    });
  }finally{await db.close();}
});
