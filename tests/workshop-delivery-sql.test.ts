import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {operationalDb} from './helpers/operational-db';

test('HU12 delivery is blocked by pending costs and exceptions identify their responsible actor',async t=>{
  const db=await PGlite.create();const owner='00000000-0000-4000-8000-000000000061';
  const admin='00000000-0000-4000-8000-000000000062';const reception='00000000-0000-4000-8000-000000000063';
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key,email varchar(255));
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
    for(const file of ['20261022000100_operational_foundation','20261022000300_workshop_tasks','20261022000400_assignee_label_type',
      '20261022000500_versioned_estimates','20261022000600_workshop_costs','20261022000700_task_timers','20261022000800_workshop_delivery','20261022000900_delivery_cost_adjustments',
      '20261125000100_delivery_tasks_optional'])
      await db.exec(readFileSync(`supabase/migrations/${file}.sql`,'utf8'));
    for(const[id,role]of[[owner,'owner'],[admin,'admin'],[reception,'reception']]){
      await db.query('insert into auth.users values($1,$2)',[id,role+'@local']);await db.query('insert into public.user_roles values($1,$2)',[id,role]);}
    async function asUser(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
    interface Row{id:string;version:number;}
    async function command(fn:string,name:string,payload:Record<string,unknown>){return(await db.query<{r:Row}>(
      'select public.'+fn+'($1,$2::jsonb,$3) r',[name,JSON.stringify(payload),crypto.randomUUID()])).rows[0].r;}
    interface Checklist{version:number;pendingCosts:number;openTimers:unknown[];}
    async function checklist(orderId:string){return(await db.query<{r:Checklist}>('select public.workshop_delivery_checklist($1) r',[orderId])).rows[0].r;}
    async function deliver(payload:Record<string,unknown>,key=crypto.randomUUID()){
      return(await db.query<{r:{id:string;exception:boolean;responsible_id:string;checklist:Checklist}}> (
        'select public.deliver_workshop_order($1::jsonb,$2) r',[JSON.stringify(payload),key])).rows[0].r;}
    await asUser(owner);
    const customer=await command('execute_command','create_customer',{name:'Delivery test',phone:'78901566',type:'Personal'});
    async function receive(plate:string){
      const car=await command('execute_command','create_vehicle',{plate,brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:0,km:0,ownership:'Propio'});
      const order=await command('execute_command','receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Mecánica',service:'Delivery test'});
      const cost=await command('execute_cost_command','purchase',{orderId:order.id,description:'Pending part',quantity:'1',unitCost:'25',
        supplier:'Synthetic supplier',sourceReference:plate,date:'2026-10-22'});
      return{car,order,cost};
    }
    const first=await receive('DELIVER-1');
    const payload={orderId:first.order.id,expectedVersion:1,recipient:'Synthetic customer',evidence:'Synthetic delivery record',acknowledgePendingReception:true};
    await t.test('ordinary closure is blocked; only owner can authorize an exception with a mandatory reason',async()=>{
      assert.equal((await checklist(first.order.id)).pendingCosts,1);
      await assert.rejects(deliver(payload),/DELIVERY_HAS_PENDING_ITEMS/);
      await asUser(admin);await assert.rejects(deliver({...payload,exception:true,reason:'Customer requested delivery'}),/DELIVERY_EXCEPTION_REQUIRES_MANAGEMENT/);
      await asUser(owner);await assert.rejects(deliver({...payload,exception:true,reason:''}),/DELIVERY_EXCEPTION_REASON_REQUIRED/);
      const key=crypto.randomUUID();const decision={...payload,exception:true,reason:'Owner assumes pending warranty classification'};
      const saved=await deliver(decision,key);assert.equal(saved.responsible_id,owner);assert.equal(saved.exception,true);
      assert.deepEqual(await deliver(decision,key),saved);assert.equal(saved.checklist.pendingCosts,1);
      assert.equal((await checklist(first.order.id)).pendingCosts,1);
      assert.equal((await db.query<{status:string}>('select status from public.work_orders where id=$1',[first.order.id])).rows[0].status,'Entregado');
      assert.equal((await db.query<{status:string}>('select status from public.vehicles where id=$1',[first.car.id])).rows[0].status,'En taller');
      await command('execute_delivery_cost_adjustment','classify',{costId:first.cost.id,expectedVersion:1,disposition:'Absorbido',reason:'Owner resolved warranty review after delivery'});
      assert.equal((await checklist(first.order.id)).pendingCosts,0);
      const original=(await db.query<{checklist:Checklist}>('select checklist from public.workshop_deliveries where id=$1',[saved.id])).rows[0];
      assert.equal(original.checklist.pendingCosts,1);
      await command('execute_delivery_cost_adjustment','purchase',{orderId:first.order.id,description:'Late workshop invoice',quantity:'1',unitCost:'12',
        supplier:'Late supplier',sourceReference:'late-1',date:'2026-10-22',reason:'Supplier invoice arrived after act'});
      assert.equal((await checklist(first.order.id)).pendingCosts,1);
    });
    await t.test('ordinary delivery succeeds after classification; no open timer can be overridden',async()=>{
      const second=await receive('DELIVER-2');
      await command('execute_cost_command','classify',{costId:second.cost.id,expectedVersion:1,disposition:'Interno',reason:'Own fleet maintenance'});
      let task=await command('execute_task_command','create',{orderId:second.order.id,description:'Delivery check',assignedTo:owner});
      task=await command('execute_task_command','transition',{taskId:task.id,expectedVersion:task.version,status:'En proceso'});
      const timer=(await db.query<{r:{timer:Row}}> ('select public.execute_time_command($1,$2::jsonb,$3) r',
        ['start',JSON.stringify({taskId:task.id}),crypto.randomUUID()])).rows[0].r.timer;
      const next={...payload,orderId:second.order.id};
      await assert.rejects(deliver({...next,exception:true,reason:'Cannot bypass timer'}),/DELIVERY_HAS_OPEN_TIMERS/);
      await command('execute_time_command','finish',{timerId:timer.id,expectedVersion:timer.version});
      await command('execute_task_command','transition',{taskId:task.id,expectedVersion:task.version,status:'Finalizada'});
      await assert.rejects(deliver({...next,acknowledgePendingReception:false}),/ACKNOWLEDGE_PENDING_RECEPTION/);
      const saved=await deliver(next);assert.equal(saved.exception,false);assert.equal(saved.checklist.pendingCosts,0);
      await assert.rejects(db.exec('update public.workshop_deliveries set reason=\'rewrite\''),/permission denied/);
      await db.exec('reset role');await assert.rejects(db.exec('update public.workshop_deliveries set reason=\'rewrite\''),/IMMUTABLE_RECORD/);
      await asUser(reception);assert.equal((await db.query('select * from public.workshop_deliveries')).rows.length,0);
      await assert.rejects(checklist(second.order.id),/PERMISSION_DENIED/);
    });
  }finally{await db.close();}
});

