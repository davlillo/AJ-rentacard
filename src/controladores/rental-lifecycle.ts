import type {Reservation} from '../lib/supabase/reservations';
import type {CaseFile} from '../lib/supabase/cases';
import type {RentalWorkflow} from './rental-workflow';
import {rentalStages} from './rental-workflow';
import {money} from './finanzas';
import {operationMoney} from './operation-money';
import {rentalExtraDocumentIds,rentalPeriodCharge,type RentalPeriodDocument} from './rental-issue-modal';

const dayMs=86400000;
export {rentalStages};

// Money evidence read from the persisted reservation scope. A forecast is never a receivable.
export interface RentalMoneyEvidence {
  charged:number;balance:number;paid:number;advances:number;agreed:number|null;estimate:number|null;
  // The charge of the period alone. The documents of an inspection extra are a receivable of their
  // own: they never shrink what the operator still has to issue for the period of the rental.
  periodCharged?:number;periodPaid?:number;
}
export interface RentalAccounts {
  agreed:number|null;estimate:number|null;charged:number;paid:number;balance:number;advances:number;
  unissued:number;issued:boolean;settled:boolean;
  // What the customer still owes, split by origin: the server balance of the documents already
  // issued and the agreed amount that still has to be issued as a collection document.
  pending:number;pendingIssued:number;pendingToEmit:number;
  // The part of the agreed amount that the folio already carries: the documents of the period of
  // the rental, or the money already received when no document of the period exists yet.
  covered:number;
}

// Without the current financial access there is no money evidence at all.
export function rentalMoneyEvidence(file:CaseFile,booking:Reservation,estimate:number|null):RentalMoneyEvidence|null{
  if(!file.financialAccess)return null;
  const totals=operationMoney(file);
  // The documents of an inspection extra are excluded from the charge and from the payments of the
  // period: an extra that was issued is money owed, never a day of the rental already charged.
  const documents=(file.documents??[]) as RentalPeriodDocument[];
  const extraDocuments=new Set(rentalExtraDocumentIds(documents));
  const periodCharged=rentalPeriodCharge(documents);
  const periodPaid=(file.applications??[]).filter(application=>!extraDocuments.has(application.document_id))
    .reduce((sum,application)=>sum+(application.kind==='Aplicacion'?1:-1)*Number(application.scope_amount),0);
  return{charged:totals.charged,balance:totals.balance,paid:totals.paid,advances:totals.advances,
    agreed:booking.open_ended?null:Number(booking.total)||0,estimate,periodCharged,periodPaid};
}

export function rentalAccounts(evidence:RentalMoneyEvidence|null):RentalAccounts|null{
  if(!evidence)return null;
  const charged=evidence.charged;
  const balance=evidence.balance;
  const agreed=evidence.agreed;
  const paid=evidence.paid;
  // The pending amount comes only from the canonical facts: the server balance of the documents
  // already issued plus the agreed amount that was not issued yet. An unapplied advance never
  // reduces it; money already applied does, through the balance of the document it paid.
  const pendingIssued=Math.max(0,Math.round(balance*100)/100);
  // Only the documents of the period reduce what is left to issue: a document of an inspection
  // extra is charged money of its own and must never under-bill the period of the rental.
  const periodCharged=evidence.periodCharged??charged;
  const periodPaid=evidence.periodPaid??paid;
  // What the agreement already carries: the documents of the period, or the money already
  // received when no document of the period exists yet. The difference with the agreed amount is
  // exactly what is left to issue, so both numbers always tell the same story.
  const covered=periodCharged>0?periodCharged:periodPaid;
  const pendingToEmit=agreed===null?0:
    Math.max(0,Math.round((agreed-covered)*100)/100);
  const pending=Math.round((pendingIssued+pendingToEmit)*100)/100;
  const unissued=pendingToEmit;
  // A receivable exists only when a document was issued and it still carries a balance.
  return{agreed,estimate:evidence.estimate,charged,paid,balance,advances:evidence.advances,
    unissued,issued:charged>0,settled:charged>0&&balance<=0,pending,pendingIssued,pendingToEmit,covered};
}

