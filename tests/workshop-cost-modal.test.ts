import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  classificationOptions,costClassificationHint,costClassificationOptions,costClassificationQuestion,
  costModalError,extraPriceLabel,extraQuoteLine,extraQuotePayload,internalJobNotice,reApprovalNotice,
  runCostModal,continueCostModal,type CostModalDeps,type CostModalInput,
} from '../src/controladores/workshop-cost-modal';
import type {QuoteVersion} from '../src/lib/supabase/estimates';
import type {CostEntryCostInput} from '../src/controladores/workshop-cost-entry';

const cost:CostEntryCostInput={
  orderId:'OT-1',description:'Inyector',quantity:'1',unitCost:'40.00',
  supplier:'Proveedor sintético',sourceReference:'FACT-9',date:'2026-11-10',
};
const quote={id:'quote-approved',order_id:'OT-1',revision:2,parent_id:null,status:'Aprobado',folio_number:41,
  snapshot:{lines:[{description:'Diagnóstico',kind:'Mano de obra',quantity:1,unitPrice:90,unitCost:30},
    {description:'Limpieza',kind:'Material',quantity:1,unitPrice:60,unitCost:20}],discount:5},
  reason:'Alcance aprobado',created_at:'2026-11-10T12:00:00Z'} as unknown as QuoteVersion;

function input(overrides:Partial<CostModalInput>={}):CostModalInput{
  return{answer:'none',cost,classification:'Incluido',reason:'Ya estaba en el alcance aprobado',
    extraPrice:'',internal:false,approvedEstimateId:quote.id,latestQuote:quote,...overrides};
}

interface Call{command:string;payload:Record<string,unknown>;costId?:string;key:string}
function recorder(overrides:(calls:Call[])=>Partial<CostModalDeps>=()=>({})){
  const calls:Call[]=[];const keys=new Map<string,string>();let counter=0;
  const deps:CostModalDeps={
    keyFor:body=>{if(!keys.has(body)){counter+=1;keys.set(body,`key-${counter}`);}return keys.get(body)!;},
    purchase:async(payload,key)=>{calls.push({command:'purchase',payload,key});return{id:'cost-1',amount:40,version:1};},
    pay:async(costId,payload,key)=>{calls.push({command:'pay',payload,costId,key});},
    classify:async(costId,payload,key)=>{calls.push({command:'classify',payload,costId,key});},
    revision:async(payload,key)=>{calls.push({command:'revision',payload,key});return{revision:3};},
    linkedExpense:orderId=>{calls.push({command:'linked-expense',payload:{orderId},key:'none'});},
  };
  return{calls,deps:{...deps,...overrides(calls)}};
}

test('The classification question offers exactly the operator wording and hides sale options on an internal job',()=>{
  assert.equal(costClassificationQuestion,'¿Este costo está incluido en el presupuesto?');
  assert.deepEqual(costClassificationOptions.map(option=>option.value),
    ['Incluido','Adicional autorizado','Interno','Absorbido']);
  assert.equal(costClassificationOptions[0].label,'Sí, ya está incluido');
  assert.equal(costClassificationOptions[1].label,'No, es un adicional');
  assert.equal(costClassificationOptions[2].label,'A cargo del negocio');
  assert.deepEqual(classificationOptions(true).map(option=>option.value),['Interno','Absorbido']);
  assert.deepEqual(classificationOptions(false),costClassificationOptions);
  assert.match(costClassificationHint,/presupuesto aprobado/);
  assert.match(extraPriceLabel,/Precio al cliente/);
});

test('The modal validates the cost, the classification, the reason and the extra price',()=>{
  assert.match(costModalError(input({classification:''})),/incluido en el presupuesto/);
  assert.match(costModalError(input({reason:' '})),/motivo/);
  const extra=input({classification:'Adicional autorizado',extraPrice:''});
  assert.match(costModalError(extra),/precio al cliente del adicional/);
  assert.equal(costModalError({...extra,extraPrice:'25.50'}),'');
  assert.match(costModalError(input({cost:{...cost,description:''}})),/repuesto o servicio/i);
  assert.equal(costModalError(input({internal:true,classification:''})),'');
});

