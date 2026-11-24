import type {BusinessData,ReservationHistory,Vehicle,WorkOrder} from '@/types';
import type {DiaryRow} from '@/lib/supabase/diary';
import type {Commitment} from '@/lib/supabase/reservations';
import type {Receivable} from '@/lib/supabase/billing';
import {fleetStatus} from './fleet-status';

const DAY=86400000;
export type DashboardPeriod={from:string;to:string};
export type FleetGroup='Disponible'|'Alquilado'|'Reservado'|'En taller'|'No disponible';
export const fleetGroups:readonly FleetGroup[]=['Disponible','Alquilado','Reservado','En taller','No disponible'];
export const workshopStages=['Diagnóstico','En proceso','Control de calidad'] as const;
export interface CashPoint {from:string;to:string;inflow:number;outflow:number;}
export interface AgendaEvent {id:string;kind:'Entrega'|'Devolución';at:string;reservation:ReservationHistory;}

export function shiftDay(day:string,offset:number):string{
  return new Date(Date.parse(day+'T12:00:00Z')+offset*DAY).toISOString().slice(0,10);
}

export function validDashboardPeriod(period:DashboardPeriod,today:string):boolean{
  const valid=(day:string)=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&
    Number.isFinite(Date.parse(day+'T12:00:00Z'))&&shiftDay(day,0)===day;
  if(!valid(period.from)||!valid(period.to))return false;
  const days=(Date.parse(period.to)-Date.parse(period.from))/DAY;
  return days>=0&&days<366&&period.to<=today;
}

export function dashboardCashSeries(rows:DiaryRow[],period:DashboardPeriod):{
  points:CashPoint[];granularity:'Diaria'|'Semanal';income:number;outgoing:number;net:number;
}{
  const days=Math.round((Date.parse(period.to)-Date.parse(period.from))/DAY)+1;
  if(!Number.isFinite(days)||days<1||days>366)throw new Error('Invalid dashboard range');
  const step=days>62?7:1;
  const points:CashPoint[]=Array.from({length:Math.ceil(days/step)},(_,index)=>({
    from:shiftDay(period.from,index*step),to:shiftDay(period.from,Math.min(days-1,(index+1)*step-1)),
    inflow:0,outflow:0,
  }));
  // Aggregate cash events once, in cents; links and document amounts are not additional cash.
  for(const row of rows){
    if(row.date<period.from||row.date>period.to)continue;
    const index=Math.floor((Date.parse(row.date)-Date.parse(period.from))/DAY/step);
    if(!points[index])continue;
    points[index].inflow+=Math.round(Number(row.inflow)*100);
    points[index].outflow+=Math.round(Number(row.outflow)*100);
  }
  const income=points.reduce((sum,point)=>sum+point.inflow,0)/100;
  const outgoing=points.reduce((sum,point)=>sum+point.outflow,0)/100;
  return{points:points.map(point=>({...point,inflow:point.inflow/100,outflow:point.outflow/100})),
    granularity:step===1?'Diaria':'Semanal',income,outgoing,net:Math.round((income-outgoing)*100)/100};
}

export function currentCommitments(commitments:Commitment[],now:number):Commitment[]{
  return commitments.filter(block=>block.active&&Date.parse(block.starts_at)<=now&&
    (block.ends_at==='infinity'||Date.parse(block.ends_at)>now));
}

export function dashboardFleet(data:Pick<BusinessData,'vehicles'|'reservationHistory'>,
  commitments:Commitment[],now:number):{name:FleetGroup;vehicles:Vehicle[]}[]{
  const current=currentCommitments(commitments,now);
  const groups=fleetGroups.map(name=>({name,vehicles:[] as Vehicle[]}));
  for(const vehicle of data.vehicles.filter(car=>car.inRentalFleet)){
    const state=fleetStatus(vehicle,data.reservationHistory??[],now);
    const blocks=current.filter(block=>block.vehicle_id===vehicle.id&&block.kind!=='Reserva');
    const reserved=state==='Reservado'||commitments.some(block=>block.vehicle_id===vehicle.id&&
      block.active&&block.kind==='Reserva'&&(block.ends_at==='infinity'||Date.parse(block.ends_at)>now));
    // Physical rental/workshop states take precedence. Every car belongs to exactly one group.
    const name:FleetGroup=vehicle.status==='Alquilado'?'Alquilado':vehicle.status==='En taller'?'En taller':
      vehicle.status==='Por confirmar'?'No disponible':blocks.some(block=>block.kind==='Taller')?'En taller':
        blocks.length?'No disponible':reserved?'Reservado':'Disponible';
    groups.find(group=>group.name===name)!.vehicles.push(vehicle);
  }
  return groups;
}

export function activeWorkshopOrders(orders:WorkOrder[]):WorkOrder[]{
  return orders.filter(order=>order.status!=='Presupuesto'&&order.status!=='Entregado');
}

export function dashboardReceivables(documents:Receivable[]):{
  pending:Receivable[];overdue:Receivable[];balance:number;overdueBalance:number;
}{
  const pending=documents.filter(document=>Number(document.balance)>0);
  const overdue=pending.filter(document=>Number(document.days_overdue)>0);
  const sum=(values:Receivable[])=>values.reduce((total,document)=>total+Math.round(Number(document.balance)*100),0)/100;
  return{pending,overdue,balance:sum(pending),overdueBalance:sum(overdue)};
}

export function dashboardRentals(history:ReservationHistory[],now:number):{
  agenda:AgendaEvent[];lateReturns:ReservationHistory[];lateDepartures:ReservationHistory[];
}{
  const confirmed=history.filter(booking=>booking.status==='Confirmada');
  const horizon=now+7*DAY;
  const agenda:AgendaEvent[]=[];
  for(const reservation of confirmed){
    const kind=reservation.rentalState==='Preparado'?'Entrega':
      reservation.rentalState==='Entregado'?'Devolución':undefined;
    if(!kind)continue;
    const at=kind==='Entrega'?reservation.start:reservation.end;
    const time=Date.parse(at);
    if(time>=now&&time<=horizon)agenda.push({id:kind+reservation.id,kind,at,reservation});
  }
  return{agenda:agenda.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id)),
    lateReturns:confirmed.filter(booking=>booking.rentalState==='Entregado'&&Date.parse(booking.end)<now),
    lateDepartures:confirmed.filter(booking=>booking.rentalState==='Preparado'&&Date.parse(booking.start)<now)};
}
