import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {creationPayload,createRentalAttempt,saveRentalDraft,confirmRentalDraft} from '../src/controladores/rental-create';

const input={customerId:'customer',vehicleId:'vehicle',startsAt:'2030-01-01T08:00',endsAt:'2030-01-03T08:00',
  openEnded:false,dailyRate:'50.00',cleaningMinutes:'60'};
const draft={id:'draft',version:7,status:'Borrador',rental_state:'Preparado'};

test('creation validates parties, dates, money precision and cleaning before any command',()=>{
  for(const patch of [{customerId:''},{vehicleId:''},{endsAt:input.startsAt},{dailyRate:'1.001'},
    {dailyRate:'-1'},{cleaningMinutes:'1.2'},{startsAt:'invalid'}]){
    assert.throws(()=>creationPayload({...input,...patch}));
  }
});
test('Salvador dates and open rental forecasts preserve canonical payload semantics',()=>{
  assert.equal(creationPayload(input).startsAt,'2030-01-01T14:00:00.000Z');
  assert.equal(creationPayload({...input,openEnded:true,endsAt:''}).endsAt,null);
});
test('ambiguous create retains identical payload and retry identity without creating another draft',async()=>{
  const attempt=createRentalAttempt(creationPayload(input),()=> 'retry');
  const calls:unknown[]=[];let fail=true;
  const command=async(...args:unknown[])=>{calls.push(args);if(fail)throw Error('offline');return draft;};
  const journal:unknown[]=[];
  await assert.rejects(saveRentalDraft(attempt,command,value=>journal.push({...value})));
  fail=false;await saveRentalDraft(attempt,command,value=>journal.push({...value}));
  await saveRentalDraft(attempt,command,value=>journal.push({...value}));
  assert.deepEqual(calls[0],calls[1]);assert.equal(calls.length,2);
  assert.deepEqual(journal[0],{key:'retry'});
  assert.equal(attempt.saved?.id,'draft');
});
test('confirmation failure retries only confirm with the saved version and independent key',async()=>{
  let next=0;const attempt=createRentalAttempt(creationPayload(input),()=>String(++next));
  const calls:unknown[][]=[];let fail=true;
  const command=async(...args:unknown[])=>{calls.push(args);if(args[0]==='create')return draft;
    if(fail)throw Error('conflict');return {...draft,status:'Confirmada',version:8};};
  await saveRentalDraft(attempt,command,()=>{});
  await assert.rejects(confirmRentalDraft(attempt,command));
  fail=false;await confirmRentalDraft(attempt,command);
  assert.equal(calls.filter(call=>call[0]==='create').length,1);
  assert.deepEqual(calls[1],['confirm',{reservationId:'draft',expectedVersion:7},'2']);
  assert.deepEqual(calls[1],calls[2]);
});
test('persistence failure prevents create and confirmation never runs without a saved draft',async()=>{
  const attempt=createRentalAttempt(creationPayload(input),()=> 'key');let count=0;
  const command=async()=>{count++;return draft;};
  await assert.rejects(saveRentalDraft(attempt,command,()=>{throw Error('storage unavailable');}));
  await assert.rejects(confirmRentalDraft(attempt,command));assert.equal(count,0);
});
test('creation does not add cash, billing, departure or duplicate customer forms',()=>{
  const source=readFileSync('src/components/templates/rental-create-screen.tsx','utf8');
  assert.ok(source.includes("open('cliente')"));
  assert.ok(source.includes("can('customers.write')"));
  assert.ok(source.includes('aria-label="Cliente del alquiler"'));
  assert.ok(source.includes('aria-label="Vehículo del alquiler"'));
  for(const forbidden of ['execute_rental_command','record_payment','create_customer','record_expense']){
    assert.ok(!source.includes(forbidden),forbidden);
  }
});
test('rental entry changes leave calendar legacy modal and preview components intact',()=>{
  const source=readFileSync('src/components/templates/operational-calendar.tsx','utf8');
  assert.ok(source.includes('/alquileres/nuevo/'));
  assert.ok(source.includes('Nueva reserva'));
  for(const existing of ['<RentalMonthCalendar','<RentalGantt','<Dialog open={create}','<Pagination {...bookingPage}/>']){
    assert.ok(source.includes(existing),existing);
  }
});
test('rental creation omits the redundant forecast sidebar without removing agreement review',()=>{
  const source=readFileSync('src/components/templates/rental-create-screen.tsx','utf8');
  assert.ok(!source.includes('aria-label="Resumen previsto"'));
  assert.ok(!source.includes('PREVISIÓN DEL ACUERDO'));
  assert.ok(source.includes('Revisar acuerdo'));
  assert.ok(source.includes('Tarifa diaria'));
});
