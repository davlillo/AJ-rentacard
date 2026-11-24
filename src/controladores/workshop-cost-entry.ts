import type {CaseExpense} from '../lib/supabase/cases';
import type {WorkshopCost} from '../lib/supabase/workshop';

// One obvious workshop cost entry: the operator answers how much was paid and
// the entry composes the canonical commands only (linked expense, direct
// purchase and supplier payment). No new money semantics are introduced here.

export type CostEntryAnswer='full'|'part'|'none';

export const costEntryQuestion='¿Cuánto pagaste?';

export const costEntryLabels:Record<CostEntryAnswer,string>={
  full:'Todo',
  part:'Una parte',
  none:'Nada todavía (queda pendiente con el proveedor)',
};

export const costEntryHints:Record<CostEntryAnswer,string>={
  full:'Se registró el costo completo: una sola salida de dinero y el costo ligado a este trabajo.',
  part:'Se registra lo adquirido y el primer pago al proveedor. Lo que no se pague queda pendiente con el proveedor.',
  none:'Se registra lo adquirido sin salida de dinero. El pago al proveedor se registra después.',
};

export interface CostEntryCostInput{
  orderId:string;description:string;quantity:string;unitCost:string;
  supplier:string;sourceReference:string;date:string;reason?:string;
}
export interface CostEntryPaymentInput{amount:string;date:string;method:string;account:string}

export type CostEntryStep=
  |{kind:'linked-expense';payload:{orderId:string}}
  |{kind:'purchase';payload:Record<string,unknown>}
  |{kind:'pay';payload:Record<string,unknown>};

export interface CostEntryDeps{
  // Stable idempotency identity per canonical request body.
  keyFor:(body:string)=>string;
  purchase:(payload:Record<string,unknown>,key:string)=>Promise<{id:string;amount:number}>;
  pay:(costId:string,payload:Record<string,unknown>,key:string)=>Promise<void>;
  linkedExpense:(orderId:string)=>void|Promise<void>;
}

export type CostEntryOutcome=
  |{state:'linked-expense';orderId:string}
  |{state:'failed';error:string}
  |{state:'saved';costId:string;amount:number;pending:number;notice:'credit'|'partial'}
  |{state:'payment-pending';costId:string;amount:number;pending:number;error:string};

// Exact cents for any amount coming from a form, a payload or the database.
export function amountCents(value:number|string):number|null{
  if(typeof value==='number'){
    if(!Number.isFinite(value))return null;
    const total=Math.round(value*100);return Number.isSafeInteger(total)?total:null;
  }
  const raw=value.trim();
  if(!/^\d+(?:\.\d{1,2})?$/.test(raw))return null;
  const total=Math.round(Number(raw)*100);return Number.isSafeInteger(total)?total:null;
}

// The acquired amount is quantity * unit cost rounded to two decimals, the
// same rule the database applies when the purchase is stored.
export function costEntryTotalCents(quantity:string,unitCost:string):number|null{
  const amount=Number(quantity);const unit=Number(unitCost);
  if(!Number.isFinite(amount)||!Number.isFinite(unit)||amount<=0||unit<=0)return null;
  const total=Math.round(amount*unit*100);return Number.isSafeInteger(total)?total:null;
}

export function costEntryPurchasePayload(cost:CostEntryCostInput):Record<string,unknown>{
  const payload:Record<string,unknown>={
    orderId:cost.orderId,description:cost.description.trim(),quantity:cost.quantity.trim(),
    unitCost:cost.unitCost.trim(),supplier:cost.supplier.trim(),
    sourceReference:cost.sourceReference.trim(),date:cost.date.trim()};
  const reason=cost.reason?.trim();
  if(reason)payload.reason=reason;
  return payload;
}

export function costEntryPaymentPayload(payment:CostEntryPaymentInput):Record<string,unknown>{
  return {amount:payment.amount.trim(),date:payment.date.trim(),method:payment.method.trim(),account:payment.account.trim()};
}

export function costEntryPurchaseBody(payload:Record<string,unknown>):string{
  return JSON.stringify({command:'purchase',payload});
}
export function costEntryPayBody(costId:string,payload:Record<string,unknown>):string{
  return JSON.stringify({command:'pay',costId,payload});
}

// The canonical sequence for each answer. Paid in full never buys and never
// pays here: the shared expense dialog records one cash outflow plus the cost
// share. Nothing here charges the customer or prices anything.
export function costEntryPlan(answer:CostEntryAnswer,cost:CostEntryCostInput,payment?:CostEntryPaymentInput):CostEntryStep[]{
  if(answer==='full')return [{kind:'linked-expense',payload:{orderId:cost.orderId}}];
  const steps:CostEntryStep[]=[{kind:'purchase',payload:costEntryPurchasePayload(cost)}];
  if(answer==='part'&&payment)steps.push({kind:'pay',payload:costEntryPaymentPayload(payment)});
  return steps;
}

