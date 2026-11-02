import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationMoney} from '../src/controladores/operation-money';
import type {CaseFile} from '../src/lib/supabase/cases';

test('A draft budget is visible but does not invent a charge, cash receipt or debt from source controls',()=>{
  const file={quotes:[{id:'draft',order_id:'OT-1',revision:1,status:'Borrador',snapshot:{total:2190},source_totals:{advanceNotPosted:750,balanceNotPosted:1440}}]} as CaseFile;
  const summary=operationMoney(file,'OT-1');assert.equal(summary.quoted,2190);assert.equal(summary.charged,0);
  assert.equal(summary.paid,0);assert.equal(summary.balance,0);assert.equal(summary.state,'Por aprobar');
});
test('The latest scope, actual costs and scoped applications stay separate without doubling purchase cash or full client receipts',()=>{
  const file={quotes:[{id:'old',order_id:'OT-1',revision:1,status:'Aprobado',snapshot:{total:1856}},
    {id:'new',order_id:'OT-1',revision:2,status:'Aprobado',snapshot:{total:2190}}],costs:[{amount:120}],expenses:[{amount:120}],
    documents:[{scope_amount:2190,scope_balance:1490}],payments:[{amount:10000}],
    applications:[{kind:'Aplicacion',scope_amount:750},{kind:'Reversion',scope_amount:50}]} as CaseFile;
  const summary=operationMoney(file,'OT-1');assert.equal(summary.quoted,2190);assert.equal(summary.costs,120);
  assert.equal(summary.cashOut,120);assert.equal(summary.paid,700);assert.equal(summary.balance,1490);assert.equal(summary.unbilled,0);assert.equal(summary.state,'Pendiente');
});
test('An incurred cost is not cash paid and an active approved scope remains billable while the next revision is a draft',()=>{
  const file={orders:[{id:'OT-1',active_estimate_id:'approved'}],quotes:[
    {id:'approved',order_id:'OT-1',revision:1,status:'Aprobado',snapshot:{total:1856}},
    {id:'draft',order_id:'OT-1',revision:2,status:'Borrador',snapshot:{total:2190}}],costs:[{amount:120}],expenses:[]} as unknown as CaseFile;
  const summary=operationMoney(file,'OT-1');assert.equal(summary.quoted,2190);assert.equal(summary.unbilled,1856);
  assert.equal(summary.costs,120);assert.equal(summary.cashOut,0);assert.equal(summary.state,'Por emitir');
});
test('The permanent vehicle history does not confuse revision numbers across independent visits',()=>{
  const file={orders:[{id:'old',active_estimate_id:'old-quote'},{id:'new',active_estimate_id:'new-quote'}],quotes:[
    {id:'old-quote',order_id:'old',revision:5,created_at:'2026-09-01T12:00:00Z',status:'Aprobado',snapshot:{total:500}},
    {id:'new-quote',order_id:'new',revision:1,created_at:'2026-11-01T12:00:00Z',status:'Aprobado',snapshot:{total:100}}]} as unknown as CaseFile;
  assert.equal(operationMoney(file).quoted,100);assert.equal(operationMoney(file).unbilled,0);
  assert.equal(operationMoney(file,'old').unbilled,500);
});
