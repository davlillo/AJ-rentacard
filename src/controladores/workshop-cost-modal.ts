// Pure helpers and the command sequence of the "Registrar costo" modal. The
// modal composes the canonical commands only: the acquisition (`purchase`), the
// optional first supplier payment, the existing classification command and, for
// an extra, a new full-scope quote revision in Borrador. It never charges the
// customer and never approves or issues anything by itself.
import {RE_APPROVAL_NOTICE} from './budget-clarity';
import {amountCents,costEntryError,costEntryPayBody,costEntryPaymentPayload,costEntryPendingCents,
  costEntryPurchaseBody,costEntryPurchasePayload,type CostEntryAnswer,type CostEntryCostInput,
  type CostEntryPaymentInput} from './workshop-cost-entry';
import type {QuoteVersion} from '../lib/supabase/estimates';

export type CostClassification='Incluido'|'Adicional autorizado'|'Interno'|'Absorbido';

export const costClassificationQuestion='¿Este costo está incluido en el presupuesto?';
export const costClassificationHint='Incluido y adicional requieren un presupuesto aprobado. El motivo queda registrado.';
export const costReasonLabel='Motivo de la decisión';
export const costReasonHint='Explique por qué este costo tiene esa relación con el presupuesto; queda registrado.';
export const extraPriceLabel='Precio al cliente de este adicional (USD)';
export const extraPriceHint='Se agrega al presupuesto en una nueva versión en borrador. No se cobra todavía.';
export const costModalConsequence='Registra lo que compró el taller para este trabajo. No cobra al cliente ni cambia el presupuesto por sí solo.';
export const classificationPendingNotice='El costo quedó guardado. La relación con el presupuesto queda pendiente: no hay un presupuesto aprobado todavía; complétela cuando exista uno aprobado.';
export const internalJobNotice='Trabajo interno: el costo queda a cargo del negocio. Complétela como Interno cuando revise el costo.';
export const extraNoQuoteNotice='El costo quedó guardado. Todavía no hay un presupuesto de este trabajo: el adicional no se agregó; cree el presupuesto y agréguelo desde Presupuestos.';
export const reApprovalNotice=RE_APPROVAL_NOTICE;

export interface CostClassificationOption{value:CostClassification;label:string}

// The question in the operator's own words. Absorbido only appears where it
// exists today; an internal job hides the two choices that need an approved sale.
export const costClassificationOptions:CostClassificationOption[]=[
  {value:'Incluido',label:'Sí, ya está incluido'},
  {value:'Adicional autorizado',label:'No, es un adicional'},
  {value:'Interno',label:'A cargo del negocio'},
  {value:'Absorbido',label:'Absorbido por el negocio'},
];

export function classificationOptions(internal:boolean):CostClassificationOption[]{
  return internal?costClassificationOptions.filter(option=>!['Incluido','Adicional autorizado'].includes(option.value)):
    costClassificationOptions;
}

// Incluido and Adicional need an approved scope to be committed now. Interno and
// Absorbido never need a scope.
export function needsApprovedScope(classification:CostClassification|''):boolean{
  return classification==='Incluido'||classification==='Adicional autorizado';
}

export interface CostModalInput{
  answer:CostEntryAnswer;cost:CostEntryCostInput;payment?:CostEntryPaymentInput;
  classification:CostClassification|'';reason:string;extraPrice:string;
  internal:boolean;approvedEstimateId:string|null;latestQuote:QuoteVersion|null;
  quotePayload?:Record<string,unknown>;
}

export function costModalError(input:CostModalInput):string{
  const fieldError=costEntryError(input.answer,input.cost,input.payment);
  if(fieldError)return fieldError;
  if(input.internal)return '';
  if(!input.classification)return 'Indique si el costo está incluido en el presupuesto.';
  if(!input.reason.trim())return 'Indique el motivo de la decisión.';
  if(input.classification==='Adicional autorizado'&&input.latestQuote){
    const price=amountCents(input.extraPrice);
    if(price===null||price<=0)return 'Indique el precio al cliente del adicional.';
  }
  return '';
}

