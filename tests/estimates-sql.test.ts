import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('HU08/HU09 deterministic estimates and immutable approvals',async t=>{
  const db=await PGlite.create();
  const owner='00000000-0000-4000-8000-000000000031';
  const admin='00000000-0000-4000-8000-000000000032';
  const technician='00000000-0000-4000-8000-000000000033';
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key,email varchar(255));
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
    await db.exec(readFileSync('supabase/migrations/20261022000100_operational_foundation.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261022000500_versioned_estimates.sql','utf8'));
    for(const[id,role]of[[owner,'owner'],[admin,'admin'],[technician,'technician']]){
      await db.query('insert into auth.users values($1,$2)',[id,role+'@aj.local']);
      await db.query('insert into public.user_roles values($1,$2)',[id,role]);
    }
    async function asUser(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
    async function core(command:string,payload:Record<string,unknown>){return(await db.query<{r:{id:string}}>('select public.execute_command($1,$2::jsonb,$3) r',[command,JSON.stringify(payload),crypto.randomUUID()])).rows[0].r;}
    interface Quote {id:string;status:string;revision:number;snapshot:{cost:number;total:number;margin:number;lines:{tariffRevision:number}[]};}
    async function command(name:string,payload:Record<string,unknown>,key=crypto.randomUUID()){
      return(await db.query<{r:Quote}>('select public.execute_estimate_command($1,$2::jsonb,$3) r',[name,JSON.stringify(payload),key])).rows[0].r;
    }
    async function calculate(lines:unknown[],method='commercial',ratio:string|null=null,discount='0'){
      return(await db.query<{r:Quote['snapshot']}>('select public.calculate_estimate($1::jsonb,$2,$3,$4) r',[JSON.stringify(lines),method,ratio,discount])).rows[0].r;
    }
    await asUser(owner);
    const customer=await core('create_customer',{name:'Estimate customer',phone:'78905566',type:'Personal'});
    const car=await core('create_vehicle',{plate:'ESTIMATE-1',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:0,km:0,ownership:'Propio'});
    const order=await core('receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Pintura',service:'Paint repair'});
    let rate={id:'',revision:0};
    let first:Quote;
    let second:Quote;
    await t.test('same tariff revision/quantities produce exactly the same calculation; margin differs from markup',async()=>{
      rate=await command('tariff',{code:'REPAIR',description:'Repair bundle',kind:'Trabajo',unitCost:'250',unitPrice:'350'});
      const lines=[{tariffId:rate.id,quantity:'1'}];
      const margin=await calculate(lines,'margin','0.25');
      assert.equal(margin.total,333.33);assert.equal(margin.cost,250);assert.equal(margin.margin,83.33);
      assert.deepEqual(await calculate(lines,'margin','0.25'),margin);
      assert.equal((await calculate(lines,'markup','0.25')).total,312.50);
      await assert.rejects(calculate(lines,'commercial','0.25'),/INVALID_PRICING_RATIO/);
      await assert.rejects(calculate(lines,'margin','1'),/INVALID_PRICING_RATIO/);
      await assert.rejects(calculate([{tariffId:rate.id,quantity:'-1'}]),/INVALID_ESTIMATE_LINE/);
      await assert.rejects(calculate(lines,'commercial',null,'351'),/INVALID_ESTIMATE_TOTAL/);
    });
    await t.test('new tariffs never change the old quote; draft revisions retain full customer/vehicle snapshots',async()=>{
      first=await command('version',{orderId:order.id,parentId:null,reason:'Initial scope',lines:[{tariffId:rate.id,quantity:'1'}],method:'margin',ratio:'0.25',discount:'0'});
      assert.equal(first.revision,1);assert.equal(first.snapshot.total,333.33);
      const newRate=await command('tariff',{code:'REPAIR',description:'Revised bundle',kind:'Trabajo',unitCost:'280',unitPrice:'400'});
      assert.equal(newRate.revision,2);
      assert.equal((await calculate([{tariffId:rate.id,quantity:'1'}],'margin','0.25')).total,333.33);
      await assert.rejects(command('version',{orderId:order.id,parentId:null,reason:'Stale parent',lines:[{tariffId:rate.id,quantity:'1'}]}),/PARENT_VERSION_CONFLICT/);
      assert.equal((await db.query<{estimate:string}>('select estimate::text from public.work_orders where id=$1',[order.id])).rows[0].estimate,'0.00');
    });
    await t.test('approval requires evidence, persists once and freezes its exact scope',async()=>{
      await assert.rejects(command('approve',{estimateId:first.id,approverName:'Customer',evidence:''}),/constraint/);
      const payload={estimateId:first.id,approverName:'Customer',evidence:'Customer accepted the attached scope by phone'};
      const key=crypto.randomUUID();first=await command('approve',payload,key);
      assert.equal(first.status,'Aprobado');assert.deepEqual(await command('approve',payload,key),first);
      assert.equal((await db.query('select * from public.estimate_approvals')).rows.length,1);
      assert.equal((await db.query<{estimate:string}>('select estimate::text from public.work_orders where id=$1',[order.id])).rows[0].estimate,'333.33');
      await assert.rejects(db.query('update public.estimate_versions set snapshot=$1::jsonb where id=$2',['{}',first.id]),/permission denied/);
      await db.exec('reset role');
      await assert.rejects(db.query('update public.estimate_versions set snapshot=$1::jsonb where id=$2',['{}',first.id]),/IMMUTABLE_ESTIMATE_VERSION/);
      await asUser(owner);
      second=await command('version',{orderId:order.id,parentId:first.id,reason:'Additional scope, complete revised version',
        lines:[{tariffId:rate.id,quantity:'2'}],discount:'10'});
      assert.equal(second.revision,2);assert.equal(second.snapshot.total,690);
      assert.equal((await db.query<{status:string}>('select status from public.estimate_versions where id=$1',[first.id])).rows[0].status,'Aprobado');
    });
    await t.test('discount approval requires management; rejection/new version never erases prior authorization',async()=>{
      await asUser(admin);
      await assert.rejects(command('approve',{estimateId:second.id,approverName:'Customer',evidence:'Accepted'}),/DISCOUNT_REQUIRES_MANAGEMENT/);
      await command('reject',{estimateId:second.id,approverName:'Customer',evidence:'Additional scope rejected'});
      assert.equal((await db.query<{estimate:string}>('select estimate::text from public.work_orders where id=$1',[order.id])).rows[0].estimate,'333.33');
      await asUser(technician);
      assert.equal((await db.query('select * from public.workshop_tariffs')).rows.length,0);
      assert.equal((await db.query('select * from public.estimate_versions')).rows.length,0);
      await assert.rejects(calculate([{tariffId:rate.id,quantity:'1'}]),/PERMISSION_DENIED/);
      await assert.rejects(command('approve',{estimateId:first.id}),/PERMISSION_DENIED/);
    });
  }finally{await db.close();}
});
