import type {BusinessData} from '../types';
import type {CustomerPayment,PaymentApplication,PaymentRefund} from '../lib/supabase/billing';
import {folio} from './folios';
import {calendarDate} from './month-calendar';

export function cents(value:string):number|null{
  if(!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))return null;
  const amount=Math.round(Number(value)*100);return Number.isSafeInteger(amount)?amount:null;
}
export function splitRemainder(total:string,amounts:string[]):number|null{
  const original=cents(total);const parts=amounts.map(cents);
  return original===null||parts.some(value=>value===null)?null:original-parts.reduce<number>((sum,value)=>sum+(value??0),0);
}
export function paymentAvailable(payment:CustomerPayment,applications:PaymentApplication[],refunds:PaymentRefund[]):number{
  return Math.round((Number(payment.amount)-applications.filter(a=>a.payment_id===payment.id)
    .reduce((sum,a)=>sum+(a.kind==='Aplicacion'?1:-1)*Number(a.amount),0)
    -refunds.filter(r=>r.payment_id===payment.id).reduce((sum,r)=>sum+Number(r.amount),0))*100)/100;
}
export function workLabel(data:BusinessData,id:string):string{
  const job=data.orders.find(o=>o.id===id);if(!job)return id;
  const car=data.vehicles.find(v=>v.id===job.vehicleId);const customer=data.customers.find(c=>c.id===job.customerId);
  return [id,car?.plate||`${car?.brand??''} ${car?.model??''}`.trim(),job.internalJob?'Mantenimiento interno':customer?.name,job.service].filter(Boolean).join(' · ');
}
export function rentalLabel(data:BusinessData,id:string):string{
  const rental=data.reservationHistory?.find(r=>r.id===id);if(!rental)return 'Alquiler no disponible';
  const car=data.vehicles.find(v=>v.id===rental.vehicleId);const customer=data.customers.find(c=>c.id===rental.customerId);
  return [rental.status==='Borrador'?'Reserva':'Alquiler',rental.folioNumber?folio('ALQ',rental.folioNumber):'',
    car?.plate||`${car?.brand??''} ${car?.model??''}`.trim(),customer?.name,calendarDate(rental.start)].filter(Boolean).join(' · ');
}
export function diaryHref(operationId?:string,movementId?:string,date?:string):string{
  const params=new URLSearchParams();
  if(operationId)params.set('operacion',operationId);if(movementId)params.set('movimiento',movementId);
  if(date){params.set('desde',date);params.set('hasta',date);}
  return '/libro-diario/'+(params.size?'?'+params.toString():'');
}
