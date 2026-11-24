import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import type {Reservation,Commitment} from '../src/lib/supabase/reservations';
import {rentalWorkflow,rentalCleaningStatus,rentalCleaningReviewable,returnCleaningConflictReason} from '../src/controladores/rental-workflow';

const release='src/components/organisms/vehicle-release-review.tsx';

test('the release review lives on the vehicle side and not in the rental folio',()=>{
  assert.equal(existsSync('src/components/organisms/rental-cleaning.tsx'),false);
  const source=readFileSync(release,'utf8');
  // The shared review proof instead of treating every inactive block as reviewed.
  assert.doesNotMatch(source,/const reviewed=returned&&cleaning.length>0&&!cleaning.some/);
  assert.ok(source.includes('rentalCleaningStatus'));
  assert.ok(source.includes('rentalCleaningReviewable'));
});

test('the release review uses an explicit confirmed intent and both optimistic versions',()=>{
  const source=readFileSync(release,'utf8');
  assert.ok(source.includes('review_return_cleaning'));
  assert.ok(source.includes('expectedVehicleVersion'));
  assert.ok(source.includes('Confirmar entrega y liberar el vehículo'));
  // The wording is about availability, never about a cleaning module.
  assert.doesNotMatch(source,/limpieza/i);
});

test('finish_block facts can complete a returned folio without changing rental_state to Cerrado',()=>{
  const booking={id:'fixture',status:'Confirmada',rental_state:'Devuelto',
    actual_return_at:'2026-01-01T12:00:00Z'} as Reservation;
  const block={id:'clean',reservation_id:'fixture',kind:'Limpieza',active:false,
    starts_at:'2026-01-01T12:00:01Z',ends_at:'2026-01-01T12:05:00Z',reason:'Readiness reviewed'} as Commitment;
  assert.equal(rentalWorkflow(booking,[block]).step,3);
  assert.equal(rentalWorkflow(booking,[{...block,reason:'CONFLICTO de limpieza tras devolución tardía; requiere reprogramación'}]).step,2);
  assert.equal(rentalWorkflow(booking,[{...block,active:true}]).step,2);
});

test('review eligibility accepts only matching active cleaning or the exact generated return conflict',()=>{
  const booking={id:'fixture',vehicle_id:'car',status:'Confirmada',rental_state:'Devuelto',
    actual_return_at:'2026-01-01T12:00:00Z'} as Reservation;
  const block={id:'clean',vehicle_id:'car',reservation_id:'fixture',order_id:null,kind:'Limpieza',active:false,
    starts_at:'2026-01-01T12:00:01Z',ends_at:'2026-01-01T12:05:00Z',reason:returnCleaningConflictReason} as Commitment;
  assert.equal(rentalCleaningReviewable(booking,block),true);
  assert.equal(rentalCleaningReviewable(booking,{...block,active:true,reason:'Active return cleaning'}),true);
  for(const change of [{reason:'Unknown inactive block'},{order_id:'OT-1'},{vehicle_id:'another'},{reservation_id:'another'},
    {starts_at:'2099-01-01T00:00:00Z'},{starts_at:'2025-01-01T00:00:00Z'}]){
    assert.equal(rentalCleaningReviewable(booking,{...block,...change}),false);
  }
  assert.equal(rentalCleaningReviewable({...booking,status:'Cancelada'},block),false);
  assert.equal(rentalCleaningReviewable({...booking,actual_return_at:null},block),false);
  const reviewed={...block,reason:'Revisión de limpieza confirmada: CONFLICTO inspected and resolved'};
  assert.equal(rentalCleaningStatus(booking,[reviewed]).conflict,false);
  assert.equal(rentalCleaningStatus(booking,[reviewed]).reviewed,true);
});
