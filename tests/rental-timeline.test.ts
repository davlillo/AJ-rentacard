import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rentalTimeline,timelineDays,timelineSegment,shiftTimelineDay} from '../src/controladores/rental-timeline';
import type {Reservation,Commitment} from '../src/lib/supabase/reservations';
import type {Vehicle} from '../src/types';

test('Gantt ranges use Salvador day boundaries and remain stable across months and leap years',()=>{
  assert.equal(timelineDays('2026-11-28',7).at(-1),'2026-12-04');
  assert.equal(timelineDays('2028-02-28',7)[1],'2028-02-29');
  assert.deepEqual(timelineDays('2026-02-31',7),[]);assert.deepEqual(timelineDays('invalid',14),[]);
  assert.deepEqual(timelineDays('2026-11-05',0),[]);assert.equal(shiftTimelineDay('2026-12-31',1),'2027-01-01');
});
test('Gantt clips intervals, preserves open ends and never spills over the rendered period',()=>{
  const full=timelineSegment('2026-11-01T00:00:00-06:00','infinity','2026-11-05',7)!;
  assert.deepEqual(full,{left:0,width:100,continuesBefore:true,continuesAfter:true});
  assert.equal(timelineSegment('2026-11-01T00:00:00-06:00','2026-11-05T00:00:00-06:00','2026-11-05',7),null);
  assert.equal(timelineSegment('2026-11-12T00:00:00-06:00','infinity','2026-11-05',7),null);
  const half=timelineSegment('2026-11-05T12:00:00-06:00','2026-11-06T00:00:00-06:00','2026-11-05',7)!;
  assert.ok(Math.abs(half.left-100/14)<1e-8);assert.ok(Math.abs(half.width-100/14)<1e-8);
  assert.equal(timelineSegment('bad','infinity','2026-11-05',7),null);
  assert.equal(timelineSegment('2026-11-06','2026-11-05','2026-11-05',7),null);
});
test('Gantt uses actual confirmed operations, omits returned/draft/canceled bookings and avoids duplicate reservation blocks',()=>{
  const car={id:'car',plate:'DEMO-101'} as Vehicle;
  const booking={id:'active',vehicle_id:'car',customer_snapshot:{name:'Demo customer'},status:'Confirmada',rental_state:'Entregado',
    starts_at:'2026-11-05T08:00:00-06:00',ends_at:'2026-11-08T08:00:00-06:00'} as Reservation;
  const bookings=[booking,{...booking,id:'future',rental_state:'Preparado',starts_at:'2026-11-09T08:00:00-06:00'},
    {...booking,id:'draft',status:'Borrador'},{...booking,id:'canceled',status:'Cancelada'},
    {...booking,id:'returned',rental_state:'Devuelto'}] as Reservation[];
  bookings[1].ends_at='2026-11-11T08:00:00-06:00';
  const block={id:'block',vehicle_id:'car',active:true,kind:'Reserva',starts_at:booking.starts_at,ends_at:booking.ends_at} as Commitment;
  const rows=rentalTimeline([car,{id:'other'} as Vehicle],bookings,[block,{...block,id:'clean',kind:'Limpieza'},
    {...block,id:'old',kind:'Taller',ends_at:'2026-11-04T08:00:00-06:00'}],'2026-11-05',7,Date.parse('2026-11-05T12:00:00Z'));
  assert.deepEqual(rows[0].events.map(e=>e.kind),['Alquilado','Limpieza','Reservado']);
  assert.equal(rows[0].events[0].reservationId,'active');assert.equal(rows[1].events.length,0);
  assert.ok(rows[0].events.every(e=>e.left>=0&&e.width>0&&e.left+e.width<=100));
});
