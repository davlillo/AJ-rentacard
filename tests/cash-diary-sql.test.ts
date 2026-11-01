import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('Cash diary: one receipt, no duplicate for application, transfers conserve funds, unknown openings stay unknown',async()=>{
  const {db,command,rpc}=await operationalDb();
  try{
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Cash acceptance',phone:'78904704',type:'Personal'});
    await rpc('record_cash_entry',{payload:JSON.stringify({kind:'Apertura',date:today,account:'Cash',amount:'99.96',concept:'Reviewed opening',reason:'Confirmed balance'}),idempotency_key:crypto.randomUUID()});
    const receipt=await command<{id:string}>('execute_billing_command','pay',{customerId:customer.id,amount:'100',date:today,method:'Efectivo',account:'Cash',reference:'Only one receipt'});
    await command('execute_command','record_expense',{costCenterId:'rental',date:today,concept:'Parking',category:'Airport',amount:'15',method:'Efectivo',account:'Cash'});
    const transfer={payload:JSON.stringify({kind:'Transferencia',date:today,account:'Cash',counterAccount:'Bank',amount:'50',concept:'Remesa',reason:'Deposit same funds'}),idempotency_key:crypto.randomUUID()};
    const saved=await rpc('record_cash_entry',transfer);assert.deepEqual(await rpc('record_cash_entry',transfer),saved);
    interface Diary{rows:{kind:string}[];netMovement:number;balanceAfter:number|null;income:number;outgoing:number;}
    const all=await rpc<Diary>('cash_diary',{from_date:today,to_date:today});
    assert.equal(all.rows.length,4);assert.equal(all.netMovement,85);assert.equal(all.balanceAfter,null);
    const cash=await rpc<Diary>('cash_diary',{from_date:today,to_date:today,account_filter:'Cash'});
    assert.equal(cash.balanceAfter,134.96);assert.equal(cash.outgoing,65);
    const bank=await rpc<Diary>('cash_diary',{from_date:today,to_date:today,account_filter:'Bank'});
    assert.equal(bank.balanceAfter,null);assert.equal(bank.netMovement,50);
    await command('execute_billing_command','refund',{paymentId:receipt.id,amount:'10',date:today,reason:'Unallocated cash refund',refundAccount:'Bank'});
    const updated=await rpc<Diary>('cash_diary',{from_date:today,to_date:today,account_filter:'Bank'});
    assert.equal(updated.netMovement,40);
    assert.equal((await db.query('select id from public.customer_payments')).rows.length,1);
  }finally{await db.close();}
});
