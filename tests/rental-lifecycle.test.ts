import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rentalElapsed,rentalLifecycle,reviewRentalPeriod} from '../src/controladores/rental-lifecycle';
import {rentalWorkflow} from '../src/controladores/rental-workflow';
import type {Reservation} from '../src/lib/supabase/reservations';

const booking={id:'rental',version:4,status:'Confirmada',rental_state:'Entregado',
  starts_at:'2026-11-01T12:00:00-06:00',ends_at:'2026-11-08T12:00:00-06:00',
  actual_departure_at:'2026-11-02T12:00:00-06:00',daily_rate:50,total:350} as Reservation;
const now=Date.parse('2026-11-04T13:00:00-06:00');

test('the derived stage follows the vehicle state and never a selected view',()=>{
  for(const [record,stage] of [
    [{...booking,status:'Borrador'},0],[{...booking,rental_state:'Preparado'},0],
    [booking,2],[{...booking,rental_state:'Devuelto'},3],[{...booking,rental_state:'Cerrado'},3],
    [{...booking,status:'Cancelada'},null],
  ] as [Reservation,number|null][]){
    assert.equal(rentalLifecycle(record,rentalWorkflow(record,[])).current,stage);
  }
});

test('a returned rental with pending money stays in Cuentas and only a settled one is Finalizado',()=>{
  const returned={...booking,rental_state:'Cerrado'} as Reservation;
  const pending=rentalLifecycle(returned,rentalWorkflow(returned,[]),
    {charged:120,balance:80,paid:40,advances:0,agreed:350,estimate:150});
  assert.equal(pending.current,3);
  assert.equal(pending.stages.find(stage=>stage.label==='Cuentas')?.current,true);
  assert.equal(pending.stages.find(stage=>stage.label==='Finalizado')?.current,false);
  const settled=rentalLifecycle(returned,rentalWorkflow(returned,[]),
    {charged:350,balance:0,paid:350,advances:0,agreed:350,estimate:150});
  assert.equal(settled.current,4);
  assert.equal(settled.stages.find(stage=>stage.label==='Cuentas')?.complete,true);
  assert.equal(settled.stages.find(stage=>stage.label==='Finalizado')?.current,true);
});

test('elapsed day uses actual departure and the original planned duration; estimates are not debt',()=>{
  const result=rentalElapsed(booking,now);
  assert.equal(result.day,3);assert.equal(result.plannedDays,7);
  assert.equal(result.estimate,150);assert.equal(result.overdue,false);
  assert.equal(result.basis,'actual');assert.equal(result.frozen,false);
  assert.equal(rentalElapsed({...booking,status:'Borrador'},now).day,null);
  assert.equal(rentalElapsed({...booking,rental_state:'Preparado'},now).estimate,null);
  assert.equal(rentalElapsed({...booking,status:'Cancelada'},now).day,null);
  assert.equal(rentalElapsed({...booking,actual_departure_at:null},now).basis,'scheduled');
});

test('return freezes accrual, missing or invalid evidence stays unknown, open rentals have no invented end',()=>{
  const returned={...booking,rental_state:'Devuelto',actual_return_at:'2026-11-03T12:00:00-06:00'} as Reservation;
  assert.deepEqual(rentalElapsed(returned,now),rentalElapsed(returned,now+864000000));
  assert.equal(rentalElapsed(returned,now).estimate,50);
  assert.equal(rentalElapsed({...returned,actual_return_at:null},now).day,null);
  for(const invalid of ['bad','2026-02-30T12:00:00Z','']){
    assert.equal(rentalElapsed({...booking,actual_departure_at:invalid},now).day,null);
  }
  assert.equal(rentalElapsed({...booking,actual_departure_at:'2099-01-01T00:00:00Z'},now).day,null);
  assert.equal(rentalElapsed({...booking,open_ended:true,ends_at:'infinity'},now).plannedDays,null);
  assert.equal(rentalElapsed({...booking,open_ended:true,ends_at:'infinity'},now).overdue,false);
  assert.equal(rentalElapsed(booking,Date.parse('2026-11-09T00:00:00-06:00')).overdue,true);
  assert.equal(rentalElapsed({...booking,ends_at:'invalid'},now).plannedDays,null);
});

test('Salvador local date-times do not depend on the browser zone',()=>{
  assert.deepEqual(rentalElapsed({...booking,actual_departure_at:'2026-11-02T12:00:00'},now),rentalElapsed(booking,now));
  assert.equal(rentalElapsed({...booking,daily_rate:NaN},now).estimate,null);
});

test('period review freezes the explicit amount/version and rejects inclusive overlap and invalid dates',()=>{
  const input={startsOn:'2026-11-02',endsOn:'2026-11-03',date:'2026-11-04',dueOn:'2026-11-04',amount:'75.00',reason:'Agreed early return'};
  const result=reviewRentalPeriod(booking,input,[]);
  assert.equal(result.payload.amount,'75.00');assert.equal(result.payload.expectedVersion,4);
  assert.equal(result.payload.reservationId,booking.id);assert.ok(Object.isFrozen(result.payload));
  assert.throws(()=>reviewRentalPeriod(booking,input,[{starts_on:'2026-11-03',ends_on:'2026-11-04'}]),/superpone/);
  assert.throws(()=>reviewRentalPeriod(booking,{...input,startsOn:'2026-02-30'},[]),/fechas/);
  assert.throws(()=>reviewRentalPeriod(booking,{...input,amount:'1.001'},[]),/importe/);
  assert.throws(()=>reviewRentalPeriod(booking,{...input,reason:' '},[]),/acuerdo/);
});
