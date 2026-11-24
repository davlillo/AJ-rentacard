import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  amountCents,costEntryError,costEntryLabels,costEntryPaymentPayload,costEntryPlan,costEntryPendingCents,
  costEntryPurchaseBody,costEntryPurchasePayload,costEntryQuestion,costEntryTotalCents,
  retryCostEntryPayment,runCostEntry,supplierCredit,
  type CostEntryAnswer,type CostEntryCostInput,type CostEntryDeps,type CostEntryPaymentInput,
} from '../src/controladores/workshop-cost-entry';
import type {CaseExpense} from '../src/lib/supabase/cases';
import type {WorkshopCost} from '../src/lib/supabase/workshop';

const cost:CostEntryCostInput={
  orderId:'OT-1',description:'Pastilla de freno',quantity:'2',unitCost:'25.50',
  supplier:'Proveedor sintético',sourceReference:'FACT-1',date:'2026-11-10',
};
const payment:CostEntryPaymentInput={amount:'20.00',date:'2026-11-10',method:'Efectivo',account:'Caja'};

interface Call{command:string;payload:Record<string,unknown>;costId?:string;key:string}
function recorder(overrides:(base:CostEntryDeps,calls:Call[])=>Partial<CostEntryDeps>=()=>({})){
  const calls:Call[]=[];const keys=new Map<string,string>();let counter=0;
  const base:CostEntryDeps={
    keyFor:body=>{if(!keys.has(body)){counter+=1;keys.set(body,`key-${counter}`);}return keys.get(body)!;},
    purchase:async(payload,key)=>{calls.push({command:'purchase',payload,key});return {id:'cost-1',amount:51};},
    pay:async(costId,payload,key)=>{calls.push({command:'pay',payload,costId,key});},
    linkedExpense:orderId=>{calls.push({command:'linked-expense',payload:{orderId},key:'none'});},
  };
  return {calls,keys,deps:{...base,...overrides(base,calls)}};
}

test('The entry asks how much was paid and offers exactly three honest answers',()=>{
  assert.equal(costEntryQuestion,'¿Cuánto pagaste?');
  assert.deepEqual(Object.keys(costEntryLabels),['full','part','none']);
  assert.equal(costEntryLabels.full,'Todo');
  assert.equal(costEntryLabels.part,'Una parte');
  assert.match(costEntryLabels.none,/Nada todavía/);
});

test('Each answer maps to one canonical command sequence',()=>{
  assert.deepEqual(costEntryPlan('full',cost,payment).map(step=>step.kind),['linked-expense']);
  assert.deepEqual(costEntryPlan('none',cost).map(step=>step.kind),['purchase']);
  assert.deepEqual(costEntryPlan('part',cost,payment).map(step=>step.kind),['purchase','pay']);
});

test('No answer charges the customer, prices the work or commits a classification',()=>{
  const answers:CostEntryAnswer[]=['full','part','none'];
  for(const answer of answers)for(const step of costEntryPlan(answer,cost,payment)){
    const payload=step.payload as Record<string,unknown>;
    for(const forbidden of ['customerId','price','unitPrice','disposition','estimateId','margin','receipt'])
      assert.equal(Object.hasOwn(payload,forbidden),false,`${answer}/${forbidden}`);
  }
});

test('Paid in full reuses the shared expense path: one cash outflow, no purchase, no payment',async()=>{
  const {calls,deps}=recorder();
  const outcome=await runCostEntry('full',cost,payment,deps);
  assert.deepEqual(outcome,{state:'linked-expense',orderId:'OT-1'});
  assert.deepEqual(calls.map(call=>call.command),['linked-expense']);
});

test('Paid in part acquires the cost and records a first supplier payment with the right amounts',async()=>{
  const {calls,deps}=recorder();
  const outcome=await runCostEntry('part',cost,payment,deps);
  assert.equal(outcome.state,'saved');
  assert.deepEqual(calls.map(call=>call.command),['purchase','pay']);
  assert.deepEqual(calls[0].payload,costEntryPurchasePayload(cost));
  assert.equal(calls[0].payload.quantity,'2');
  assert.equal(calls[0].payload.unitCost,'25.50');
  assert.deepEqual(calls[1].payload,costEntryPaymentPayload(payment));
  assert.equal(calls[1].costId,'cost-1');
  assert.equal(calls[1].payload.amount,'20.00');
  if(outcome.state==='saved'){
    assert.equal(outcome.notice,'partial');
    assert.equal(outcome.pending,3100);
  }
});

test('Paid nothing yet acquires the cost with no cash at all',async()=>{
  const {calls,deps}=recorder();
  const outcome=await runCostEntry('none',cost,undefined,deps);
  assert.deepEqual(calls.map(call=>call.command),['purchase']);
  assert.equal(outcome.state,'saved');
  if(outcome.state==='saved'){
    assert.equal(outcome.notice,'credit');
    assert.equal(outcome.pending,5100);
  }
});

test('A failed purchase never attempts a payment',async()=>{
  const {calls,deps}=recorder((base,log)=>({purchase:async(payload,key)=>{
    log.push({command:'purchase',payload,key});throw new Error('Sin permiso');}}));
  const outcome=await runCostEntry('part',cost,payment,deps);
  assert.deepEqual(outcome,{state:'failed',error:'Sin permiso'});
  assert.deepEqual(calls.map(call=>call.command),['purchase']);
});

