import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';
import {rentalWorkflow} from '../src/controladores/rental-workflow';
import {operationMoney} from '../src/controladores/operation-money';
import type {CaseFile} from '../src/lib/supabase/cases';
import type {Reservation} from '../src/lib/supabase/reservations';

test('physical rental completion and contextual collection remain independent and idempotent',async()=>{
  const {db,command,rpc}=await operationalDb();
  try{
    const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'});
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Workflow customer',phone:'78905601',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'FLOW-601',brand:'Test',model:'Car',year:2026,
      category:'Sedán',color:'White',daily:'45',km:100,ownership:'Propio'});
    let booking=await command<Reservation>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,
      startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+3*86400000).toISOString(),dailyRate:'45',cleaningMinutes:60});
    booking=await command('execute_reservation_command','confirm',{reservationId:booking.id,expectedVersion:booking.version});
    assert.equal(rentalWorkflow(booking,[]).action,'depart');
    const inspection={reservationId:booking.id,km:100,fuel:100,condition:'No damage',accessories:'Spare tire',evidence:'Handover reviewed'};
    booking=(await command<{reservation:Reservation}>('execute_rental_command','depart',{...inspection,expectedVersion:booking.version})).reservation;
    const document=await command<{id:string}>('execute_billing_command','issue',{reservationId:booking.id,amount:'180',date:today,dueOn:today,description:'Agreed rental'});
    const receipt=(amount:string)=>({documentId:document.id,amount,date:today,method:'Efectivo',account:'Test cash',reference:'Rental payment'});
    await rpc('collect_document',{payload:JSON.stringify(receipt('80')),idempotency_key:crypto.randomUUID()});
    assert.equal(rentalWorkflow(booking,[]).action,'return');
    await command('execute_rental_command','return',{...inspection,expectedVersion:booking.version,km:120,evidence:'Return reviewed'});
    let file=await rpc<CaseFile>('rental_case_file',{reservation_id:booking.id});
    assert.equal(rentalWorkflow(file.reservations[0],file.commitments).action,'clean');
    assert.equal(operationMoney(file).balance,100);
    const cleaning=file.commitments.find(c=>c.kind==='Limpieza'&&c.active)!;
    const payload={blockId:cleaning.id,reason:'Cleaning and vehicle condition reviewed'};const key=crypto.randomUUID();
    const saved=await command('execute_reservation_command','finish_block',payload,key);
    assert.deepEqual(await command('execute_reservation_command','finish_block',payload,key),saved);
    file=await rpc('rental_case_file',{reservation_id:booking.id});
    assert.equal(file.vehicle.status,'Disponible');
    assert.equal(rentalWorkflow(file.reservations[0],file.commitments).step,3);
    assert.equal(operationMoney(file).balance,100);
    assert.equal(file.documents?.length,1);
    const finalArgs={payload:JSON.stringify(receipt('100')),idempotency_key:crypto.randomUUID()};
    const collected=await rpc('collect_document',finalArgs);
    assert.deepEqual(await rpc('collect_document',finalArgs),collected);
    file=await rpc('rental_case_file',{reservation_id:booking.id});
    assert.equal(operationMoney(file).balance,0);
    assert.equal((await db.query('select id from public.customer_payments')).rows.length,2);
    assert.equal((await db.query('select id from public.billing_documents')).rows.length,1);
  }finally{await db.close();}
});
