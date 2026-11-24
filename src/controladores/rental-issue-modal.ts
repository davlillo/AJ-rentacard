// Pure helpers for the "Emitir importe a cobrar" modal.
//
// The modal shows the facts the system already knows (customer, vehicle, agreed period, days,
// agreed total and what is still pending) and asks the operator only for what needs a decision.
// Nothing here invents an amount: every figure comes from the canonical accounts of the rental,
// and the amount that is prefilled is the agreed amount that is still pending to be issued.

import {money} from '@/controladores/finanzas';

export const rentalIssueTitle='Emitir importe a cobrar';
export const rentalIssueConsequence='Registra el documento de cobro de este período. No recibe dinero ni cancela la deuda pendiente.';
export const rentalIssueDatesDisclosure='Modificar las fechas del período';
export const rentalIssueReasonHint='Explique el acuerdo del período, por ejemplo: se emite el total acordado de los días del período.';
export const rentalIssueEmptyPeriod='Este alquiler no tiene una fecha final acordada. Use la extensión del alquiler para acordar la fecha de devolución.';

// A document of an inspection extra is not the rental period: it is a receivable of its own and it
// must never shrink the amount the operator still has to issue for the period.
export const rentalExtraSourcePrefix='rental-extra:';
export interface RentalPeriodDocument {id:string;scope_amount:number;source_key?:string|null;}
export const isRentalExtraDocument=(document:{source_key?:string|null}|null|undefined)=>
  String(document?.source_key??'').startsWith(rentalExtraSourcePrefix);
// The charge of the period alone: the documents of an inspection extra are excluded.
export function rentalPeriodCharge(documents:RentalPeriodDocument[]):number{
  return (documents??[]).filter(document=>!isRentalExtraDocument(document))
    .reduce((sum,document)=>sum+Number(document.scope_amount||0),0);
}
// The documents of an inspection extra, by id: what the payments of the period must not include.
export function rentalExtraDocumentIds(documents:{id:string;source_key?:string|null}[]):string[]{
  return (documents??[]).filter(document=>isRentalExtraDocument(document)).map(document=>document.id);
}

export interface RentalIssuePeriod{startsOn:string;endsOn:string;contractualStart:string;contractualEnd:string;days:number|null;}
export interface RentalIssueFacts{
  customer:string;vehicle:string;period:RentalIssuePeriod;
  agreedTotal:number|null;pending:number;pendingToEmit:number;dailyRate:number|null;
}
export interface RentalIssuePrefill{startsOn:string;endsOn:string;amount:string;date:string;dueOn:string;}
export interface RentalIssueAttempt{body:string;key:string;}

