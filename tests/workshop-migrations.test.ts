import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('HU08-HU12 migrations roll back only when unused, then reapply',async()=>{
  const db=await PGlite.create();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key,email varchar(255));
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
    for(const file of ['20261022000100_operational_foundation','20261022000300_workshop_tasks','20261022000400_assignee_label_type'])
      await db.exec(readFileSync(`supabase/migrations/${file}.sql`,'utf8'));
    const files=['20261022000500_versioned_estimates','20261022000600_workshop_costs','20261022000700_task_timers',
      '20261022000800_workshop_delivery','20261022000900_delivery_cost_adjustments'];
    for(const file of files)await db.exec(readFileSync(`supabase/migrations/${file}.sql`,'utf8'));
    const rollback=readFileSync('supabase/rollback/20261022000500_to_000900_workshop.sql','utf8');
    await db.exec(rollback);
    assert.equal((await db.query<{name:string|null}>("select to_regclass('public.estimate_versions')::text name")).rows[0].name,null);
    for(const file of files)await db.exec(readFileSync(`supabase/migrations/${file}.sql`,'utf8'));
    const actor='00000000-0000-4000-8000-000000000071';
    await db.query('insert into auth.users values($1,$2)',[actor,'migration-test@local']);
    await db.query("insert into public.user_roles values($1,'owner')",[actor]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
    await db.query('select public.execute_estimate_command($1,$2::jsonb,$3)',[
      'tariff',JSON.stringify({code:'ROLLBACK-GUARD',description:'Guard test',kind:'Trabajo',unitCost:'10',unitPrice:'15'}),crypto.randomUUID()]);
    await assert.rejects(db.exec(rollback),/Rollback refused/);await db.exec('rollback');
    assert.equal((await db.query('select id from public.workshop_tariffs')).rows.length,1);
  }finally{await db.close();}
});
