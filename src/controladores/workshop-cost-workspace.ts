import type {WorkshopCost,DirectPurchasePayment} from '../lib/supabase/workshop';
import {cents,splitRemainder} from './linked-money';

export const costDispositions=['Incluido','Adicional autorizado','Interno','Absorbido'] as const;
export function classificationChoice(disposition:string):string{
  return costDispositions.some(value=>value===disposition)?disposition:'';
}
export function costFinancialAccess(financialAccess:boolean|undefined,canRead:boolean):boolean{
  return financialAccess===true&&canRead;
}
export function reconcileCosts(loaded:WorkshopCost[],current:WorkshopCost[]|undefined,orderId:string):WorkshopCost[]{
  const rows=new Map(loaded.filter(cost=>cost.order_id===orderId).map(cost=>[cost.id,cost]));
  for(const cost of current??[]){
    if(cost.order_id===orderId&&(!rows.has(cost.id)||cost.version>rows.get(cost.id)!.version))rows.set(cost.id,cost);
  }
  return [...rows.values()];
}
export function allocationSummary(amount:number|string,lines:{amount:string}[]){
  const total=cents(String(amount));const remainder=splitRemainder(String(amount),lines.map(line=>line.amount));
  return {total,allocated:total===null||remainder===null?null:total-remainder,remainder,
    valid:lines.length===0||remainder===0};
}
export function supplierSummary(cost:WorkshopCost,payments:DirectPurchasePayment[]){
  const total=cents(String(cost.amount));
  const paid=payments.filter(payment=>payment.direct_purchase_cost_id===cost.id)
    .reduce((sum,payment)=>sum+(cents(String(payment.amount))??0),0);
  return {total,paid,pending:total===null?null:total-paid};
}
export function classificationError(disposition:string,estimateId:string,approvedIds:string[],reason:string,internal:boolean){
  if(!costDispositions.some(value=>value===disposition))return 'Seleccione una relación con el presupuesto.';
  if(internal&&['Incluido','Adicional autorizado'].includes(disposition))return 'El mantenimiento interno no es una venta al cliente.';
  if(['Incluido','Adicional autorizado'].includes(disposition)&&!approvedIds.includes(estimateId))return 'Seleccione un presupuesto aprobado de este trabajo.';
  return reason.trim()?'':'Indique el motivo de la decisión.';
}