test('Paid in full keeps the shared expense path and never buys or classifies',async()=>{
  const{calls,deps}=recorder();
  const outcome=await runCostModal(input({answer:'full',classification:''}),deps);
  assert.deepEqual(outcome,{state:'linked-expense',orderId:'OT-1'});
  assert.deepEqual(calls.map(call=>call.command),['linked-expense']);
});

test('An included cost is acquired and classified against the approved quote with the audit reason',async()=>{
  const{calls,deps}=recorder();
  const outcome=await runCostModal(input(),deps);
  assert.equal(outcome.state,'saved');
  assert.deepEqual(calls.map(call=>call.command),['purchase','classify']);
  assert.equal(calls[1].payload.disposition,'Incluido');
  assert.equal(calls[1].payload.estimateId,quote.id);
  assert.equal(calls[1].payload.expectedVersion,1);
  assert.equal(calls[1].payload.reason,'Ya estaba en el alcance aprobado');
  if(outcome.state==='saved')assert.equal(outcome.classification,'committed');
});

test('An extra is acquired, classified and appended to a new full-scope draft revision',async()=>{
  const{calls,deps}=recorder();
  const line=extraQuoteLine(cost,'55.00');
  const payload=extraQuotePayload({orderId:'OT-1',vehicleId:'vehicle-1',customerId:'customer-1',
    service:'Cambio de inyectores',area:'Mecánica',quote},line,'Acordado con el cliente');
  const outcome=await runCostModal(input({classification:'Adicional autorizado',extraPrice:'55.00',
    reason:'Acordado con el cliente',quotePayload:payload}),deps);
  assert.equal(outcome.state,'saved');
  assert.deepEqual(calls.map(call=>call.command),['purchase','classify','revision']);
  assert.equal(calls[1].payload.disposition,'Adicional autorizado');
  assert.equal(calls[1].payload.estimateId,quote.id);
  const revision=calls[2].payload;
  assert.equal(revision.parentId,quote.id);
  assert.equal(revision.discount,'5');
  const lines=revision.lines as Record<string,unknown>[];
  assert.equal(lines.length,3,'the whole approved scope is copied');
  assert.deepEqual(lines[2],{description:'Inyector',kind:'Material',quantity:'1',unitPrice:'55.00',unitCost:'40.00'});
  if(outcome.state==='saved'){assert.equal(outcome.revision,3);assert.equal(outcome.classification,'committed');}
  assert.match(reApprovalNotice,/debe aprobar el nuevo total/);
});

test('Without an approved quote the cost is saved and stays pending, with no invented scope',async()=>{
  const{calls,deps}=recorder();
  const outcome=await runCostModal(input({approvedEstimateId:null}),deps);
  assert.equal(outcome.state,'saved');
  assert.deepEqual(calls.map(call=>call.command),['purchase']);
  if(outcome.state==='saved')assert.equal(outcome.classification,'pending');
});

test('An internal job saves the cost pending and never classifies it as a sale',async()=>{
  const{calls,deps}=recorder();
  const outcome=await runCostModal(input({internal:true,classification:''}),deps);
  assert.equal(outcome.state,'saved');
  assert.deepEqual(calls.map(call=>call.command),['purchase']);
  assert.match(internalJobNotice,/Trabajo interno/);
});

test('A failed classification keeps the cost and retries only it and the revision with the same keys',async()=>{
  const{calls,deps}=recorder(()=>({classify:async(costId,payload,key)=>{
    calls.push({command:'classify',payload,costId,key});
    if(calls.filter(call=>call.command==='classify').length===1)throw new Error('Sin permiso');}}));
  const line=extraQuoteLine(cost,'55.00');
  const payload=extraQuotePayload({orderId:'OT-1',vehicleId:'vehicle-1',customerId:'customer-1',
    service:'Cambio de inyectores',area:'Mecánica',quote},line,'Acordado');
  const outcome=await runCostModal(input({classification:'Adicional autorizado',extraPrice:'55.00',
    reason:'Acordado',quotePayload:payload}),deps);
  assert.equal(outcome.state,'classification-pending');
  if(outcome.state!=='classification-pending')return;
  assert.equal(outcome.costId,'cost-1');
  assert.ok(outcome.remaining.classification);
  const first=calls[0];
  const retried=await continueCostModal(outcome.costId,outcome.amount,outcome.pending,outcome.remaining,deps);
  assert.equal(retried.state,'saved');
  assert.deepEqual(calls.map(call=>call.command),['purchase','classify','classify','revision']);
  assert.equal(calls[0].key,first.key,'no second cost');
  assert.equal(calls[1].key,calls[2].key,'the classification retry reuses its identity');
  if(retried.state==='saved')assert.equal(retried.revision,3);
});

