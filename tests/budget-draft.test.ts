import {test} from 'node:test';
import assert from 'node:assert/strict';
import {budgetDraftTotals} from '../src/controladores/budget-draft';

test('Budget draft shows2x45+45-5=130 without requiring invented internal costs',()=>{
  const totals=budgetDraftTotals([{quantity:'2',unitPrice:'45',unitCost:''},{quantity:'1',unitPrice:'45',unitCost:''}],'5');
  assert.equal(totals.subtotal,135);assert.equal(totals.total,130);assert.equal(totals.costComplete,false);
  assert.deepEqual(totals.costs,[null,null]);
});

test('Budget draft adds rounded line amounts rather than rounding only the final subtotal',()=>{
  const totals=budgetDraftTotals([{quantity:'1',unitPrice:'0.005',unitCost:'0.005'},
    {quantity:'1',unitPrice:'0.005',unitCost:'0.005'}],'0');
  assert.deepEqual(totals.prices,[.01,.01]);assert.equal(totals.total,.02);assert.equal(totals.cost,.02);
});

test('Budget draft rounds binary-sensitive half cents using the same positive half-up policy as PostgreSQL',()=>{
  const totals=budgetDraftTotals([{quantity:'1',unitPrice:'10.075',unitCost:'10.075'},
    {quantity:'1',unitPrice:'1.005',unitCost:'1.005'}],'0');
  assert.deepEqual(totals.prices,[10.08,1.01]);assert.equal(totals.total,11.09);assert.equal(totals.cost,11.09);
});

test('Internal maintenance preview separates120known costs from zero commercial price and unknown costs',()=>{
  const lines=[{quantity:'2',unitPrice:'0',unitCost:'50'},{quantity:'1',unitPrice:'0',unitCost:'20'}];
  const totals=budgetDraftTotals(lines,'0');assert.equal(totals.total,0);assert.equal(totals.cost,120);
  assert.equal(totals.costComplete,true);
  assert.equal(budgetDraftTotals([...lines,{quantity:'1',unitPrice:'0',unitCost:''}],'0').costComplete,false);
  assert.equal(budgetDraftTotals([{quantity:'1',unitPrice:'0',unitCost:'0'}],'0').costComplete,true);
});