// The next step is described with the exact meaning of each amount.
export function rentalAccountsAdvice(accounts:RentalAccounts|null):string{
  if(!accounts)return 'Información financiera restringida: no hay importes que mostrar.';
  const agreement=rentalAgreementSentence(accounts);
  if(accounts.pending>0)return `Pendiente por cobrar: ${money(accounts.pending)}. ${rentalPendingSentence(accounts)} ${agreement}`;
  return `${rentalPendingSentence(accounts)} ${agreement}`;
}
// The pending that belongs to a document that was already issued to the customer. The agreed
// amount that is still to be issued is stated by the reconciliation alarm, never twice.
export function rentalIssuedPendingSentence(accounts:RentalAccounts):string{
  if(accounts.pendingIssued<=0)return '';
  return `Pendiente del documento emitido: ${money(accounts.pendingIssued)}. `+
    'Es el saldo del documento de cobro ya emitido al cliente que todavía no se ha cobrado.';
}
// Plain words for the operator: what the customer still owes and whether it is already on a
// document or still has to be issued. It never adds an amount and never mixes kinds of money.
export function rentalPendingSentence(accounts:RentalAccounts):string{
  if(accounts.pendingIssued>0&&accounts.pendingToEmit>0)
    return `${rentalIssuedPendingSentence(accounts)} `+
      `Pendiente de emitir el documento de cobro: ${money(accounts.pendingToEmit)}.`;
  if(accounts.pendingIssued>0)return rentalIssuedPendingSentence(accounts);
  if(accounts.pendingToEmit>0)
    return `Pendiente de emitir el documento de cobro: ${money(accounts.pendingToEmit)}. `+
      'El importe está acordado con el cliente, pero el documento de cobro todavía no se le emitió.';
  if(accounts.agreed===null)
    return 'Este alquiler no tiene un total acordado: el pendiente viene solo de los documentos de cobro emitidos.';
  return 'No hay importe pendiente: lo acordado ya fue emitido y cobrado.';
}
// Plain words for the operator: what was agreed, what was already issued and what is still to be
// issued. It never adds an amount and never mixes a receivable with an agreed forecast.
export function rentalAgreementSentence(accounts:RentalAccounts):string{
  const agreed=accounts.agreed===null?'Este alquiler no tiene un total acordado':`Lo acordado son ${money(accounts.agreed)}`;
  const pending=accounts.unissued>0?`todavía falta emitir ${money(accounts.unissued)}`:'no queda nada por emitir';
  return `${agreed}; ya se emitieron ${money(accounts.charged)} y ${pending}.`;
}

// The reconciliation alarm: one plain sentence that compares what was agreed with what was
// already issued. It informs the operator, it never blocks an emission, an approval, a delivery
// or a collection, and it never invents an amount: it only names the difference between two
// canonical facts.
export interface ReconciliationAlarm{agreed:number;issued:number;difference:number;text:string;}
export function reconciliationAlarm(agreed:number|null|undefined,issued:number|null|undefined):ReconciliationAlarm|null{
  if(agreed===null||agreed===undefined||issued===null||issued===undefined)return null;
  const agreedAmount=Math.round(Number(agreed)*100)/100;
  const issuedAmount=Math.round(Number(issued)*100)/100;
  if(!Number.isFinite(agreedAmount)||!Number.isFinite(issuedAmount))return null;
  const difference=Math.round((agreedAmount-issuedAmount)*100)/100;
  // Nothing agreed, or nothing left to compare: there is no alarm to show.
  if(difference===0)return null;
  const text=difference>0
    ?(issuedAmount>0
      ?`Facturado ${money(issuedAmount)} de ${money(agreedAmount)} acordados · faltan ${money(difference)} por emitir.`
      :`Todavía no se emitió ningún importe: de ${money(agreedAmount)} acordados · faltan ${money(difference)} por emitir.`)
    :`Facturado ${money(issuedAmount)} de ${money(agreedAmount)} acordados · hay ${money(-difference)} de diferencia por revisar.`;
  return{agreed:agreedAmount,issued:issuedAmount,difference,text};
}
// The alarm of a rental: the agreed total of the contract against what the period already
// carries. The documents of an inspection extra are a receivable of their own, so they never
// change this comparison, exactly like they never change what is left to issue.
export function rentalReconciliationAlarm(accounts:RentalAccounts|null):ReconciliationAlarm|null{
  if(!accounts||accounts.agreed===null)return null;
  return reconciliationAlarm(accounts.agreed,accounts.covered);
}