export interface ExtraQuoteLine{description:string;kind:'Material';quantity:string;unitPrice:string;unitCost:string|null}

export function extraQuoteLine(cost:CostEntryCostInput,unitPrice:string):ExtraQuoteLine{
  const unitCost=cost.unitCost.trim();
  return{description:cost.description.trim(),kind:'Material',quantity:cost.quantity.trim(),
    unitPrice:unitPrice.trim(),unitCost:unitCost===''?null:unitCost};
}

export interface ExtraQuoteBase{
  orderId:string;vehicleId:string;customerId:string|null;service:string;area:string;quote:QuoteVersion;
}

// A new full-scope revision: the whole saved scope is copied, the extra line is
// appended and the latest discount is kept. Nothing is approved here.
export function extraQuotePayload(base:ExtraQuoteBase,line:ExtraQuoteLine,reason:string):Record<string,unknown>{
  const snapshot=base.quote.snapshot;
  const lines=snapshot.lines.map(previous=>({description:previous.description,kind:previous.kind,
    quantity:String(previous.quantity),unitPrice:String(previous.unitPrice),unitCost:previous.unitCost===null?'':String(previous.unitCost)}));
  return{orderId:base.orderId,vehicleId:base.vehicleId,customerId:base.customerId,
    service:base.service,area:base.area,internalJob:false,parentId:base.quote.id,
    reason:`Adicional por costo de taller: ${reason.trim()}`,discount:String(snapshot.discount??0),
    lines:[...lines,line]};
}

export interface CostModalDeps{
  keyFor:(body:string)=>string;
  purchase:(payload:Record<string,unknown>,key:string)=>Promise<{id:string;amount:number;version:number}>;
  pay:(costId:string,payload:Record<string,unknown>,key:string)=>Promise<void>;
  classify:(costId:string,payload:Record<string,unknown>,key:string)=>Promise<void>;
  revision:(payload:Record<string,unknown>,key:string)=>Promise<{revision:number}>;
  linkedExpense:(orderId:string)=>void|Promise<void>;
}

export interface CostClassificationStep{costId:string;expectedVersion:number;disposition:CostClassification;
  estimateId:string|null;reason:string}
export interface CostRevisionStep{payload:Record<string,unknown>}
export interface CostModalRemaining{payment?:{costId:string;payload:Record<string,unknown>};
  classification?:CostClassificationStep;revision?:CostRevisionStep}

export type CostModalOutcome=
  |{state:'linked-expense';orderId:string}
  |{state:'failed';error:string}
  |{state:'saved';costId:string;amount:number;pending:number;notice:'credit'|'partial';
    classification:'committed'|'pending';revision:number|null}
  |{state:'payment-pending';costId:string;amount:number;pending:number;error:string;remaining:CostModalRemaining}
  |{state:'classification-pending';costId:string;amount:number;pending:number;error:string;remaining:CostModalRemaining}
  |{state:'revision-pending';costId:string;amount:number;pending:number;error:string;remaining:CostModalRemaining};

function failure(error:unknown):string{
  return error instanceof Error&&error.message?error.message:'No se pudo guardar. Revise los datos e intente de nuevo.';
}
export function classificationBody(step:CostClassificationStep):string{
  return JSON.stringify({command:'classify',payload:{costId:step.costId,expectedVersion:step.expectedVersion,
    disposition:step.disposition,estimateId:step.estimateId,reason:step.reason.trim()}});
}
export function revisionBody(payload:Record<string,unknown>):string{
  return JSON.stringify({command:'quote',payload});
}

function classificationStep(input:CostModalInput,costId:string,version:number):CostClassificationStep|null{
  if(input.internal||!input.classification)return null;
  if(needsApprovedScope(input.classification)&&!input.approvedEstimateId)return null;
  return{costId,expectedVersion:version,disposition:input.classification,
    estimateId:needsApprovedScope(input.classification)?input.approvedEstimateId:null,reason:input.reason};
}
function revisionStep(input:CostModalInput):CostRevisionStep|null{
  if(input.classification!=='Adicional autorizado'||!input.latestQuote||!input.quotePayload)return null;
  return{payload:input.quotePayload};
}

