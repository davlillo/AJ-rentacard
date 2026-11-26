import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {allocationSummary,classificationChoice,classificationError,costFinancialAccess,reconcileCosts,supplierSummary} from '../src/controladores/workshop-cost-workspace';
import type {WorkshopCost} from '../src/lib/supabase/workshop';

const cost={id:'motor',order_id:'OT-1',amount:500,version:1,disposition:'Pendiente'} as WorkshopCost;
test('Pending or unknown classifications never commit an unchosen internal decision',()=>{
  assert.equal(classificationChoice('Pendiente'),'');
  assert.equal(classificationChoice('Legacy warranty'),'');
  for(const value of ['Incluido','Adicional autorizado','Interno','Absorbido'])assert.equal(classificationChoice(value),value);
});
test('Cost breakdown uses this job share, exact cents, and explicit empty retirement',()=>{
  assert.deepEqual(allocationSummary(500,[{amount:'420'},{amount:'80'}]),{total:50000,allocated:50000,remainder:0,valid:true});
  assert.equal(allocationSummary(500,[{amount:'420'},{amount:'100'}]).remainder,-2000);
  assert.equal(allocationSummary(500,[{amount:'420'},{amount:'100'}]).valid,false);
  assert.equal(allocationSummary('0.30',[{amount:'0.10'},{amount:'0.20'}]).remainder,0);
  assert.equal(allocationSummary(500,[{amount:'1.001'}]).valid,false);
  assert.deepEqual(allocationSummary(500,[]),{total:50000,allocated:0,remainder:50000,valid:true});
});
test('Paying 200 keeps the acquired 500 cost independent of breakdown and price',()=>{
  assert.deepEqual(supplierSummary(cost,[{id:'pay',direct_purchase_cost_id:'motor',amount:200,date:'2026-11-10'}]),
    {total:50000,paid:20000,pending:30000});
  assert.equal(cost.amount,500);
});
test('Both current permission and explicit case access are required',()=>{
  for(const access of [undefined,false,true])for(const permission of [false,true])
    assert.equal(costFinancialAccess(access,permission),access===true&&permission);
});
test('Parent refresh and row reads reconcile by version without crossing job scope',()=>{
  const newer={...cost,version:3,disposition:'Absorbido'};
  assert.deepEqual(reconcileCosts([cost],[newer,{...cost,id:'other',order_id:'OT-2'}],'OT-1'),[newer]);
  assert.deepEqual(reconcileCosts([newer],[cost],'OT-1'),[newer]);
});
test('Classification requires explicit taxonomy, approved same-job scope and audit reason',()=>{
  assert.ok(classificationError('','',[],'Reason',false));
  assert.ok(classificationError('Incluido','draft',['approved'],'Reason',false));
  assert.ok(classificationError('Adicional autorizado','approved',['approved'],'Reason',true));
  assert.ok(classificationError('Interno','',[],' ',true));
  assert.equal(classificationError('Interno','',[],'Fleet maintenance',true),'');
  assert.equal(classificationError('Absorbido','',[],'Business decision',false),'');
  assert.equal(classificationError('Incluido','approved',['approved'],'Scope checked',false),'');
});
test('Registrar costo is a modal: one trigger, the question inline and no second inline entry alive',()=>{
  const source=readFileSync(new URL('../src/components/organisms/workshop-costs.tsx',import.meta.url),'utf8');
  assert.match(source,/DialogTrigger/);
  assert.match(source,/classificationOptions\(/);
  assert.match(source,/costClassificationQuestion/);
  assert.equal(source.includes('styles.entry} aria-label="Registrar costo"'),false);
  // The detail classification command and its approved-scope validation are preserved.
  assert.match(source,/ClassificationForm/);
  assert.match(source,/classificationError/);
  assert.match(source,/costDispositions/);
});