export function costEntryError(answer:CostEntryAnswer,cost:CostEntryCostInput,payment?:CostEntryPaymentInput):string{
  if(answer==='full')return '';
  if(!cost.description.trim())return 'Describa el repuesto o servicio adquirido.';
  if(costEntryTotalCents(cost.quantity,cost.unitCost)===null)return 'Indique la cantidad y el costo unitario del pago.';
  if(!cost.supplier.trim())return 'Indique el proveedor de la compra.';
  if(!cost.sourceReference.trim())return 'Indique la referencia de factura y línea.';
  if(!cost.date.trim())return 'Indique la fecha de compra.';
  if(answer==='part'){
    const paid=amountCents(payment?.amount??'');
    if(paid===null||paid<=0)return 'Indique el importe del pago parcial al proveedor.';
    const total=costEntryTotalCents(cost.quantity,cost.unitCost)!;
    if(paid>=total)return 'El pago parcial debe ser menor que el costo total.';
    if(!payment?.date.trim())return 'Indique la fecha del pago al proveedor.';
    if(!payment?.account.trim())return 'Indique la cuenta o caja del pago al proveedor.';
  }
  return '';
}

// Exact pending supplier amount in cents. The cost amount always comes from
// the saved cost, never from an estimate of the form.
export function costEntryPendingCents(amount:number|string,paid:number|string):number|null{
  const total=amountCents(amount);if(total===null)return null;
  return total-(amountCents(paid)??0);
}

function failure(error:unknown):string{
  return error instanceof Error&&error.message?error.message:'No se pudo guardar. Revise los datos e intente de nuevo.';
}

// Runs the answer end to end. A failed purchase never attempts a payment. A
// failed payment keeps the cost and reports the exact pending amount so only
// the payment can be retried.
export async function runCostEntry(answer:CostEntryAnswer,cost:CostEntryCostInput,
  payment:CostEntryPaymentInput|undefined,deps:CostEntryDeps):Promise<CostEntryOutcome>{
  if(answer==='full'){
    await deps.linkedExpense(cost.orderId);
    return {state:'linked-expense',orderId:cost.orderId};
  }
  const problem=costEntryError(answer,cost,payment);
  if(problem)return {state:'failed',error:problem};
  const purchase=costEntryPlan(answer,cost,payment)[0];
  let saved:{id:string;amount:number};
  try{saved=await deps.purchase(purchase.payload,deps.keyFor(costEntryPurchaseBody(purchase.payload)));}
  catch(error){return {state:'failed',error:failure(error)};}
  const amount=amountCents(saved.amount)??0;
  if(answer==='none')return {state:'saved',costId:saved.id,amount,pending:amount,notice:'credit'};
  const step=costEntryPlan(answer,cost,payment)[1];
  const payload=step.payload;
  const pending=costEntryPendingCents(saved.amount,payment?.amount??'')??amount;
  try{await deps.pay(saved.id,payload,deps.keyFor(costEntryPayBody(saved.id,payload)));}
  catch(error){return {state:'payment-pending',costId:saved.id,amount,pending,error:failure(error)};}
  return {state:'saved',costId:saved.id,amount,pending,notice:'partial'};
}

// Retry of the supplier payment only. The same request body yields the same
// idempotency identity, so no second cost and no second cash are produced.
export async function retryCostEntryPayment(params:{costId:string;amount:number},payment:CostEntryPaymentInput,
  deps:CostEntryDeps):Promise<CostEntryOutcome>{
  const payload=costEntryPaymentPayload(payment);
  const pending=costEntryPendingCents(params.amount,payment.amount)??0;
  try{await deps.pay(params.costId,payload,deps.keyFor(costEntryPayBody(params.costId,payload)));}
  catch(error){return {state:'payment-pending',costId:params.costId,amount:params.amount,pending,error:failure(error)};}
  return {state:'saved',costId:params.costId,amount:params.amount,pending,notice:'partial'};
}

export interface SupplierCreditLine{
  costId:string;description:string;supplier:string;amount:number;paid:number;pending:number;
}

// Supplier credit of one job, kept apart from the customer receivable. It is
// money the shop still owes its suppliers, never money the customer owes.
export function supplierCredit(costs:WorkshopCost[]|undefined,expenses:CaseExpense[]|undefined,
  orderId:string|undefined):{known:boolean;pending:number;lines:SupplierCreditLine[]}{
  const empty={known:false,pending:0,lines:[] as SupplierCreditLine[]};
  if(!orderId||!Array.isArray(costs)||!Array.isArray(expenses))return empty;
  const lines:SupplierCreditLine[]=[];
  for(const cost of costs){
    if(cost.order_id!==orderId||cost.kind!=='Compra directa')continue;
    const amount=amountCents(cost.amount);
    if(amount===null)return empty;
    const paid=expenses.filter(expense=>expense.direct_purchase_cost_id===cost.id)
      .reduce((sum,expense)=>sum+(amountCents(expense.amount)??0),0);
    lines.push({costId:cost.id,description:cost.description,supplier:cost.supplier,amount,paid,pending:amount-paid});
  }
  return {known:true,pending:lines.reduce((sum,line)=>sum+Math.max(line.pending,0),0),lines};
}
