import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('HU22-HU24 rule snapshots, stable contracts and drillable vehicle contribution',async t=>{
  const {db,command,rpc}=await operationalDb();
  try{
    const date=(await db.query<{d:string}>("select (now() at time zone 'America/El_Salvador')::date::text d")).rows[0].d;
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Contract original',phone:'78901944',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'MANAGE-1',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:50,km:0,ownership:'Propio'});
    const booking=await command<{id:string}>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,
      startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+2*86400000).toISOString(),dailyRate:'50',cleaningMinutes:0});
    const document=await command<{id:string}>('execute_billing_command','issue',{reservationId:booking.id,description:'Eligible service',amount:'500',date,dueOn:date});
    const payment=await command<{id:string}>('execute_billing_command','pay',{customerId:customer.id,amount:'200',date,method:'Efectivo',account:'Test',reference:'Management test'});
    await command('execute_billing_command','apply',{documentId:document.id,paymentId:payment.id,amount:'200',date});
    await t.test('versioned rule yields20 then refund adjusts-5, never another20 on retry',async()=>{
      await command('execute_commission_command','eligibility',{documentId:document.id,eligible:true,reason:'Eligible rental service, not a deposit'});
      const rule=await command<{id:string}>('execute_commission_command','rule',{code:'SALES',rate:'0.10',validFrom:'2020-01-01',validUntil:'2040-01-01'});
      const calculation={reservationId:booking.id,ruleId:rule.id,cutoff:date};
      const first=await command<{id:string;amount:number}>('execute_commission_command','calculate',calculation);
      assert.equal(first.amount,20);assert.deepEqual(await command('execute_commission_command','calculate',calculation),first);
      await command('execute_billing_command','refund',{documentId:document.id,paymentId:payment.id,amount:'50',date,reason:'Refunded service'});
      const adjustment=await command<{amount:number}>('execute_commission_command','calculate',calculation);assert.equal(adjustment.amount,-5);
      assert.equal((await db.query('select id from public.commission_entries')).rows.length,2);
      await command('execute_commission_command','eligibility',{documentId:document.id,eligible:false,reason:'Owner reclassified eligibility'});
      assert.equal((await command<{amount:number}>('execute_commission_command','calculate',calculation)).amount,-15);
    });
    await t.test('contract version freezes parties/conditions; merge never changes it',async()=>{
      const contract=await command<{id:string;booking_snapshot:{customer_snapshot:{name:string}}}>('execute_contract_command','version',{
        reservationId:booking.id,parentId:null,conditions:'Synthetic terms, not legal advice',reason:'Initial agreed conditions'});
      assert.equal(contract.booking_snapshot.customer_snapshot.name,'Contract original');
      const target=await command<{id:string}>('execute_command','create_customer',{name:'Contract updated identity',phone:'78901945',type:'Personal'});
      await command('execute_command','merge_customer',{sourceId:customer.id,targetId:target.id,sourceVersion:1,targetVersion:1,reason:'Verified identity'});
      const original=(await db.query<{name:string}>("select booking_snapshot->'customer_snapshot'->>'name' name from public.rental_contracts where id=$1",[contract.id])).rows[0];
      assert.equal(original.name,'Contract original');
      await command('execute_contract_command','accept',{contractId:contract.id,acceptedBy:'Customer',evidence:'Signed synthetic acceptance retained'});
      const next=await command<{revision:number}>('execute_contract_command','version',{reservationId:booking.id,parentId:contract.id,conditions:'Revised terms',reason:'Customer requested amendment'});
      assert.equal(next.revision,2);assert.equal((await db.query('select id from public.contract_acceptances')).rows.length,1);
    });
    await t.test('indicator has source documents and actual costs rather than cash receipts or inventory receipt',async()=>{
      const report=await rpc<{billedIncome:number;actualDirectCost:number;contribution:number;income:{id:string}[]}>('vehicle_contribution',{vehicle_id:car.id,from_date:date,cutoff:date});
      assert.equal(report.billedIncome,500);assert.equal(report.actualDirectCost,0);assert.equal(report.contribution,500);
      assert.equal(report.income[0].id,document.id);
    });
  }finally{await db.close();}
});