// Consume the existing workflow result; selecting a view cannot create evidence.
export function rentalLifecycle(booking:Reservation,_workflow:RentalWorkflow,evidence?:RentalMoneyEvidence|null){
  const accounts=rentalAccounts(evidence??null);
  const returned=booking.status==='Confirmada'&&['Devuelto','Cerrado'].includes(booking.rental_state);
  // The displayed stage is derived, never persisted: the vehicle state gives the first steps and
  // the money gives the last ones. A rental that still owes money never reads as finished, and
  // without money evidence the settlement cannot be asserted either.
  const current=booking.status==='Cancelada'?null:booking.status==='Borrador'?0:
    booking.rental_state==='Preparado'?0:returned?(accounts&&accounts.pending<=0?4:3):2;
  const stages=rentalStages.map((label,index)=>({label,
    complete:current!==null&&index<current,current:current!==null&&index===current}));
  return{current,currentIndex:current,accounts,stages};
}

function timestamp(value:string|undefined|null):number{
  if(!value)return NaN;
  const date=value.slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return NaN;
  const calendar=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(calendar)||new Date(calendar).toISOString().slice(0,10)!==date)return NaN;
  // Legacy offset-less timestamps represent Salvador time, not the browser zone.
  return Date.parse(/T/.test(value)&&!/(Z|[+-]\d{2}:\d{2})$/i.test(value)?value+'-06:00':value);
}

export function rentalElapsed(booking:Reservation,now:number){
  const returned=['Devuelto','Cerrado'].includes(booking.rental_state);
  const enabled=booking.status==='Confirmada'&&['Entregado','Devuelto','Cerrado'].includes(booking.rental_state);
  const plannedStart=timestamp(booking.starts_at);const plannedEnd=timestamp(booking.ends_at);
  const plannedDays=!booking.open_ended&&Number.isFinite(plannedStart)&&plannedEnd>plannedStart?
    Math.ceil((plannedEnd-plannedStart)/dayMs):null;
  const basis=booking.actual_departure_at===null||booking.actual_departure_at===undefined?'scheduled':'actual';
  const start=timestamp(basis==='actual'?booking.actual_departure_at:booking.starts_at);
  const end=returned?timestamp(booking.actual_return_at):now;
  const known=enabled&&Number.isFinite(start)&&Number.isFinite(end)&&end>=start;
  const elapsed=known?end-start:null;
  const day=elapsed===null?null:Math.floor(elapsed/dayMs)+1;
  const periods=elapsed===null?null:Math.max(1,Math.ceil(elapsed/dayMs));
  const rate=Number(booking.daily_rate);
  return{day,plannedDays,basis,frozen:returned,estimate:periods!==null&&Number.isFinite(rate)&&rate>=0?
    Math.round(periods*rate*100)/100:null,
    overdue:known&&!booking.open_ended&&Number.isFinite(plannedEnd)&&end>plannedEnd};
}

// The agreed total of a rental is the rate times the rounded up days of 24 hours, exactly like the
// server computes it. The wizard uses it to show the agreement before the reservation is confirmed.
export function rentalAgreementTotals(startsAt:string,endsAt:string|null,rate:number):{days:number|null;total:number|null}{
  if(!startsAt||!endsAt)return{days:null,total:null};
  const start=Date.parse(startsAt),end=Date.parse(endsAt);
  if(!Number.isFinite(start)||!Number.isFinite(end))return{days:null,total:null};
  const days=Math.max(1,Math.ceil((end-start)/dayMs));
  const total=Number.isFinite(rate)&&rate>=0?Math.round(days*rate*100)/100:null;
  return{days,total};
}

export interface PeriodInput {startsOn:string;endsOn:string;date:string;dueOn:string;amount:string;reason:string;}
export function reviewRentalPeriod(booking:Reservation,input:PeriodInput,periods:{starts_on:string;ends_on:string}[]){
  if([input.startsOn,input.endsOn,input.date,input.dueOn].some(value=>
    !/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(timestamp(value)))||
    input.startsOn>input.endsOn||input.dueOn<input.date)throw new Error('Revise las fechas del período y del importe a cobrar.');
  if(!/^\d+(\.\d{1,2})?$/.test(input.amount)||!Number.isFinite(Number(input.amount))||Number(input.amount)<=0)
    throw new Error('Revise el importe positivo con hasta dos decimales.');
  if(!input.reason.trim())throw new Error('Indique el acuerdo del período.');
  if(periods.some(period=>input.startsOn<=period.ends_on&&input.endsOn>=period.starts_on))
    throw new Error('El período se superpone con días ya documentados. Revise los importes ya documentados.');
  return Object.freeze({payload:Object.freeze({reservationId:booking.id,expectedVersion:booking.version,
    startsOn:input.startsOn,endsOn:input.endsOn,date:input.date,dueOn:input.dueOn,amount:input.amount,reason:input.reason.trim()})});
}
