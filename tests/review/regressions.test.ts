import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {operationalDb} from '../helpers/operational-db';

// Independent review counterexamples stay in the default npm test gate.
test('Independent review: uncovered cross-module regressions',async t=>{
  const {db,command,rpc,asUser,owner,technician}=await operationalDb();
  try{
    const dates=(await db.query<{today:string;yesterday:string}>(`select
      (now() at time zone 'America/El_Salvador')::date::text today,
      ((now() at time zone 'America/El_Salvador')::date-1)::text yesterday`)).rows[0];
    const customer=await command<{id:string}>('execute_command','create_customer',{
      name:'Independent review customer',phone:'78903901',type:'Personal'});
    async function car(plate:string):Promise<{id:string}>{
      return command('execute_command','create_vehicle',{plate,brand:'Test',model:'Review',year:2026,
        category:'Sedán',color:'White',daily:50,km:0,ownership:'Propio'});
    }
    interface Booking{id:string;version:number;}
    async function booking(vehicleId:string,start:number,end:number):Promise<Booking>{
      return command('execute_reservation_command','create',{vehicleId,customerId:customer.id,
        startsAt:new Date(start).toISOString(),endsAt:new Date(end).toISOString(),dailyRate:'50',cleaningMinutes:30});
    }
    await t.test('HU06: similar rows with different origin keys must not publish two receipts silently',async()=>{
      const payment={customerId:customer.id,date:dates.today,amount:'200',method:'Efectivo',
        account:'Review cashbox',reference:'Same physical receipt',sourceKey:'ORIGIN-A'};
      const rows=[{rowNumber:2,cells:payment,hasFormula:false},
        {rowNumber:3,cells:{...payment,sourceKey:'ORIGIN-B'},hasFormula:false}];
      const mapping=Object.fromEntries(Object.keys(payment).map(key=>[key,key]));
      interface Batch{id:string;version:number;preview:{status:string}[];}
      const batch=await command<Batch>('execute_payment_import','stage',{fileName:'review-payments.csv',
        sheet:'Payments',base64:Buffer.from('Review duplicate candidates').toString('base64'),rows});
      let preview=await command<Batch>('execute_payment_import','validate',{batchId:batch.id,
        expectedVersion:batch.version,mapping,sourceSystem:'review-source',decisions:{}});
      assert.deepEqual(preview.preview.map(row=>row.status),['Valida','Ambigua']);
      await assert.rejects(command('execute_payment_import','commit',{batchId:batch.id,
        expectedVersion:preview.version,expectedTotal:'200'}),/UNRESOLVED_IMPORT_ROWS/,
      `Unresolved within-file similarity must block publication; preview was ${JSON.stringify(preview.preview.map(r=>r.status))}`);
      preview=await command<Batch>('execute_payment_import','validate',{batchId:batch.id,expectedVersion:preview.version,
        mapping,sourceSystem:'review-source',decisions:{3:{action:'create',reason:'Verified separate receipts with the same amount'}}});
      assert.deepEqual(preview.preview.map(row=>row.status),['Valida','Valida']);
      const key=crypto.randomUUID();const payload={batchId:batch.id,expectedVersion:preview.version,expectedTotal:'400'};
      const committed=await command('execute_payment_import','commit',payload,key);
      assert.deepEqual(await command('execute_payment_import','commit',payload,key),committed);
      assert.equal((await db.query('select id from public.customer_payments')).rows.length,2);
    });
    await t.test('HU10/HU24: paying an already recorded direct purchase must not double actual cost',async()=>{
      const vehicle=await car('REVIEW-COST');
      const order=await command<{id:string}>('execute_command','receive_vehicle',{customerId:customer.id,
        vehicleId:vehicle.id,area:'Mecánica',service:'One part, one purchase, one payment'});
      const cost=await command<{id:string}>('execute_cost_command','purchase',{orderId:order.id,description:'Part INV-REVIEW-1',
        quantity:'1',unitCost:'100',supplier:'Review supplier',sourceReference:'INV-REVIEW-1',date:dates.today});
      await assert.rejects(command('execute_command','record_expense',{operationId:order.id,date:dates.today,
        concept:'Payment of part INV-REVIEW-1',category:'Supplier payment',amount:'100',method:'Efectivo',
        account:'Review bank',support:'INV-REVIEW-1'}),/DIRECT_PURCHASE_PAYMENT_REQUIRED/);
      const key=crypto.randomUUID();const args={cost_id:cost.id,idempotency_key:key,payload:JSON.stringify({
        date:dates.today,amount:'60',method:'Efectivo',account:'Review bank'})};
      const first=await rpc('pay_direct_purchase',args);
      assert.deepEqual(await rpc('pay_direct_purchase',args),first);
      await assert.rejects(rpc('pay_direct_purchase',{...args,idempotency_key:crypto.randomUUID(),
        payload:JSON.stringify({date:dates.today,amount:'41',method:'Efectivo',account:'Review bank'})}),/DIRECT_PURCHASE_OVERPAYMENT/);
      await rpc('pay_direct_purchase',{...args,idempotency_key:crypto.randomUUID(),
        payload:JSON.stringify({date:dates.today,amount:'40',method:'Efectivo',account:'Review bank'})});
      const report=await rpc<{actualDirectCost:number}>('vehicle_contribution',{
        vehicle_id:vehicle.id,from_date:dates.today,cutoff:dates.today});
      assert.equal(report.actualDirectCost,100,'A cash payment does not acquire a second part');
      assert.equal((await db.query('select id from public.workshop_costs where order_id=$1',[order.id])).rows.length,1);
      assert.equal((await db.query('select id from public.expenses where direct_purchase_cost_id=$1',[cost.id])).rows.length,2);
      await asUser(technician);await assert.rejects(rpc('pay_direct_purchase',args),/PERMISSION_DENIED/);await asUser(owner);
    });
    await t.test('HU13/HU17: a cancelled cleaning block must not clear a different return readiness hold',async()=>{
      const vehicle=await car('REVIEW-READY');const now=Date.now();
      let cancelled=await booking(vehicle.id,now-4*3600000,now-3*3600000);
      cancelled=await command('execute_reservation_command','confirm',{
        reservationId:cancelled.id,expectedVersion:cancelled.version});
      await command('execute_reservation_command','cancel',{reservationId:cancelled.id,
        expectedVersion:cancelled.version,reason:'Cancelled historical reservation'});
      const inactive=(await db.query<{id:string}>(`select id from public.vehicle_commitments
        where reservation_id=$1 and kind='Limpieza' and not active`,[cancelled.id])).rows[0];
      let active=await booking(vehicle.id,now-3600000,now+86400000);
      active=await command('execute_reservation_command','confirm',{
        reservationId:active.id,expectedVersion:active.version});
      const inspection={reservationId:active.id,km:'0',fuel:'100',condition:'No change',
        accessories:'None',evidence:'Synthetic handover record'};
      const departed=await command<{reservation:Booking}>('execute_rental_command','depart',{
        ...inspection,expectedVersion:active.version});
      await command('execute_rental_command','return',{
        ...inspection,expectedVersion:departed.reservation.version});
      await assert.rejects(command('execute_reservation_command','finish_block',{
        blockId:inactive.id,reason:'Attempt to finish a cancelled unrelated block'}),/BLOCK_CANNOT_BE_FINISHED/);
      const state=(await db.query<{readiness_hold:boolean;status:string}>(
        'select readiness_hold,status from public.vehicles where id=$1',[vehicle.id])).rows[0];
      assert.equal(state.readiness_hold,true,`Unreviewed return was released as ${state.status}`);
      const unrelated=await command<{id:string}>('execute_reservation_command','block',{vehicleId:vehicle.id,
        kind:'Limpieza',startsAt:new Date(now+2*86400000).toISOString(),endsAt:new Date(now+2*86400000+3600000).toISOString(),
        reason:'Unrelated future cleaning'});
      await assert.rejects(command('execute_reservation_command','finish_block',{
        blockId:unrelated.id,reason:'Unrelated active block cannot release this return'}),/RETURN_CLEANING_REQUIRED/);
      const cleaning=(await db.query<{id:string}>('select id from public.vehicle_commitments where reservation_id=$1 and kind=\'Limpieza\'',[active.id])).rows[0];
      const key=crypto.randomUUID();const release={blockId:cleaning.id,reason:'Actual return reviewed and cleaned'};
      const released=await command('execute_reservation_command','finish_block',release,key);
      assert.deepEqual(await command('execute_reservation_command','finish_block',release,key),released);
      assert.equal((await db.query<{readiness_hold:boolean}>('select readiness_hold from public.vehicles where id=$1',[vehicle.id])).rows[0].readiness_hold,false);
    });
    await t.test('HU23: a PDF-looking string is not a valid contract document',async()=>{
      const vehicle=await car('REVIEW-PDF');
      const draft=await booking(vehicle.id,Date.now()+86400000,Date.now()+2*86400000);
      const contract=await command<{id:string}>('execute_contract_command','version',{
        reservationId:draft.id,parentId:null,conditions:'Original frozen conditions. Condición y devolución. '.repeat(180),reason:'Review version'});
      await assert.rejects(db.query('select public.contract_pdf($1,$2)',[
        contract.id,Buffer.from('%PDF-not-a-document').toString('base64')]),
      /INVALID_PDF/,'Invalid bytes must be rejected as invalid content, not fail for an unrelated SQL error');
      const stored=await rpc<{base64:string;hash:string}>('contract_pdf',{contract_id:contract.id});
      const bytes=Buffer.from(stored.base64,'base64');
      const pdf=await PDFDocument.load(bytes,{throwOnInvalidObject:true});
      assert.ok(pdf.getPageCount()>1);assert.equal(stored.hash,createHash('sha256').update(bytes).digest('hex'));
      assert.ok(bytes.toString('ascii').includes(Buffer.from('Condición y devolución.','latin1').toString('hex')));
      const next=await command<{id:string}>('execute_contract_command','version',{reservationId:draft.id,parentId:contract.id,
        conditions:'Later changed conditions',reason:'New agreement'});
      assert.deepEqual(await rpc('contract_pdf',{contract_id:contract.id}),stored);
      await asUser(technician);await assert.rejects(rpc('contract_pdf',{contract_id:contract.id}),/PERMISSION_DENIED/);await asUser(owner);
      const unsupported=await command<{id:string}>('execute_contract_command','version',{reservationId:draft.id,parentId:next.id,
        conditions:'A symbol must not silently change the agreement: 🚗',reason:'Unsupported encoding review'});
      await assert.rejects(rpc('contract_pdf',{contract_id:unsupported.id}),/CONTRACT_TEXT_ENCODING_UNSUPPORTED/);
    });
    await t.test('HU29: yesterday cutoff must not include a purchase authorized/linked today',async()=>{
      const item=await command<{id:string}>('execute_inventory_command','item',{
        sku:'REVIEW-BUDGET',name:'Review budget item',unit:'unit'});
      let purchase=await command<{id:string;version:number}>('execute_inventory_command','request',{
        itemId:item.id,supplier:'Review supplier',quantity:'5',unitCost:'10',reason:'Requested yesterday'});
      // Simulate yesterday's request only in the isolated review database; approval/link remain today.
      await db.exec('reset role');
      await db.query(`update public.purchase_orders set created_at=($1::date+time '12:00')
        at time zone 'America/El_Salvador' where id=$2`,[dates.yesterday,purchase.id]);
      await db.query(`update public.audit_events set created_at=($1::date+time '12:00')
        at time zone 'America/El_Salvador' where entity='purchase_orders' and entity_id=$2 and action='INSERT'`,
      [dates.yesterday,purchase.id]);
      await db.exec('set role authenticated');
      purchase=await command('execute_inventory_command','authorize',{
        purchaseId:purchase.id,expectedVersion:purchase.version,reason:'Authorized today'});
      const budget=await command<{id:string}>('execute_optional_command','budget',{
        name:'Review cutoff',area:'Taller',category:'Materials',startsOn:dates.yesterday,
        endsOn:dates.today,authorized:'100'});
      await command('execute_optional_command','link_purchase',{budgetId:budget.id,purchaseId:purchase.id});
      const position=await rpc<{committed:number}>('budget_position',{
        budget_id:budget.id,cutoff:dates.yesterday});
      assert.equal(position.committed,0,'Future authorization/allocation leaked into the past cutoff');
      // Even if the plan/allocation already existed yesterday, today's authorization must stay out.
      await db.exec('reset role');
      await db.exec('alter table public.operating_budgets disable trigger operating_budget_immutable; alter table public.budget_purchase_links disable trigger budget_purchase_link_immutable');
      await db.query(`update public.operating_budgets set created_at=($1::date+time '12:00') at time zone 'America/El_Salvador' where id=$2`,[dates.yesterday,budget.id]);
      await db.query(`update public.budget_purchase_links set created_at=($1::date+time '12:00') at time zone 'America/El_Salvador' where budget_id=$2`,[dates.yesterday,budget.id]);
      await db.exec('alter table public.operating_budgets enable trigger operating_budget_immutable; alter table public.budget_purchase_links enable trigger budget_purchase_link_immutable; set role authenticated');
      assert.equal((await rpc<{committed:number}>('budget_position',{budget_id:budget.id,cutoff:dates.yesterday})).committed,0);
      assert.equal((await rpc<{committed:number}>('budget_position',{budget_id:budget.id,cutoff:dates.today})).committed,50);
    });
  }finally{await db.close();}
});
