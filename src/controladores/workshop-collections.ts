import type {CaseFile} from '../lib/supabase/cases';
import {operationMoney} from './operation-money';
// The reconciliation alarm has one wording for every surface: it lives with the money semantics
// of the rental so the workshop and the rental never say the same thing in two different ways.
import {reconciliationAlarm,type ReconciliationAlarm} from './rental-lifecycle';

export function workshopCollections(file:CaseFile,orderId?:string){
  const summary=operationMoney(file,orderId);
  const activeId=file.orders?.find(order=>order.id===orderId)?.active_estimate_id;
  const approved=(file.quotes??[]).find(quote=>quote.id===activeId&&quote.status==='Aprobado')
    ??(summary.quote?.status==='Aprobado'?summary.quote:undefined);
  const validAmount=(value:unknown)=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
  const known=file.financialAccess&&[file.documents,file.applications,file.advances].every(Array.isArray)&&
    (file.documents??[]).every(document=>validAmount(document.scope_amount)&&validAmount(document.scope_balance))&&
    (file.applications??[]).every(application=>validAmount(application.scope_amount))&&
    (file.advances??[]).every(payment=>validAmount(payment.available_amount));
  const revision=JSON.stringify({
    orderId,approved:approved?.id,total:approved?.snapshot.total,
    documents:file.documents?.map(document=>[document.id,document.scope_amount,document.scope_balance,document.grouped]),
    applications:file.applications?.map(application=>[application.id,application.kind,application.scope_amount]),
    advances:file.advances?.map(payment=>[payment.id,payment.available_amount]),
  });
  return {...summary,known,agreed:approved?Number(approved.snapshot.total):null,revision};
}

// The alarm of a workshop job: the approved scope against the amounts already issued to the
// customer. Without an approved quote there is no agreed amount and therefore no alarm.
export function workshopReconciliationAlarm(summary:{agreed:number|null;charged:number}):ReconciliationAlarm|null{
  return reconciliationAlarm(summary.agreed,summary.charged);
}
