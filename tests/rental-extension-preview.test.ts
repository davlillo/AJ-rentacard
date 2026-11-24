import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Reservation} from '../src/lib/supabase/reservations';
const preview=()=>import('../src/controladores/rental-extension-preview');
const booking={id:'fixture',version:4,status:'Confirmada',rental_state:'Entregado',open_ended:false,
  starts_at:'2030-01-01T12:00:00Z',ends_at:'2030-01-03T12:00:00Z',daily_rate:50,total:100} as Reservation;

test('three extra hours match the SQL 100 to 150 forecast example without creating a charge',async()=>{
  const {rentalExtensionPreview}=await preview();
  const result=rentalExtensionPreview(booking,'2030-01-03T15:00:00Z','Three extra hours');
  assert.equal(result.currentForecast,100);assert.equal(result.newForecast,150);assert.equal(result.difference,50);
  assert.equal(result.command,'extend');assert.equal(result.payload.expectedVersion,4);
  assert.equal(result.payload.reservationId,'fixture');assert.equal(result.days,3);
  assert.deepEqual(Object.keys(result.payload).sort(),['endsAt','expectedVersion','reason','reservationId']);
});

test('an extension inside the same rounded 24-hour day naturally has no forecast increase',async()=>{
  const {rentalExtensionPreview}=await preview();
  const result=rentalExtensionPreview({...booking,ends_at:'2030-01-03T13:00:00Z',total:150},'2030-01-03T15:00:00Z','Same day');
  assert.equal(result.difference,0);assert.equal(result.newForecast,150);
  const cents=rentalExtensionPreview({...booking,daily_rate:33.33,total:66.66},'2030-01-03T15:00:00Z','Cents');
  assert.equal(cents.newForecast,99.99);assert.equal(cents.difference,33.33);
});

test('open-ended agreement has an unknown current forecast, not a fabricated zero-price difference',async()=>{
  const {rentalExtensionPreview}=await preview();
  const result=rentalExtensionPreview({...booking,open_ended:true,ends_at:'infinity',total:0},
    '2030-01-03T12:00:00Z','End now agreed',Date.parse('2030-01-02T12:00:00Z'));
  assert.equal(result.command,'set_end');assert.equal(result.currentForecast,null);assert.equal(result.difference,null);
  assert.equal(result.newForecast,100);
});

test('invalid dates, earlier ends, missing reasons, closed states and stale reinterpretation are rejected',async()=>{
  const {rentalExtensionPreview}=await preview();
  for(const end of ['','infinity','bad date','2030-01-01T12:00:00Z','2030-01-03T12:00:00Z']){
    assert.throws(()=>rentalExtensionPreview(booking,end,'Reason'));
  }
  assert.throws(()=>rentalExtensionPreview(booking,'2030-01-04T12:00:00Z','  '));
  assert.throws(()=>rentalExtensionPreview({...booking,rental_state:'Devuelto'},'2030-01-04T12:00:00Z','Reason'));
  assert.throws(()=>rentalExtensionPreview({...booking,open_ended:true,ends_at:'infinity'},'2029-01-04T12:00:00Z','Reason',Date.parse('2030-01-02T00:00:00Z')));
  const result=rentalExtensionPreview(booking,'2030-01-03T15:00:00Z','Reason');
  assert.ok(Object.isFrozen(result.payload));
  assert.equal(result.payload.expectedVersion,4);
});
