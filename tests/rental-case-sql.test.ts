import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('Separate rental cases never inherit another rental balance; receipt+application is atomic and repeatable',async()=>{
  const {db,command,rpc}=await operationalDb();
  try{
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Rental case acceptance',phone:'78904708',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'RENTAL-CASE',brand:'Test',model:'Case',year:2026,category:'SUV',color:'White',daily:'40',km:'0',ownership:'Propio'});
    const bookings:{id:string}[]=[];
    for(let i=0;i<2;i++){
      const b=await command<{id:string}>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,
        startsAt:new Date(Date.now()+(i+1)*86400000).toISOString(),endsAt:new Date(Date.now()+(i+2)*86400000).toISOString(),dailyRate:'40'});
      bookings.push(b);await command('execute_billing_command','issue',{reservationId:b.id,amount:i===0?'100':'200',date:today,dueOn:today,description:`Rental ${i}`});
    }
    const first=await rpc<{documents:{id:string;scope_amount:number}[]}>('rental_case_file',{reservation_id:bookings[0].id});
    assert.equal(first.documents.length,1);assert.equal(first.documents[0].scope_amount,100);
    const payload={documentId:first.documents[0].id,amount:'75',date:today,method:'Efectivo',account:'Rental case cash',reference:'Receipt inside rental case'};
    const args={payload:JSON.stringify(payload),idempotency_key:crypto.randomUUID()};
    const saved=await rpc('collect_document',args);assert.deepEqual(await rpc('collect_document',args),saved);
    await assert.rejects(rpc('collect_document',{payload:JSON.stringify({...payload,amount:'30'}),idempotency_key:crypto.randomUUID()}),/PAYMENT_EXCEEDS_AVAILABLE_BALANCE/);
    assert.equal((await db.query('select id from public.customer_payments')).rows.length,1);
    const second=await rpc<{documents:{scope_balance:number}[]}>('rental_case_file',{reservation_id:bookings[1].id});
    assert.equal(second.documents[0].scope_balance,200);
  }finally{await db.close();}
});
