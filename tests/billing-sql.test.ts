import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('HU18/HU19 persistent payment applications, historical aging and debt after cancellation',async t=>{
  const {db,owner,technician,asUser,command,rpc}=await operationalDb();
  try{
    const date=(await db.query<{date:string}>("select (now() at time zone 'America/El_Salvador')::date::text date")).rows[0].date;
    const previous=(await db.query<{date:string}>("select ((now() at time zone 'America/El_Salvador')::date-10)::text date")).rows[0].date;
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Billing customer',phone:'78901922',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'BILL-1',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:50,km:0,ownership:'Propio'});
    const booking=await command<{id:string;version:number}>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,
      startsAt:'2030-02-01T12:00:00Z',endsAt:'2030-02-11T12:00:00Z',dailyRate:'50',cleaningMinutes:0});
    const bill=(name:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>command<{id:string}>('execute_billing_command',name,payload,key);
    let document:{id:string};let payment:{id:string};
    await t.test('500 charge with 200 payment/application leaves 300; a retry never reapplies money',async()=>{
      document=await bill('issue',{reservationId:booking.id,description:'Rental charge',amount:'500',date:previous,dueOn:previous});
      payment=await bill('pay',{customerId:customer.id,amount:'200',date,method:'Efectivo',account:'Synthetic cashbox',reference:'Receipt test'});
      const payload={paymentId:payment.id,documentId:document.id,amount:'200',date};const key=crypto.randomUUID();
      const application=await bill('apply',payload,key);assert.deepEqual(await bill('apply',payload,key),application);
      const rows=await rpc<{id:string;balance:number;days_overdue:number}[]>('receivables_at',{cutoff:date});
      assert.equal(rows.find(row=>row.id===document.id)?.balance,300);assert.equal(rows.find(row=>row.id===document.id)?.days_overdue,10);
      assert.equal(await rpc('reservation_payment_status',{reservation_id:booking.id}),'Parcial');
      await assert.rejects(bill('apply',{...payload,amount:'1'}),/PAYMENT_EXCEEDS_AVAILABLE_BALANCE/);
    });
    await t.test('cancellation preserves debt/history; historical cutoff excludes later-recorded entries',async()=>{
      await command('execute_reservation_command','cancel',{reservationId:booking.id,expectedVersion:booking.version,reason:'Customer cancellation does not delete charge'});
      assert.equal((await rpc<{balance:number}[]>('receivables_at',{cutoff:date}))[0].balance,300);
      assert.equal((await rpc<unknown[]>('receivables_at',{cutoff:previous})).length,0);
      await assert.rejects(db.exec('update public.customer_payments set amount=1'),/permission denied/);
    });
    await t.test('refund reverses an application without deleting cash history or issuing a negative automatic charge',async()=>{
      await bill('refund',{paymentId:payment.id,documentId:document.id,amount:'50',date,reason:'Customer refund authorized'});
      assert.equal((await rpc<{balance:number}[]>('receivables_at',{cutoff:date}))[0].balance,350);
      assert.equal((await db.query('select * from public.payment_refunds')).rows.length,1);
      assert.equal((await db.query('select * from public.customer_payments')).rows.length,1);
      await assert.rejects(bill('refund',{paymentId:payment.id,documentId:document.id,amount:'151',date,reason:'Over refund'}),/REFUND_EXCEEDS_APPLICATION/);
      await asUser(technician);assert.equal((await db.query('select * from public.customer_payments')).rows.length,0);
      await assert.rejects(rpc('receivables_at',{cutoff:date}),/PERMISSION_DENIED/);await asUser(owner);
    });
  }finally{await db.close();}
});