async function finish(costId:string,amount:number,pending:number,notice:'credit'|'partial',
  remaining:CostModalRemaining,deps:CostModalDeps):Promise<CostModalOutcome>{
  let classification:CostClassificationStep|undefined=remaining.classification;
  if(classification){
    try{
      const key=deps.keyFor(classificationBody(classification));
      await deps.classify(classification.costId,{costId:classification.costId,
        expectedVersion:classification.expectedVersion,disposition:classification.disposition,
        estimateId:classification.estimateId,reason:classification.reason.trim()},key);
    }catch(error){return{state:'classification-pending',costId,amount,pending,error:failure(error),
      remaining:{classification,revision:remaining.revision}};}
    classification=undefined;
  }
  let revision:number|null=null;
  if(remaining.revision){
    try{
      const saved=await deps.revision(remaining.revision.payload,deps.keyFor(revisionBody(remaining.revision.payload)));
      revision=saved.revision;
    }catch(error){return{state:'revision-pending',costId,amount,pending,error:failure(error),
      remaining:{revision:remaining.revision}};}
  }
  return{state:'saved',costId,amount,pending,notice,
    classification:remaining.classification?'committed':'pending',revision};
}

// Executes the modal in canonical order: purchase, first payment, classification,
// budget revision. Every failure keeps what was already saved and returns the
// exact remaining steps so only they are retried with the same identity.
export async function runCostModal(input:CostModalInput,deps:CostModalDeps):Promise<CostModalOutcome>{
  if(input.answer==='full'){await deps.linkedExpense(input.cost.orderId);return{state:'linked-expense',orderId:input.cost.orderId};}
  const problem=costModalError(input);
  if(problem)return{state:'failed',error:problem};
  const purchasePayload=costEntryPurchasePayload(input.cost);
  let saved:{id:string;amount:number;version:number};
  try{saved=await deps.purchase(purchasePayload,deps.keyFor(costEntryPurchaseBody(purchasePayload)));}
  catch(error){return{state:'failed',error:failure(error)};}
  const amount=amountCents(saved.amount)??0;
  const payment=input.payment;
  const pending=costEntryPendingCents(saved.amount,payment?.amount??'')??amount;
  const remaining:CostModalRemaining={classification:classificationStep(input,saved.id,saved.version)??undefined,
    revision:revisionStep(input)??undefined};
  if(payment&&input.answer==='part'){
    const payload=costEntryPaymentPayload(payment);
    try{await deps.pay(saved.id,payload,deps.keyFor(costEntryPayBody(saved.id,payload)));}
    catch(error){return{state:'payment-pending',costId:saved.id,amount,pending,error:failure(error),
      remaining:{payment:{costId:saved.id,payload},...remaining}};}
  }
  return finish(saved.id,amount,pending,payment&&input.answer==='part'?'partial':'credit',remaining,deps);
}

// Retry of exactly the failed part. The same bodies keep the same idempotency
// keys, so no second cost, payment or quote revision is produced.
export async function continueCostModal(costId:string,amount:number,pending:number,
  remaining:CostModalRemaining,deps:CostModalDeps):Promise<CostModalOutcome>{
  let rest:CostModalRemaining={...remaining};
  const partial=!!rest.payment;
  if(rest.payment){
    try{await deps.pay(rest.payment.costId,rest.payment.payload,
      deps.keyFor(costEntryPayBody(rest.payment.costId,rest.payment.payload)));}
    catch(error){return{state:'payment-pending',costId,amount,pending,error:failure(error),remaining:rest};}
    rest={classification:rest.classification,revision:rest.revision};
  }
  return finish(costId,amount,pending,partial?'partial':'credit',rest,deps);
}
