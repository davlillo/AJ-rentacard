import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';
import {operationMoney} from '../src/controladores/operation-money';
import type {CaseFile} from '../src/lib/supabase/cases';

test('Operation cards and cash diary agree after an approved scope, purchase payment and atomic customer collection',async()=>{
  const {db,command,rpc}=await operationalDb();
  try{
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Isolated operation',phone:'',type:'Personal'});
    const vehicle=await command<{id:string}>('execute_command','create_vehicle',{plate:'OP-MONEY',brand:'Test',model:'Car',year:2026,
      category:'SUV',color:'White',daily:0,km:100,ownership:'Cliente',ownerCustomerId:customer.id,inRentalFleet:false});
    const order=await command<{id:string}>('execute_command','receive_vehicle',{customerId:customer.id,vehicleId:vehicle.id,
      area:'Pintura',service:'Isolated connected finance'});
    const quote=await command<{id:string}>('execute_case_command','quote',{orderId:order.id,parentId:null,reason:'Complete scope',
      lines:[{description:'Repair',kind:'Trabajo',quantity:'1',unitPrice:'2190',unitCost:null}]});
    await command('execute_estimate_command','approve',{estimateId:quote.id,approverName:'Test customer',evidence:'Isolated authorization'});
    const charge=await command<{id:string}>('execute_case_command','bill_scope',{orderId:order.id,date,dueOn:date});
    const purchase=await command<{id:string}>('execute_cost_command','purchase',{orderId:order.id,description:'Material',
      quantity:'1',unitCost:'120',supplier:'Test supplier',sourceReference:'OP-MATERIAL',date});
    let file=await rpc<CaseFile>('vehicle_case_file',{vehicle_id:vehicle.id,order_id:order.id});
    assert.equal(operationMoney(file,order.id).costs,120);assert.equal(operationMoney(file,order.id).cashOut,0);
    await rpc('pay_direct_purchase',{cost_id:purchase.id,payload:JSON.stringify({date,amount:'120',method:'Efectivo',account:'Isolated cash'}),idempotency_key:crypto.randomUUID()});
    const payload={orderId:order.id,documentId:charge.id,amount:'750',date,method:'Efectivo',account:'Isolated cash',reference:'Single receipt'};
    const key=crypto.randomUUID();const collected=await command('execute_case_command','collect',payload,key);
    assert.deepEqual(await command('execute_case_command','collect',payload,key),collected);
    await assert.rejects(command('execute_case_command','collect',{...payload,amount:'1440.01'}),/PAYMENT_EXCEEDS_AVAILABLE_BALANCE/);
    file=await rpc<CaseFile>('vehicle_case_file',{vehicle_id:vehicle.id,order_id:order.id});
    const summary=operationMoney(file,order.id);
    assert.deepEqual({quoted:summary.quoted,costs:summary.costs,cashOut:summary.cashOut,charged:summary.charged,paid:summary.paid,balance:summary.balance},
      {quoted:2190,costs:120,cashOut:120,charged:2190,paid:750,balance:1440});
    assert.equal(file.payments?.length,1);assert.equal(file.expenses?.length,1);assert.equal(file.costs?.length,1);
    const diary=await rpc<{rows:unknown[];income:number;outgoing:number;netMovement:number}>('cash_diary',{from_date:date,to_date:date});
    assert.equal(diary.rows.length,2);assert.equal(diary.income,750);assert.equal(diary.outgoing,120);assert.equal(diary.netMovement,630);
  }finally{await db.close();}
});
