import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('HU25-HU30 authorized proposals, report outbox, budget and retryable integration',async t=>{
  const {db,owner,technician,asUser,command,rpc}=await operationalDb();
  try{
    const date=(await db.query<{d:string}>("select (now() at time zone 'America/El_Salvador')::date::text d")).rows[0].d;
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Automation test',phone:'78901955',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'AUTO-1',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:50,km:0,ownership:'Propio'});
    const order=await command<{id:string}>('execute_command','receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Mecánica',service:'Automation cost evidence'});
    await t.test('proposal hash/actor is confirmed exactly once; assistant returns actual references and cutoff',async()=>{
      const payload={operationId:order.id,date,concept:'Agent oil',category:'Materials',amount:'35.10',method:'Efectivo',account:'Synthetic cashbox'};
      const proposal=await rpc<{id:string;payload_hash:string}>('propose_agent_expense',{payload:JSON.stringify(payload),idempotency_key:crypto.randomUUID()});
      assert.equal((await db.query('select id from public.expenses')).rows.length,0);
      await assert.rejects(rpc('confirm_agent_expense',{proposal_id:proposal.id,expected_hash:'changed'}),/PROPOSAL_CONFIRMATION_MISMATCH/);
      const confirmed=await rpc<{id:string}>('confirm_agent_expense',{proposal_id:proposal.id,expected_hash:proposal.payload_hash});
      assert.deepEqual(await rpc('confirm_agent_expense',{proposal_id:proposal.id,expected_hash:proposal.payload_hash}),confirmed);
      const answer=await rpc<{total:number;operationId:string;sources:{expense_id:string}[]}>('agent_vehicle_cost',{vehicle_ref:'AUTO-1',order_ref:order.id,cutoff:date});
      assert.equal(answer.total,35.10);assert.equal(answer.operationId,order.id);assert.equal(answer.sources[0].expense_id,confirmed.id);
      await asUser(technician);await assert.rejects(rpc('agent_vehicle_cost',{vehicle_ref:'AUTO-1',order_ref:order.id,cutoff:date}),/PERMISSION_DENIED/);
      await assert.rejects(rpc('administration_users',{}),/PERMISSION_DENIED/);await asUser(owner);
      await assert.rejects(command('execute_administration_command','revoke_role',{userId:owner,role:'owner',reason:'Invalid last owner removal'}),/LAST_OWNER_CANNOT_BE_REMOVED/);
    });
    await t.test('report cutoff/filters persist; competing claims and re-preparation never send two jobs',async()=>{
      await command('execute_report_delivery_command','schedule',{recipientId:owner,vehicleId:car.id,from:date,nextOn:date,everyDays:7});
      const jobs=await command<{id:string;cutoff:string;filters:{vehicleId:string}}[]>('execute_report_delivery_command','prepare',{runDate:date});
      assert.equal(jobs.length,1);assert.equal(jobs[0].cutoff,date);assert.equal(jobs[0].filters.vehicleId,car.id);
      assert.deepEqual(await command('execute_report_delivery_command','prepare',{runDate:date}),[]);
      const claimKey=crypto.randomUUID();
      const claim=await command<{state:string}>('execute_report_delivery_command','claim',{jobId:jobs[0].id},claimKey);assert.equal(claim.state,'Enviando');
      assert.equal(await command('execute_report_delivery_command','claim',{jobId:jobs[0].id},claimKey),null);
      assert.equal(await command('execute_report_delivery_command','claim',{jobId:jobs[0].id}),null);
      await command('execute_report_delivery_command','sent',{jobId:jobs[0].id,detail:'Synthetic transport acknowledgment'});
      assert.equal((await db.query('select id from public.report_outbox')).rows.length,1);
    });
    await t.test('budget separates20 committed and30 received; paying received purchase never doubles execution',async()=>{
      const item=await command<{id:string}>('execute_inventory_command','item',{sku:'BUDGET-1',name:'Budget part',unit:'unit'});
      let purchase=await command<{id:string;version:number}>('execute_inventory_command','request',{itemId:item.id,supplier:'Supplier',quantity:'5',unitCost:'10',reason:'Budget replenish'});
      purchase=await command('execute_inventory_command','authorize',{purchaseId:purchase.id,expectedVersion:purchase.version,reason:'Approved'});
      const plan=await command<{id:string}>('execute_optional_command','budget',{name:'Pilot spending',area:'Taller',category:'Materials',startsOn:date,endsOn:date,authorized:'100'});
      await command('execute_optional_command','link_purchase',{budgetId:plan.id,purchaseId:purchase.id});
      await command('execute_inventory_command','receive',{purchaseId:purchase.id,expectedVersion:purchase.version,quantity:'3',reason:'Partial delivery'});
      const payment=await command<{id:string}>('execute_command','record_expense',{costCenterId:'workshop',date,concept:'Supplier payment',category:'Materials',amount:'30',method:'Efectivo',account:'Test'});
      await command('execute_optional_command','link_expense',{budgetId:plan.id,expenseId:payment.id,purchaseId:purchase.id,reason:'Payment of the same received goods, not another execution'});
      const position=await rpc<{committed:number;executed:number;available:number}>('budget_position',{budget_id:plan.id,cutoff:date});
      assert.equal(position.committed,20);assert.equal(position.executed,30);assert.equal(position.available,50);
    });
    await t.test('duplicate external event replays result; a configuration failure recovers without repeating business',async()=>{
      const payload={source:'local-pilot-adapter',externalId:'EVENT-1',event:{costCenterId:'recovery-center',date,concept:'Recovered event',category:'Test',amount:'12',method:'Efectivo',account:'Test'}};
      const event=await command<{id:string}>('execute_optional_command','enqueue',payload);
      assert.equal((await command<{id:string}>('execute_optional_command','enqueue',payload)).id,event.id);
      assert.equal((await command<{state:string}>('execute_optional_command','process',{eventId:event.id})).state,'Error');
      await command('execute_administration_command','cost_center',{id:'recovery-center',name:'Recovery center',reason:'Approved integration destination'});
      const processed=await command<{state:string;result:{id:string}}>('execute_optional_command','process',{eventId:event.id});assert.equal(processed.state,'Procesado');
      assert.deepEqual(await command('execute_optional_command','process',{eventId:event.id}),processed);
      assert.equal((await db.query('select id from public.expenses where concept=$1',['Recovered event'])).rows.length,1);
      await assert.rejects(command('execute_optional_command','enqueue',{...payload,event:{...payload.event,amount:'13'}}),/EXTERNAL_EVENT_PAYLOAD_CONFLICT/);
    });
  }finally{await db.close();}
});
