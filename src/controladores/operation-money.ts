import type {CaseFile} from '../lib/supabase/cases';

export function operationMoney(file:CaseFile,orderId?:string){
  const quote=(file.quotes??[]).filter(q=>!orderId||q.order_id===orderId).sort((a,b)=>
    (!orderId?(b.created_at??'').localeCompare(a.created_at??''):0)||b.revision-a.revision)[0];
  const costs=(file.costs??[]).reduce((sum,c)=>sum+Number(c.amount),0);
  const cashOut=(file.expenses??[]).reduce((sum,e)=>sum+Number(e.scope_amount??e.amount),0);
  const charged=(file.documents??[]).reduce((sum,d)=>sum+Number(d.scope_amount),0);
  const balance=(file.documents??[]).reduce((sum,d)=>sum+Number(d.scope_balance),0);
  const paid=(file.applications??[]).reduce((sum,a)=>sum+(a.kind==='Aplicacion'?1:-1)*Number(a.scope_amount),0);
  const quoted=quote?Number(quote.snapshot.total):null;
  const activeId=file.orders?.find(o=>!orderId||o.id===orderId)?.active_estimate_id;
  const approved=(file.quotes??[]).find(q=>q.id===activeId&&q.status==='Aprobado')??(quote?.status==='Aprobado'?quote:undefined);
  const unbilled=approved&&(!!orderId||(file.orders?.length??0)<=1)?Math.max(0,Math.round((Number(approved.snapshot.total)-charged)*100)/100):0;
  const state=balance>0?'Pendiente':unbilled>0?'Por emitir':charged>0?'Sin saldo':quote?.status==='Borrador'?'Por aprobar':quote?.status==='Rechazado'?'Rechazado':'Sin cargo';
  const collectionState=balance>0?(paid>0?'Pago parcial':'Por cobrar'):state;
  const delivered=!!orderId&&file.orders?.find(o=>o.id===orderId)?.status==='Entregado';
  const pendingCosts=(file.costs??[]).filter(c=>c.disposition==='Pendiente').length;
  const advances=(file.advances??[]).reduce((sum,p)=>sum+Number(p.available_amount),0);
  return{quote,quoted,costs,cashOut,charged,balance,paid,unbilled,state,collectionState,
    deliveredWithBalance:delivered&&balance>0,pendingCosts,advances};
}
