import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activeWorkshopOrders,currentCommitments,dashboardCashSeries,dashboardFleet,dashboardReceivables,
  dashboardRentals,shiftDay,validDashboardPeriod} from '../src/controladores/dashboard';
import type {Vehicle,ReservationHistory,WorkOrder} from '../src/types';
import type {Commitment} from '../src/lib/supabase/reservations';
import type {DiaryRow} from '../src/lib/supabase/diary';
import type {Receivable} from '../src/lib/supabase/billing';

const now=Date.parse('2026-11-12T16:00:00Z');
const vehicle=(id:string,status:Vehicle['status']='Disponible'):Vehicle=>({id,plate:id,brand:'Test',model:'Unit',
  category:'Sedán',color:'Blue',year:2020,km:100,daily:30,status,inRentalFleet:true});
const booking=(id:string,overrides:Partial<ReservationHistory>={}):ReservationHistory=>({
  id,vehicleId:id,customerId:'customer',start:'2026-11-13T16:00:00Z',end:'2026-11-14T16:00:00Z',
  status:'Confirmada',rentalState:'Preparado',...overrides});
const block=(vehicleId:string,overrides:Partial<Commitment>={}):Commitment=>({id:vehicleId,vehicle_id:vehicleId,
  order_id:null,reservation_id:null,kind:'Limpieza',starts_at:'2026-11-12T15:00:00Z',
  ends_at:'2026-11-12T17:00:00Z',active:true,reason:'Unit test',...overrides});
const row=(date:string,inflow:number,outflow=0):DiaryRow=>({id:date,date,inflow,outflow,amount:inflow||outflow,
  account:null,counter_account:null,area:'Test',destination:'Test',source_type:'Test',kind:'Test',concept:'Test',balance_effect:inflow-outflow});

test('Dashboard validates real inclusive ranges of at most 366 days, without future dates',()=>{
  assert.equal(shiftDay('2026-03-01',-1),'2026-02-28');
  for(const range of [{from:'2026-11-12',to:'2026-11-12'},{from:'2025-11-12',to:'2026-11-12'}])
    assert.equal(validDashboardPeriod(range,'2026-11-12'),true);
  for(const range of [{from:'2026-02-30',to:'2026-03-03'},{from:'',to:'2026-11-12'},
    {from:'2026-11-13',to:'2026-11-12'},{from:'2025-11-11',to:'2026-11-12'},
    {from:'2026-11-12',to:'2026-11-13'}])assert.equal(validDashboardPeriod(range,'2026-11-12'),false);
});

test('Dashboard cash periods include cross-month days, aggregate cents once and exclude document links',()=>{
  const result=dashboardCashSeries([row('2026-10-31',0.1),row('2026-10-31',0.2),row('2026-11-01',0,10),
    {...row('2026-11-01',0,5),links:[{orderId:'OT-1',reservationId:null,amount:5,kind:'cost'}]},
    {...row('2026-11-01',0),amount:999,kind:'Transferencia'},row('2026-10-30',999),row('2026-11-02',999)],
  {from:'2026-10-31',to:'2026-11-01'});
  assert.equal(result.income,0.3);assert.equal(result.outgoing,15);assert.equal(result.net,-14.7);
  assert.deepEqual(result.points,[{from:'2026-10-31',to:'2026-10-31',inflow:0.3,outflow:0},
    {from:'2026-11-01',to:'2026-11-01',inflow:0,outflow:15}]);
});

test('Dashboard long ranges aggregate weekly without dropping boundary days or inventing totals',()=>{
  const result=dashboardCashSeries([row('2026-01-01',1),row('2026-03-10',2),row('2026-03-09',0,4)],
    {from:'2026-01-01',to:'2026-03-10'});
  assert.equal(result.granularity,'Semanal');assert.equal(result.points.length,10);
  assert.equal(result.points.at(-1)?.to,'2026-03-10');
  assert.equal(result.points.reduce((sum,point)=>sum+point.inflow,0),result.income);
  assert.equal(result.income,3);assert.equal(result.outgoing,4);
  assert.equal(dashboardCashSeries([],{from:'2026-11-12',to:'2026-11-12'}).points[0].inflow,0);
  assert.throws(()=>dashboardCashSeries([],{from:'2025-01-01',to:'2026-11-12'}));
});