test('A failed first payment keeps the cost, reports the exact pending amount and issues no second cost',async()=>{
  const {calls,deps}=recorder((base,log)=>({pay:async(costId,payload,key)=>{
    log.push({command:'pay',payload,costId,key});throw new Error('Caja sin fondos');}}));
  const outcome=await runCostEntry('part',cost,payment,deps);
  assert.equal(outcome.state,'payment-pending');
  if(outcome.state==='payment-pending'){
    assert.equal(outcome.costId,'cost-1');
    assert.equal(outcome.amount,5100);
    assert.equal(outcome.pending,3100);
    assert.equal(outcome.error,'Caja sin fondos');
  }
  assert.deepEqual(calls.map(call=>call.command),['purchase','pay']);
});

test('The retry pays only the payment, with the same identity and no second cost',async()=>{
  const {calls,deps}=recorder((base,log)=>({pay:async(costId,payload,key)=>{
    log.push({command:'pay',payload,costId,key});throw new Error('Caja sin fondos');}}));
  await runCostEntry('part',cost,payment,deps);
  const first=calls[1];
  const retryDeps:CostEntryDeps={...deps,pay:async(costId,payload,key)=>{
    calls.push({command:'pay',payload,costId,key});}};
  const outcome=await retryCostEntryPayment({costId:'cost-1',amount:51},payment,retryDeps);
  assert.equal(outcome.state,'saved');
  assert.deepEqual(calls.map(call=>call.command),['purchase','pay','pay']);
  assert.equal(calls[2].key,first.key,'the retry reuses the same idempotency identity');
  assert.equal(calls[2].costId,'cost-1');
  assert.deepEqual(calls[2].payload,first.payload);
  assert.equal(calls.filter(call=>call.command==='purchase').length,1,'the cost is never registered twice');
});

test('A partial payment must stay below the acquired amount and carry its own account',()=>{
  assert.equal(costEntryError('part',cost,payment),'');
  assert.match(costEntryError('part',{...cost,quantity:'1',unitCost:'10.00'},payment),/costo total/);
  assert.match(costEntryError('part',cost,{...payment,amount:'0'}),/importe del pago parcial/);
  assert.match(costEntryError('part',cost,{...payment,amount:'51.00'}),/costo total/);
  assert.match(costEntryError('part',cost,{...payment,account:''}),/cuenta o caja/);
  assert.match(costEntryError('part',cost,{...payment,date:''}),/fecha del pago/);
  assert.match(costEntryError('part',{...cost,supplier:''},payment),/proveedor/);
  assert.match(costEntryError('part',{...cost,sourceReference:''},payment),/referencia/);
  assert.equal(costEntryError('full',{...cost,supplier:''},payment),'');
});

test('Amounts are exact in cents and the acquired total follows the stored rounding',()=>{
  assert.equal(amountCents('20.00'),2000);
  assert.equal(amountCents(51),5100);
  assert.equal(amountCents('20.005'),null);
  assert.equal(costEntryTotalCents('2','25.50'),5100);
  assert.equal(costEntryTotalCents('3','16.665'),5000);
  assert.equal(costEntryPendingCents('51.00','20.00'),3100);
  assert.equal(costEntryPendingCents(51,0),5100);
});

test('The purchase payload never carries a classification or an amount the server owns',()=>{
  const payload=costEntryPurchasePayload(cost);
  assert.deepEqual(Object.keys(payload).sort(),
    ['date','description','orderId','quantity','sourceReference','supplier','unitCost']);
  assert.equal(Object.hasOwn(payload,'disposition'),false);
  assert.equal(Object.hasOwn(payload,'amount'),false);
  assert.equal(costEntryPurchaseBody(payload),JSON.stringify({command:'purchase',payload}));
});

test('The supplier credit of a job is a separate fact, never the customer receivable',()=>{
  const costs=[{id:'c1',order_id:'OT-1',kind:'Compra directa',description:'Pastilla',supplier:'Proveedor',amount:100},
    {id:'c2',order_id:'OT-2',kind:'Compra directa',description:'Otro',supplier:'Otro',amount:500}] as unknown as WorkshopCost[];
  const expenses=[{id:'e1',direct_purchase_cost_id:'c1',amount:40}] as unknown as CaseExpense[];
  const credit=supplierCredit(costs,expenses,'OT-1');
  assert.equal(credit.known,true);
  assert.equal(credit.pending,6000);
  assert.equal(credit.lines.length,1);
  assert.equal(credit.lines[0].pending,6000);
  assert.equal(credit.lines[0].paid,4000);
  assert.equal(supplierCredit(costs,expenses,'OT-2').pending,50000);
  assert.equal(supplierCredit(undefined,expenses,'OT-1').known,false);
});

test('The workshop cost entry shows one entry with the three answers and no mechanism buttons',()=>{
  const source=readFileSync(new URL('../src/components/organisms/workshop-costs.tsx',import.meta.url),'utf8');
  assert.match(source,/costEntryQuestion/);
  assert.equal(source.includes('Gasto pagado'),false);
  assert.equal(source.includes('>Compra directa<'),false);
  assert.match(source,/costEntryLabels/);
});

test('The collections section keeps the customer receivable first and states the supplier credit apart',()=>{
  const source=readFileSync(new URL('../src/components/organisms/workshop-collections.tsx',import.meta.url),'utf8');
  const receivable=source.indexOf('Resumen de cobros');
  const supplier=source.indexOf('workshopMoneyLabels.pendingWithSupplier');
  assert.ok(receivable>0&&supplier>receivable,'the supplier credit comes after the customer receivable');
  assert.match(source,/supplierCredit/);
  assert.match(source,/workshopMoneyLabels.costsHeading/);
  // The supplier credit lives in its own labelled block, not in the customer summary.
  const summary=source.slice(source.indexOf('aria-label="Resumen de cobros"'),source.indexOf('</dl>'));
  assert.equal(summary.includes('pendingWithSupplier'),false);
});