test('S3 open tasks are optional follow-up and never block delivery while money still does',async t=>{
  const {db,command,rpc,asUser,owner,technician}=await operationalDb();
  interface Check{version:number;pendingCosts:number;openTasks:unknown[];openTimers:unknown[];pendingEstimate:string|null;estimatedUnpaid:number;}
  interface Delivered{id:string;exception:boolean;checklist:Check;}
  const checklist=async(orderId:string)=>rpc<Check>('workshop_delivery_checklist',{order_id:orderId});
  const deliver=(orderId:string,version:number,extra:Record<string,unknown>={},key=crypto.randomUUID())=>rpc<Delivered>(
    'deliver_workshop_order',{payload:JSON.stringify({orderId,expectedVersion:version,recipient:'Synthetic customer',
      evidence:'Synthetic delivery record',acknowledgePendingReception:true,...extra}),idempotency_key:key});
  async function job(plate:string,ownership='Propio'){
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'S3 '+plate,phone:'',type:'Personal'});
    const vehicle=await command<{id:string}>('execute_command','create_vehicle',{plate,brand:'Test',model:'Car',year:2026,
      category:'Sedán',color:'White',daily:'0',km:'0',ownership,...(ownership==='Cliente'?{ownerCustomerId:customer.id}:{})});
    const order=await command<{id:string}>('execute_command','receive_vehicle',
      {customerId:customer.id,vehicleId:vehicle.id,area:'Mecánica',service:'S3 '+plate});
    return {customer,vehicle,order:{id:order.id,version:(await checklist(order.id)).version}};
  }
  const status=async(orderId:string)=>(await db.query<{status:string}>('select status from public.work_orders where id=$1',[orderId])).rows[0].status;
  const admin=crypto.randomUUID();
  await db.exec('reset role');
  await db.query('insert into auth.users values($1,$2)',[admin,'s3-admin@local']);
  await db.query('insert into public.user_roles values($1,$2)',[admin,'admin']);
  await asUser(owner);
  try{
    await t.test('an open task with no money pending delivers and stays open',async()=>{
      const only=await job('S3-OPEN');
      const task=await command<{id:string}>('execute_task_command','create',{orderId:only.order.id,description:'Optional follow-up',assignedTo:technician});
      const review=await checklist(only.order.id);
      assert.equal(review.openTasks.length,1);assert.equal(review.pendingCosts,0);
      const saved=await deliver(only.order.id,only.order.version);
      assert.equal(saved.exception,false);
      assert.equal(saved.checklist.openTasks.length,1,'the act keeps the open task visible');
      assert.equal(await status(only.order.id),'Entregado');
      assert.equal((await db.query<{status:string}>('select status from public.workshop_tasks where id=$1',[task.id])).rows[0].status,'Pendiente');
    });
    await t.test('a pending cost still blocks, and only management can deliver by exception',async()=>{
      const money=await job('S3-COST');
      await command('execute_cost_command','purchase',{orderId:money.order.id,description:'Pending part',quantity:'1',
        unitCost:'25',supplier:'Synthetic supplier',sourceReference:'s3-cost',date:'2026-11-25'});
      await assert.rejects(deliver(money.order.id,money.order.version),/DELIVERY_HAS_PENDING_ITEMS/);
      await asUser(admin);
      await assert.rejects(deliver(money.order.id,money.order.version,{exception:true,reason:'Synthetic exception'}),
        /DELIVERY_EXCEPTION_REQUIRES_MANAGEMENT/);
      await asUser(owner);
      await assert.rejects(deliver(money.order.id,money.order.version,{exception:true,reason:''}),/DELIVERY_EXCEPTION_REASON_REQUIRED/);
      const saved=await deliver(money.order.id,money.order.version,{exception:true,reason:'Owner assumes pending classification'});
      assert.equal(saved.exception,true);assert.equal(saved.checklist.pendingCosts,1);
    });
    await t.test('an undecided budget revision still blocks delivery',async()=>{
      const revision=await job('S3-REV');
      await db.exec('reset role');
      await db.query(`insert into public.estimate_versions(order_id,revision,status,snapshot,customer_snapshot,vehicle_snapshot,reason,created_by)
        values($1,1,'Borrador','{}','{}','{}','Synthetic pending revision',$2)`,[revision.order.id,owner]);
      await asUser(owner);
      assert.ok((await checklist(revision.order.id)).pendingEstimate);
      await assert.rejects(deliver(revision.order.id,revision.order.version),/DELIVERY_HAS_PENDING_ITEMS/);
    });
    await t.test('an open timer still blocks, and a task in progress does not block once the timer ends',async()=>{
      const running=await job('S3-TIMER');
      let task=await command<{id:string;version:number}>('execute_task_command','create',
        {orderId:running.order.id,description:'Work in progress',assignedTo:owner});
      task=await command<{id:string;version:number}>('execute_task_command','transition',{taskId:task.id,expectedVersion:task.version,status:'En proceso'});
      const timer=await command<{timer:{id:string;version:number}}>('execute_time_command','start',{taskId:task.id});
      await assert.rejects(deliver(running.order.id,running.order.version),/DELIVERY_HAS_OPEN_TIMERS/);
      await command('execute_time_command','finish',{timerId:timer.timer.id,expectedVersion:timer.timer.version});
      const saved=await deliver(running.order.id,running.order.version);
      assert.equal(saved.exception,false);
      assert.equal(saved.checklist.openTasks.length,1,'the in-progress task is recorded but not a gate');
    });
    await t.test('reception acknowledgement, credit authorization, idempotency and version keep their rules',async()=>{
      const reception=await job('S3-REC');
      await assert.rejects(deliver(reception.order.id,reception.order.version,{acknowledgePendingReception:false}),
        /ACKNOWLEDGE_PENDING_RECEPTION/);
      await deliver(reception.order.id,reception.order.version);
      const credit=await job('S3-CREDIT','Cliente');
      await db.exec('reset role');
      await db.query(`insert into public.billing_documents(customer_id,order_id,description,amount,issued_on,due_on,customer_snapshot,created_by)
        values($1,$2,'Synthetic issued charge',100,'2026-11-25','2026-11-30','{}',$3)`,[credit.customer.id,credit.order.id,owner]);
      await asUser(owner);
      assert.equal((await checklist(credit.order.id)).estimatedUnpaid,100);
      await assert.rejects(deliver(credit.order.id,credit.order.version),/DELIVERY_REQUIRES_CREDIT_AUTHORIZATION/);
      assert.equal((await deliver(credit.order.id,credit.order.version,{creditReason:'Owner authorized synthetic credit'})).exception,false);
      const keyed=await job('S3-KEY');
      await assert.rejects(deliver(keyed.order.id,keyed.order.version+1),/VERSION_CONFLICT/);
      const key=crypto.randomUUID();
      const saved=await deliver(keyed.order.id,keyed.order.version,{},key);
      assert.deepEqual(await deliver(keyed.order.id,keyed.order.version,{},key),saved);
      await assert.rejects(deliver(keyed.order.id,keyed.order.version,{recipient:'Another recipient'},key),/IDEMPOTENCY_CONFLICT/);
    });
    await t.test('the rollback restores the old gate and the migration re-applies',async()=>{
      await db.exec('reset role');
      await db.exec(readFileSync('supabase/rollback/20261125000100_delivery_tasks_optional.sql','utf8'));
      await asUser(owner);
      const legacy=await job('S3-ROLLBACK');
      await command('execute_task_command','create',{orderId:legacy.order.id,description:'Legacy gate task',assignedTo:technician});
      await assert.rejects(deliver(legacy.order.id,legacy.order.version),/DELIVERY_HAS_PENDING_ITEMS/);
      await db.exec('reset role');
      await db.exec(readFileSync('supabase/migrations/20261125000100_delivery_tasks_optional.sql','utf8'));
      await asUser(owner);
      assert.equal((await deliver(legacy.order.id,legacy.order.version)).exception,false);
    });
  }finally{await db.close();}
});
