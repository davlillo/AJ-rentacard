import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Reservation,RentalInspection} from '../src/lib/supabase/reservations';

const booking={id:'fixture',version:4,status:'Confirmada',rental_state:'Preparado',
  vehicle_snapshot:{km:100},customer_snapshot:{name:'Fixture customer'}} as Reservation;
const flow=()=>import('../src/controladores/rental-inspection-flow');

test('inspection submission never chooses its command from refreshed rental state',()=>{
  const source=readFileSync('src/components/organisms/rental-inspection.tsx','utf8');
  assert.doesNotMatch(source,/submit\(booking\.rental_state==='Preparado'\?'depart':'return'/);
});

test('explicit phase changes create blank drafts, never reuse departure observations',async()=>{
  const {startInspection}=await flow();
  const departure=startInspection(booking,'departure');
  departure.review='Departure only';departure.km='100';departure.fuel='90';
  const incoming=startInspection({...booking,rental_state:'Entregado',version:5},'return');
  assert.equal(incoming.review,'');assert.equal(incoming.km,'');assert.equal(incoming.fuel,'');
  assert.equal(incoming.command,'return');assert.equal(departure.command,'depart');
});

test('confirmation freezes command, version, identity and readings across refreshed props',async()=>{
  const {startInspection,confirmInspection}=await flow();
  const draft={...startInspection(booking,'departure'),km:'100',fuel:'90',review:'Ready'};
  const confirmed=confirmInspection(draft,100,'2026-11-14T12:00:00Z');
  booking.version=9;booking.rental_state='Entregado';
  assert.equal(confirmed.command,'depart');assert.equal(confirmed.payload.expectedVersion,4);
  assert.equal(confirmed.payload.reservationId,'fixture');assert.equal(confirmed.payload.km,100);
  assert.ok(Object.isFrozen(confirmed));assert.ok(Object.isFrozen(confirmed.payload));
  draft.km='900';assert.equal(confirmed.payload.km,100);
  assert.equal(draft.review,'Ready');
  booking.version=4;booking.rental_state='Preparado';
});

test('both phases require whole nonnegative kilometres and 0–100 fuel percentages',async()=>{
  const {startInspection,confirmInspection}=await flow();
  for(const intent of ['departure','return'] as const){
    const current={...booking,rental_state:intent==='departure'?'Preparado':'Entregado'} as Reservation;
    const draft={...startInspection(current,intent),km:'100',fuel:'0',review:'Reviewed'};
    for(const km of ['', '-1','1.5','NaN','Infinity','2147483648'])assert.throws(()=>confirmInspection({...draft,km},0));
    for(const fuel of ['', '-1','100.01','1.001','NaN','Infinity'])assert.throws(()=>confirmInspection({...draft,fuel},0));
    assert.equal(confirmInspection({...draft,km:'0',fuel:'100'},0).payload.fuel,100);
    assert.throws(()=>confirmInspection({...draft,review:'   '},0));
  }
});

test('return baseline uses the last known odometer even after unknown legacy departure',async()=>{
  const {inspectionBaseline,readingLabel}=await flow();
  const unknown={kind:'Salida',km:null,fuel:null} as RentalInspection;
  assert.equal(inspectionBaseline(booking,[unknown]),100);
  assert.equal(inspectionBaseline(booking,[{...unknown,km:140}]),140);
  assert.equal(inspectionBaseline({...booking,vehicle_snapshot:{...booking.vehicle_snapshot,km:0,unverified_fields:['km']}},[unknown]),null);
  assert.equal(readingLabel(null,'km'),'Sin registro');
  assert.equal(readingLabel(null,'%'),'Sin registro');
  assert.equal(readingLabel(0,'%'),'0 %');
  assert.equal(readingLabel(undefined,'km'),'Sin registro');
});

test('return cannot decrease the baseline; legitimate immediate returns have no time lock',async()=>{
  const {startInspection,confirmInspection}=await flow();
  const draft={...startInspection({...booking,rental_state:'Entregado'},'return'),km:'99',fuel:'45.5',review:'Returned'};
  assert.throws(()=>confirmInspection(draft,100),/kilometraje/i);
  assert.equal(confirmInspection({...draft,km:'100'},100).command,'return');
  assert.throws(()=>startInspection(booking,'return'));
  assert.throws(()=>startInspection({...booking,status:'Cancelada'},'departure'));
});
