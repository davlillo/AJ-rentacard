import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rentalDateTime,rentalWorkflow,groupVehicleRentals,rentalSection,rentalSectionHref} from '../src/controladores/rental-workflow';
import {operationMoney} from '../src/controladores/operation-money';
import type {Reservation,Commitment} from '../src/lib/supabase/reservations';
import type {CaseFile} from '../src/lib/supabase/cases';

const booking={id:'current',status:'Confirmada',rental_state:'Entregado',starts_at:'2026-11-05T21:52:38Z',
  ends_at:'2026-11-09T21:52:33Z'} as Reservation;
const cleaning={id:'clean',reservation_id:booking.id,kind:'Limpieza',active:true,
  starts_at:'2026-11-05T21:00:00Z',ends_at:'2026-11-05T22:00:00Z'} as Commitment;

test('rental progress uses physical state, not the confirmation label or balance',()=>{
  assert.equal(rentalWorkflow(booking,[]).label,'Alquiler en curso');
  assert.equal(rentalWorkflow(booking,[]).action,'return');
  const prepared={...booking,rental_state:'Preparado'} as Reservation;
  assert.equal(rentalWorkflow(prepared,[]).label,'Reserva confirmada');
  assert.equal(rentalWorkflow(prepared,[]).action,'depart');
  assert.equal(rentalWorkflow({...prepared,status:'Borrador'},[]).action,'confirm');
  assert.equal(rentalWorkflow({...prepared,status:'Cancelada'},[]).action,null);
});

test('return is not complete until its own cleaning is explicitly reviewed',()=>{
  const returned={...booking,rental_state:'Devuelto'} as Reservation;
  assert.equal(rentalWorkflow(returned,[cleaning]).action,'clean');
  assert.equal(rentalWorkflow(returned,[cleaning]).step,2);
  assert.equal(rentalWorkflow(returned,[]).step,2);
  assert.equal(rentalWorkflow(returned,[{...cleaning,reservation_id:'another',active:false}]).step,2);
  assert.equal(rentalWorkflow(returned,[{...cleaning,active:false}]).step,2);
  const reviewed={...returned,actual_return_at:'2026-11-05T20:00:00Z'};
  assert.equal(rentalWorkflow(reviewed,[{...cleaning,active:false,reason:'Readiness reviewed'}]).label,'Alquiler finalizado');
  assert.equal(rentalWorkflow(reviewed,[{...cleaning,active:false,reason:'Readiness reviewed',ends_at:'2099-01-01T00:00:00Z'}]).step,2);
  assert.equal(rentalWorkflow(reviewed,[{...cleaning,active:false,reason:'Readiness reviewed',ends_at:'2026-11-04T00:00:00Z'}]).step,2);
});

test('an inactive conflict or generated cleaning schedule is never completion evidence',()=>{
  const returned={...booking,rental_state:'Devuelto',actual_return_at:'2026-11-05T20:00:00Z'} as Reservation;
  for(const reason of ['CONFLICTO de limpieza tras devolución tardía; requiere reprogramación','Revisión posterior a devolución','']){
    const result=rentalWorkflow(returned,[{...cleaning,active:false,reason}]);
    assert.equal(result.step,2);assert.equal(result.action,'clean');
  }
  assert.match(rentalWorkflow(returned,[{...cleaning,active:false,reason:'CONFLICTO de limpieza'}]).description,/conflicto/i);
  assert.equal(rentalWorkflow({...returned,rental_state:'Cerrado'},[]).step,3);
  assert.equal(rentalWorkflow({...returned,status:'Cancelada'},[]).label,'Reserva cancelada');
  assert.equal(rentalWorkflow({...returned,status:'Borrador'},[]).step,0);
});

test('current rental wins over future bookings and newest records; history stays separate',()=>{
  const future={...booking,id:'future',rental_state:'Preparado',starts_at:'2026-11-16T01:33:00Z'} as Reservation;
  const sooner={...future,id:'sooner',starts_at:'2026-11-12T08:00:00-06:00'};
  const history={...booking,id:'history',rental_state:'Cerrado'} as Reservation;
  const draft={...future,id:'draft',status:'Borrador'} as Reservation;
  const canceled={...future,id:'canceled',status:'Cancelada'} as Reservation;
  const records=[future,history,canceled,draft,sooner,booking];
  const groups=groupVehicleRentals(records,[{...cleaning,reservation_id:'history',active:false}]);
  assert.equal(groups.focus?.id,'current');
  assert.deepEqual(groups.reserved.map(r=>r.id),['sooner','future']);
  assert.deepEqual(groups.history.map(r=>r.id),['canceled','history']);
  assert.deepEqual(groups.drafts.map(r=>r.id),['draft']);
  assert.equal(records[0].id,'future');
  assert.equal(groupVehicleRentals([{...history,rental_state:'Devuelto'},future],[]).focus?.id,'history');
});

test('display dates explicitly use El Salvador, including UTC dates crossing midnight',()=>{
  const utc=rentalDateTime('2026-11-16T01:33:00+00:00');
  assert.equal(utc,rentalDateTime('2026-11-15T19:33:00-06:00'));
  assert.match(utc,/15.*nov.*2026/);
  assert.match(utc,/7:33/);
  assert.doesNotMatch(utc,/T01:33|\+00:00|Invalid/);
  assert.equal(rentalDateTime('infinity'),'Sin fecha final definida');
  assert.equal(rentalDateTime('not-a-date'),'Fecha por revisar');
});

test('action deep links encode identifiers and select only supported sections',()=>{
  const href=rentalSectionHref('a/b & c','Salida y devolución');
  const params=new URL(href,'http://localhost').searchParams;
  assert.equal(params.get('id'),'a/b & c');
  assert.equal(params.get('seccion'),'Salida y devolución');
  assert.equal(rentalSection('Períodos y abonos'),'Cargos y abonos');
  assert.equal(rentalSection('Limpieza'),'Limpieza');
  assert.equal(rentalSection('arbitrary'),'Resumen');
});

test('rental summary keeps historic money out and leaves unpaid balance after return',()=>{
  const current={reservations:[booking],documents:[{scope_amount:180,scope_balance:100}],
    applications:[{kind:'Aplicacion',scope_amount:80}]} as CaseFile;
  const total=operationMoney(current);
  assert.equal(total.charged,180);assert.equal(total.paid,80);assert.equal(total.balance,100);
  assert.equal(operationMoney({...current,reservations:[{...booking,rental_state:'Devuelto'}]}).balance,100);
  const aggregate={...current,documents:[...current.documents!,{scope_amount:135,scope_balance:0}],
    applications:[...current.applications!,{kind:'Aplicacion',scope_amount:135}]} as CaseFile;
  assert.equal(operationMoney(aggregate).charged,315);
  assert.notEqual(total.charged,operationMoney(aggregate).charged);
});