test('A failed revision keeps cost and classification and retries only the revision',async()=>{
  const{calls,deps}=recorder(()=>({revision:async(payload,key)=>{
    calls.push({command:'revision',payload,key});
    if(calls.filter(call=>call.command==='revision').length===1)throw new Error('Versión desactualizada');
    return{revision:3};}}));
  const line=extraQuoteLine(cost,'55.00');
  const payload=extraQuotePayload({orderId:'OT-1',vehicleId:'vehicle-1',customerId:'customer-1',
    service:'Cambio de inyectores',area:'Mecánica',quote},line,'Acordado');
  const outcome=await runCostModal(input({classification:'Adicional autorizado',extraPrice:'55.00',
    reason:'Acordado',quotePayload:payload}),deps);
  assert.equal(outcome.state,'revision-pending');
  if(outcome.state!=='revision-pending')return;
  assert.equal(outcome.remaining.classification,undefined);
  const retried=await continueCostModal(outcome.costId,outcome.amount,outcome.pending,outcome.remaining,deps);
  assert.equal(retried.state,'saved');
  assert.deepEqual(calls.map(call=>call.command),['purchase','classify','revision','revision']);
  assert.equal(calls[2].key,calls[3].key);
});

test('A failed payment keeps the cost and later continues classification with the same identity',async()=>{
  const{calls,deps}=recorder(()=>({pay:async(costId,payload,key)=>{
    calls.push({command:'pay',payload,costId,key});
    if(calls.filter(call=>call.command==='pay').length===1)throw new Error('Caja sin fondos');}}));
  const payment={amount:'12.50',date:'2026-11-10',method:'Efectivo',account:'Caja'};
  const outcome=await runCostModal(input({answer:'part',payment}),deps);
  assert.equal(outcome.state,'payment-pending');
  if(outcome.state!=='payment-pending')return;
  assert.equal(outcome.pending,2750);
  const retried=await continueCostModal(outcome.costId,outcome.amount,outcome.pending,outcome.remaining,deps);
  assert.equal(retried.state,'saved');
  assert.deepEqual(calls.map(call=>call.command),['purchase','pay','pay','classify']);
  assert.equal(calls[1].key,calls[2].key);
  if(retried.state==='saved')assert.equal(retried.notice,'partial');
});

test('The extra payload never approves, issues or prices the whole budget',()=>{
  const line=extraQuoteLine(cost,'55.00');
  const payload=extraQuotePayload({orderId:'OT-1',vehicleId:'vehicle-1',customerId:'customer-1',
    service:'Cambio de inyectores',area:'Mecánica',quote},line,'Acordado');
  assert.deepEqual(Object.keys(payload).sort(),['area','customerId','discount','internalJob','lines','orderId',
    'parentId','reason','service','vehicleId']);
  assert.equal(payload.internalJob,false);
  assert.match(String(payload.reason),/Adicional por costo/);
});

test('The inline form is replaced by a dialog with the question in one place',()=>{
  const source=readFileSync(new URL('../src/components/organisms/workshop-costs.tsx',import.meta.url),'utf8');
  assert.match(source,/DialogTrigger/);
  assert.match(source,/DialogContent/);
  assert.match(source,/costModalConsequence/);
  assert.match(source,/costClassificationQuestion/);
  assert.equal(source.includes('styles.entry} aria-label="Registrar costo"'),false,'the old inline section is gone');
  assert.equal(source.includes('runCostEntry('),false);
  assert.match(source,/Reintentar solo el pago al proveedor/);
  assert.match(source,/Reintentar agregar el adicional al presupuesto/);
});
