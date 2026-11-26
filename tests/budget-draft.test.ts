import {test} from 'node:test';
import assert from 'node:assert/strict';
import {additionalLineIndexes,budgetAdditionalItems,budgetDraftTotals,type BudgetQuoteForAdditionals} from '../src/controladores/budget-draft';

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

test('Cost-first preview leaves the customer price manual and subtracts costs after the discount',()=>{
  const totals=budgetDraftTotals([{quantity:'2',unitPrice:'45',unitCost:'20'},{quantity:'1',unitPrice:'45',unitCost:'30'}],'5');
  assert.equal(totals.cost,70);assert.equal(totals.total,130);
  assert.equal(totals.priceComplete,true);assert.equal(totals.margin,60);
});

test('Cost-first preview never presents missing cost or missing selling price as profit',()=>{
  assert.equal(budgetDraftTotals([{quantity:'1',unitPrice:'80',unitCost:''}],'0').margin,null);
  const unpriced=budgetDraftTotals([{quantity:'1',unitPrice:'',unitCost:'50'}],'0');
  assert.equal(unpriced.cost,50);assert.equal(unpriced.priceComplete,false);assert.equal(unpriced.margin,null);
  assert.equal(budgetDraftTotals([{quantity:'1',unitPrice:'80',unitCost:'0'}],'0').margin,80);
});

test('Cost-first preview preserves losses, per-line cents and the internal-maintenance exception',()=>{
  assert.equal(budgetDraftTotals([{quantity:'1',unitPrice:'40',unitCost:'50'}],'0').margin,-10);
  assert.equal(budgetDraftTotals([{quantity:'1',unitPrice:'0.005',unitCost:'0.004'}],'0').margin,.01);
  assert.equal(budgetDraftTotals([{quantity:'1',unitPrice:'0',unitCost:'50'}],'0',true).margin,null);
});

test('Labor and material are split per kind for the client price and for the internal cost',()=>{
  const totals=budgetDraftTotals([
    {kind:'Material',quantity:'2',unitPrice:'45',unitCost:'20'},
    {kind:'Trabajo',quantity:'1',unitPrice:'45',unitCost:'30'},
    {kind:'Tercero',quantity:'1',unitPrice:'10',unitCost:'4'},
    {kind:'Indirecto',quantity:'1',unitPrice:'5',unitCost:''}],'5');
  assert.deepEqual(totals.priceByKind,{material:90,labor:45,thirdParty:10,indirect:5});
  assert.deepEqual(totals.costByKind,{material:40,labor:30,thirdParty:4,indirect:0});
  // The split explains the same lines: it never becomes a second, contradictory total.
  assert.equal(totals.subtotal,150);
  assert.equal(totals.total,145);
  assert.equal(totals.subtotal-totals.total,5);
  const split=Object.values(totals.priceByKind).reduce((sum,amount)=>sum+amount,0);
  assert.equal(Math.round(split*100)/100,totals.subtotal);
});

test('A budget without labor still reports its material split and no labor amount',()=>{
  const totals=budgetDraftTotals([{kind:'Material',quantity:'1',unitPrice:'120',unitCost:'40'}],'20');
  assert.deepEqual(totals.priceByKind,{material:120,labor:0,thirdParty:0,indirect:0});
  assert.equal(totals.total,100);
  assert.equal(Object.values(totals.priceByKind).reduce((sum,amount)=>sum+amount,0),totals.subtotal);
});

test('A budget without material still reports its labor split and no material amount',()=>{
  const totals=budgetDraftTotals([{kind:'Trabajo',quantity:'3',unitPrice:'30',unitCost:'10'}],'0');
  assert.deepEqual(totals.priceByKind,{material:0,labor:90,thirdParty:0,indirect:0});
  assert.equal(totals.total,90);
});

test('Per-kind cost totals only add known costs and never invent a missing one',()=>{
  const totals=budgetDraftTotals([{kind:'Material',quantity:'1',unitPrice:'80',unitCost:''},
    {kind:'Trabajo',quantity:'1',unitPrice:'20',unitCost:'5'}],'0');
  assert.deepEqual(totals.costByKind,{material:0,labor:5,thirdParty:0,indirect:0});
  assert.equal(totals.costComplete,false);assert.equal(totals.cost,5);assert.equal(totals.margin,null);
});

function quote(id:string,revision:number,parent:string|null,status:string,lines:{description:string;kind:string;quantity:number;unitPrice:number;unitCost:number|null}[]):BudgetQuoteForAdditionals{
  return{id,revision,parent_id:parent,status,snapshot:{lines}};
}
const SCOPE={description:'Synthetic replacement',kind:'Material',quantity:2,unitPrice:50,unitCost:20};

test('A line appended to a new full-scope revision is reported as an additional item',()=>{
  const versions=[quote('q1',1,null,'Aprobado',[SCOPE]),
    quote('q2',2,'q1','Borrador',[SCOPE,{description:'Parabrisas adicional',kind:'Material',quantity:1,unitPrice:120,unitCost:40}])];
  assert.deepEqual(additionalLineIndexes(versions[1].snapshot.lines,versions[0].snapshot.lines),[1]);
  const items=budgetAdditionalItems(versions,[]);
  assert.equal(items.lines.length,1);
  assert.deepEqual(items.lines[0],{quoteId:'q2',revision:2,status:'Borrador',description:'Parabrisas adicional',amount:120});
  assert.deepEqual(items.outside,[]);
});

test('A rewritten scope is never labelled as an additional item',()=>{
  const versions=[quote('q1',1,null,'Aprobado',[SCOPE]),
    quote('q2',2,'q1','Borrador',[{...SCOPE,unitPrice:55},{description:'Parabrisas adicional',kind:'Material',quantity:1,unitPrice:120,unitCost:40}])];
  assert.deepEqual(additionalLineIndexes(versions[1].snapshot.lines,versions[0].snapshot.lines),[]);
  assert.deepEqual(budgetAdditionalItems(versions,[]).lines,[]);
});

test('An authorized additional whose amount is not inside an approved scope is surfaced with its amount',()=>{
  const versions=[quote('q1',1,null,'Aprobado',[SCOPE]),
    quote('q2',2,'q1','Borrador',[SCOPE,{description:'Inyectores',kind:'Material',quantity:1,unitPrice:150,unitCost:40}])];
  const items=budgetAdditionalItems(versions,[{id:'c1',description:'Inyectores',amount:40,disposition:'Adicional autorizado',estimate_id:'q1'}]);
  assert.deepEqual(items.outside,[{costId:'c1',description:'Inyectores',amount:40}]);
  assert.equal(items.lines.length,1);
  assert.equal(items.lines[0].status,'Borrador');
});

test('An authorized additional already carried by the approved scope is not repeated as outside the budget',()=>{
  const versions=[quote('q1',1,null,'Aprobado',[SCOPE])];
  const items=budgetAdditionalItems(versions,[{id:'c1',description:'Synthetic replacement',amount:40,disposition:'Adicional autorizado',estimate_id:'q1'}]);
  assert.deepEqual(items.outside,[]);
});

test('Only an authorized additional is checked against the approved scope',()=>{
  const versions=[quote('q1',1,null,'Aprobado',[SCOPE])];
  const items=budgetAdditionalItems(versions,[
    {id:'c1',description:'Otra compra',amount:30,disposition:'Interno',estimate_id:null},
    {id:'c2',description:'Otra compra',amount:30,disposition:'Pendiente',estimate_id:null}]);
  assert.deepEqual(items.outside,[]);
});
