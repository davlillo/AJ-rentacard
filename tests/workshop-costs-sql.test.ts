import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('HU10 actual costs keep their destination and default to pending commercial classification',async t=>{
  const db=await PGlite.create();const actor='00000000-0000-4000-8000-000000000041';
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key,email varchar(255));
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
    for(const name of ['20261022000100_operational_foundation','20261022000500_versioned_estimates'])
      await db.exec(readFileSync(`supabase/migrations/${name}.sql`,'utf8'));
    await db.query('insert into auth.users values($1,$2)',[actor,'cost-owner@aj.local']);
    await db.query("insert into public.user_roles values($1,'owner')",[actor]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await db.exec('set role authenticated');
    async function core(command:string,payload:Record<string,unknown>){return(await db.query<{r:{id:string}}>(
      'select public.execute_command($1,$2::jsonb,$3) r',[command,JSON.stringify(payload),crypto.randomUUID()])).rows[0].r;}
    const customer=await core('create_customer',{name:'Cost test',phone:'78901244',type:'Personal'});
    const car=await core('create_vehicle',{plate:'COST-1',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:0,km:0,ownership:'Cliente',ownerCustomerId:customer.id});
    const order=await core('receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Mecánica',service:'Cost test'});
    const expensePayload={operationId:order.id,costCenterId:null,date:'2026-10-22',concept:'Oil',category:'Materials',amount:'10',method:'Efectivo',account:'Synthetic cashbox'};
    const existing=await core('record_expense',expensePayload);
    await db.exec('reset role');await db.exec(readFileSync('supabase/migrations/20261022000600_workshop_costs.sql','utf8'));await db.exec('set role authenticated');
    interface Cost{id:string;order_id:string;disposition:string;version:number;amount:number;}
    async function command(command:string,payload:Record<string,unknown>,key=crypto.randomUUID()){
      return(await db.query<{r:Cost}>('select public.execute_cost_command($1,$2::jsonb,$3) r',[command,JSON.stringify(payload),key])).rows[0].r;
    }
    let cost:Cost;
    await t.test('existing and new expenses become costs once without another cash movement',async()=>{
      assert.equal((await db.query('select id from public.workshop_costs where expense_id=$1',[existing.id])).rows.length,1);
      const next=await core('record_expense',{...expensePayload,concept:'Paint',amount:'20'});
      assert.equal((await db.query('select id from public.workshop_costs where expense_id=$1',[next.id])).rows.length,1);
      assert.equal((await db.query('select id from public.expenses')).rows.length,2);
    });
    await t.test('unexpected part is assigned, pending, idempotent and not silently paid/billed',async()=>{
      const payload={orderId:order.id,description:'Unexpected part',quantity:'2',unitCost:'17.555',supplier:'Synthetic supplier',sourceReference:'invoice-1/line-1',date:'2026-10-22'};
      const key=crypto.randomUUID();cost=await command('purchase',payload,key);
      assert.equal(cost.order_id,order.id);assert.equal(cost.disposition,'Pendiente');assert.equal(cost.amount,35.11);
      assert.deepEqual(await command('purchase',payload,key),cost);
      await assert.rejects(command('purchase',payload),/unique constraint/);
      assert.equal((await db.query('select id from public.expenses')).rows.length,2);
      assert.equal((await db.query<{estimate:string}>('select estimate::text from public.work_orders where id=$1',[order.id])).rows[0].estimate,'0.00');
    });
    await t.test('classification requires reason, approved scope for extra billing and optimistic version',async()=>{
      await assert.rejects(command('classify',{costId:cost.id,expectedVersion:1,disposition:'Interno',reason:''}),/COST_REASON_REQUIRED/);
      await assert.rejects(command('classify',{costId:cost.id,expectedVersion:1,disposition:'Adicional autorizado',reason:'Found part'}),/APPROVED_SCOPE_REQUIRED/);
      cost=await command('classify',{costId:cost.id,expectedVersion:1,disposition:'Absorbido',reason:'Warranty cost approved'});
      assert.equal(cost.version,2);assert.equal(cost.disposition,'Absorbido');
      await assert.rejects(command('classify',{costId:cost.id,expectedVersion:1,disposition:'Interno',reason:'Stale decision'}),/VERSION_CONFLICT/);
      assert.ok((await db.query('select id from public.audit_events where entity=$1 and entity_id=$2',['workshop_costs',cost.id])).rows.length>=2);
      await assert.rejects(db.exec('update public.workshop_costs set amount=1'),/permission denied/);
    });
  }finally{await db.close();}
});