test('Dashboard fleet groups are disjoint, exclude customer cars and honor physical states and blocks',()=>{
  const vehicles=[vehicle('free'),vehicle('rented','Alquilado'),vehicle('shop','En taller'),
    vehicle('unknown','Por confirmar'),vehicle('reserved'),vehicle('cleaning'),vehicle('loan'),
    vehicle('planned-shop'),{...vehicle('customer'),inRentalFleet:false}];
  const groups=dashboardFleet({vehicles,reservationHistory:[booking('rented'),booking('shop'),booking('reserved')]},
    [block('cleaning'),block('loan',{kind:'Préstamo',ends_at:'infinity'}),block('shop'),
      block('planned-shop',{kind:'Taller',starts_at:'2026-12-01T12:00:00Z'})],now);
  const ids=(name:string)=>groups.find(group=>group.name===name)?.vehicles.map(car=>car.id);
  assert.deepEqual(ids('Disponible'),['free','planned-shop']);assert.deepEqual(ids('Alquilado'),['rented']);
  assert.deepEqual(ids('Reservado'),['reserved']);assert.deepEqual(ids('En taller'),['shop']);
  assert.deepEqual(ids('No disponible'),['unknown','cleaning','loan']);
  assert.equal(groups.reduce((sum,group)=>sum+group.vehicles.length,0),8);
  assert.equal(new Set(groups.flatMap(group=>group.vehicles.map(car=>car.id))).size,8);
});

test('Dashboard availability honors authorized reservation commitments even without reservation-detail permission',()=>{
  const groups=dashboardFleet({vehicles:[vehicle('reserved')]},[
    block('reserved',{kind:'Reserva',starts_at:'2026-12-01T12:00:00Z',ends_at:'infinity'})],now);
  assert.equal(groups.find(group=>group.name==='Reservado')?.vehicles.length,1);
  assert.equal(currentCommitments([block('ended',{ends_at:'2026-11-12T16:00:00Z'}),
    block('inactive',{active:false}),block('future',{starts_at:'2026-12-01T12:00:00Z'}),block('current')],now).length,1);
});

test('Dashboard workshop excludes unreceived budgets, including approved budgets, and delivered jobs',()=>{
  const statuses:WorkOrder['status'][]=['Presupuesto','Diagnóstico','En proceso','Control de calidad','Entregado'];
  const orders=statuses.map((status,index):WorkOrder=>({id:String(index),vehicleId:'car',customerId:'customer',
    status,area:'Mecánica',service:'Test',technician:'',hours:0,estimate:999,paid:0,due:'2026-11-12'}));
  assert.deepEqual(activeWorkshopOrders(orders).map(order=>order.status),statuses.slice(1,4));
});

test('Dashboard receivables use positive document balances, not quotes, face values or credits',()=>{
  const document=(id:string,balance:number,days_overdue:number):Receivable=>({id,amount:999,balance,days_overdue,
    due_on:'2026-11-12',customer_id:'customer',current_customer_id:'customer',
    customer_snapshot:{id:'customer',name:'Test',email:'',phone:'',type:'Personal',document:''},
    reservation_id:null,order_id:null,description:'Test',aging_bucket:'Test'});
  const result=dashboardReceivables([document('overdue',10.1,2),document('current',0.2,0),document('paid',0,4),document('credit',-3,4)]);
  assert.equal(result.balance,10.3);assert.equal(result.overdueBalance,10.1);
  assert.equal(result.pending.length,2);assert.equal(result.overdue.length,1);
});

test('Dashboard agenda separates planned departures and actual rentals; open returns and canceled bookings are excluded',()=>{
  const result=dashboardRentals([booking('departure'),booking('return',{rentalState:'Entregado',end:'2026-11-13T18:00:00Z'}),
    booking('open',{rentalState:'Entregado',end:'infinity'}),booking('returned',{rentalState:'Devuelto'}),
    booking('canceled',{status:'Cancelada'}),booking('draft',{status:'Borrador'}),
    booking('late-return',{rentalState:'Entregado',end:'2026-11-12T15:59:59Z'}),
    booking('late-departure',{start:'2026-11-12T15:00:00Z'}),
    booking('distant',{start:'2026-12-01T12:00:00Z'})],now);
  assert.deepEqual(result.agenda.map(event=>[event.reservation.id,event.kind]),[['departure','Entrega'],['return','Devolución']]);
  assert.deepEqual(result.lateReturns.map(booking=>booking.id),['late-return']);
  assert.deepEqual(result.lateDepartures.map(booking=>booking.id),['late-departure']);
});