// The agreed dates of the rental, in the local calendar of the business.
export const rentalLocalDate=(value:string)=>{const date=new Date(value);
  return Number.isFinite(date.getTime())?date.toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'}):'';};
export const rentalAddDays=(value:string,days:number)=>{if(!value)return '';
  const date=new Date(`${value}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);};
// Inclusive days of a period: both ends belong to the period.
export const rentalIssueDays=(startsOn:string,endsOn:string)=>{if(!startsOn||!endsOn||startsOn>endsOn)return null;
  const start=Date.parse(`${startsOn}T00:00:00Z`),end=Date.parse(`${endsOn}T00:00:00Z`);
  if(!Number.isFinite(start)||!Number.isFinite(end))return null;
  return Math.round((end-start)/86400000)+1;};

// The period to document: it starts on the agreed delivery day (or the day after the last
// documented period) and reaches the agreed return day. The return day is used as it is, because a
// rental delivered and returned on the same day occupies exactly one day and subtracting one would
// put the end before the start.
export function rentalIssuePeriod(booking:{starts_at:string;ends_at:string;open_ended?:boolean},
  documented:{starts_on:string;ends_on:string}[]):RentalIssuePeriod{
  const contractualStart=rentalLocalDate(booking.starts_at);
  const contractualEnd=booking.open_ended?'':rentalIssueEnd(rentalLocalDate(booking.starts_at),
    rentalLocalDate(booking.ends_at));
  const documentedEnd=documented.reduce((latest,period)=>period.ends_on>latest?period.ends_on:latest,'');
  const startsOn=documentedEnd?rentalAddDays(documentedEnd,1):contractualStart;
  const endsOn=contractualEnd;
  return{startsOn,endsOn,contractualStart,contractualEnd,days:rentalIssueDays(startsOn,endsOn)};
}

export const rentalIssueCustomerName=(booking:{customer_snapshot?:{name?:string}|null}|null|undefined)=>
  booking?.customer_snapshot?.name?.trim()??'';
export const rentalIssueVehicleLabel=(vehicle:{plate?:string;brand?:string;model?:string}|null|undefined)=>{
  const plate=vehicle?.plate?.trim()??'';
  const name=[vehicle?.brand?.trim(),vehicle?.model?.trim()].filter(Boolean).join(' ');
  return[plate,name].filter(Boolean).join(' · ');};

// What the operator sees before typing anything.
export function rentalIssueFacts(booking:{customer_snapshot?:{name?:string}|null},
  vehicle:{plate?:string;brand?:string;model?:string}|null|undefined,
  period:RentalIssuePeriod,accounts:{agreed:number|null;pending:number;pendingToEmit:number},
  dailyRate:number|null):RentalIssueFacts{
  return{customer:rentalIssueCustomerName(booking),vehicle:rentalIssueVehicleLabel(vehicle),period,
    agreedTotal:accounts.agreed,pending:accounts.pending,pendingToEmit:accounts.pendingToEmit,dailyRate};
}

// The values the modal starts with: the agreed period, the amount that is pending to be issued,
// the emission date of today and a due date that never falls behind the emission.
// The documents of the folio are optional: when they are known, the amount of the period ignores
// the documents of an inspection extra, so issuing an extra never shrinks what is left to issue.
export function rentalIssuePrefill(period:RentalIssuePeriod,today:string,
  agreed:number|null,pendingToEmit:number,documents?:RentalPeriodDocument[]):RentalIssuePrefill{
  const periodCharge=documents?rentalPeriodCharge(documents):0;
  const amount=pendingToEmit>0?pendingToEmit:
    Math.max(0,Math.round(((agreed??0)-periodCharge)*100)/100);
  const dueOn=period.endsOn&&period.endsOn>today?period.endsOn:rentalAddDays(today,15);
  return{startsOn:period.startsOn,endsOn:period.endsOn,amount:amount>0?amount.toFixed(2):'',
    date:today,dueOn:dueOn>today?dueOn:today};
}

// The canonical command body. The same body always travels with the same idempotency key, so a
// retry after a failed or unknown outcome never documents the period twice.
export const rentalIssueBody=(command:string,payload:Record<string,unknown>)=>JSON.stringify({command,payload});
export function rentalIssueAttempt(previous:RentalIssueAttempt|null,body:string,
  makeKey:()=>string):RentalIssueAttempt{
  if(previous&&previous.body===body)return previous;
  return{body,key:makeKey()};
}

// The final action names the amount it is about to issue.
export const rentalIssueSubmitLabel=(amount:string)=>{
  const value=Number(amount);
  const shown=Number.isFinite(value)&&value>0?money(value):amount.trim();
  return shown?`${rentalIssueTitle} de ${shown}`:rentalIssueTitle;
};

// The period bills the NIGHTS: it reaches the day before the return. When the return happens on the
// delivery day itself there is no night to subtract, so the end is clamped to the start day instead
// of landing before it (which the range validation would reject).
export const rentalIssueEnd=(startsOn:string,endsOn:string)=>{
  if(!startsOn||!endsOn)return '';
  const previous=rentalAddDays(endsOn,-1);
  return previous<startsOn?startsOn:previous;
};
