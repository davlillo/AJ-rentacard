import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  ADDITIONAL_REASON_HINT,
  PARENT_VERSION_CONFLICT_NOTICE,
  RE_APPROVAL_NOTICE,
  clarityLabels,
  cloneClarityLines,
  hasParentVersionConflict,
  needsClientApproval,
  planAdditionalItem,
  planAdditionalItemForOrder,
  reApprovalNotice,
  removedJargonLabels,
  type ClarityQuote,
} from '../src/controladores/budget-clarity';
import {budgetAdditionalItems,budgetDraftTotals,type BudgetQuoteForAdditionals} from '../src/controladores/budget-draft';

function quote(id:string,revision:number,status:string):ClarityQuote{
  return {id,revision,status,snapshot:{lines:[
    {description:'Cambio de boquillas',kind:'Material',quantity:2,unitPrice:45,unitCost:20},
    {description:'Mano de obra',kind:'Trabajo',quantity:1,unitPrice:45,unitCost:30},
  ]}};
}

test('An extra item copies the whole scope and appends exactly one empty line',()=>{
  const plan=planAdditionalItem(quote('q1',3,'Aprobado'));
  assert.equal(plan.lines.length,3);
  assert.equal(plan.lines[0].description,'Cambio de boquillas');
  assert.equal(plan.lines[1].description,'Mano de obra');
  assert.equal(plan.newLineIndex,2);
  assert.deepEqual(plan.lines[2],{description:'',kind:'Material',quantity:'1',unitPrice:'',unitCost:''});
});

test('The extra line keeps the internal cost optional and the client price manual',()=>{
  const plan=planAdditionalItem(quote('q1',1,'Borrador'));
  const extra=plan.lines[plan.newLineIndex];
  assert.equal(extra.unitCost,'');
  assert.equal(extra.unitPrice,'');
  const totals=budgetDraftTotals(plan.lines,'0');
  assert.equal(totals.costComplete,false);
  assert.equal(totals.priceComplete,false);
  assert.equal(totals.margin,null);
});

test('Adding an extra item never derives the client price from the internal cost',()=>{
  const plan=planAdditionalItem(quote('q1',1,'Borrador'));
  const extra=plan.lines[plan.newLineIndex];
  assert.equal(extra.unitCost,'');
  assert.equal(extra.unitPrice,'');
  const priced=budgetDraftTotals([{quantity:'1',unitPrice:'80',unitCost:''}],'0');
  assert.equal(priced.cost,0);
  assert.equal(priced.priceComplete,true);
  assert.equal(priced.margin,null);
});

test('An extra item creates a new full-scope revision in Borrador attached to its parent',()=>{
  const plan=planAdditionalItem(quote('q1',3,'Aprobado'));
  assert.equal(plan.parentId,'q1');
  assert.equal(plan.revision,4);
  assert.equal(plan.status,'Borrador');
  assert.equal(plan.section,'pricing');
});

test('The extra item revision hangs from the latest revision of the order',()=>{
  const plan=planAdditionalItemForOrder([quote('q1',1,'Rechazado'),quote('q2',2,'Aprobado')]);
  assert.equal(plan?.parentId,'q2');
  assert.equal(plan?.revision,3);
  assert.equal(plan?.status,'Borrador');
});

test('Saving over an approved quote states that the client must approve the new total again',()=>{
  assert.ok(reApprovalNotice('Aprobado'));
  assert.match(reApprovalNotice('Aprobado')!,/aprobar/);
  assert.match(reApprovalNotice('Aprobado')!,/total/);
  assert.equal(reApprovalNotice('Borrador'),null);
  assert.equal(reApprovalNotice('Rechazado'),null);
  assert.equal(reApprovalNotice(null),null);
  assert.ok(planAdditionalItem(quote('q1',1,'Aprobado')).reApprovalNotice);
  assert.equal(planAdditionalItem(quote('q1',1,'Borrador')).reApprovalNotice,null);
});

test('The approved version stays active until the client accepts the new total',()=>{
  assert.match(RE_APPROVAL_NOTICE,/sigue vigente/);
  assert.match(RE_APPROVAL_NOTICE,/antes de cobrar/);
});

test('A revision copied from a draft that descends from an approved scope still needs a new agreement',()=>{
  const versions=[{id:'q1',parent_id:null,status:'Aprobado'},{id:'q2',parent_id:'q1',status:'Borrador'}];
  assert.equal(needsClientApproval(versions,'q2'),true);
  assert.equal(needsClientApproval(versions,'q1'),true);
  assert.equal(needsClientApproval([{id:'q3',parent_id:null,status:'Borrador'}],'q3'),false);
  assert.equal(needsClientApproval(versions,null),false);
  const cyclic=[{id:'a',parent_id:'b',status:'Borrador'},{id:'b',parent_id:'a',status:'Borrador'}];
  assert.equal(needsClientApproval(cyclic,'a'),false);
  assert.ok(planAdditionalItem(quote('q2',2,'Borrador'),versions).reApprovalNotice);
});

test('The extra item flow never approves, issues or switches the active scope by itself',()=>{
  const plan=planAdditionalItem(quote('q1',1,'Aprobado'));
  assert.equal(plan.status,'Borrador');
  assert.equal(plan.autoApprove,false);
  assert.equal(plan.autoIssue,false);
});

test('A stale parent revision is surfaced instead of silently overwriting the scope',()=>{
  assert.equal(hasParentVersionConflict('q1','q2'),true);
  assert.equal(hasParentVersionConflict('q2','q2'),false);
  assert.equal(hasParentVersionConflict(null,'q2'),true);
  assert.match(PARENT_VERSION_CONFLICT_NOTICE,/versión más reciente/);
});

test('Copied lines are independent from the saved snapshot',()=>{
  const source=quote('q1',1,'Borrador');
  const copy=cloneClarityLines([{description:'Cambio de boquillas',kind:'Material',quantity:'2',unitPrice:'45',unitCost:'20'}]);
  copy[0].description='alterado';
  assert.equal(source.snapshot.lines[0].description,'Cambio de boquillas');
});

test('Plain wording replaces the old jargon labels',()=>{
  assert.equal(clarityLabels.internalCost,'Costo interno');
  assert.equal(clarityLabels.internalUnitCost,'Costo interno unitario (opcional)');
  assert.equal(clarityLabels.internalMargin,'Diferencia entre el precio y el costo (uso interno)');
  assert.equal(clarityLabels.missingCost,'Sin costo aún');
  assert.equal(clarityLabels.missingPrice,'Sin precio aún');
  assert.equal(clarityLabels.approver,'Quién autoriza');
  assert.equal(clarityLabels.evidence,'Acuerdo con el cliente (escrito o mensaje)');
  const labels=Object.values(clarityLabels).join(' | ');
  for(const jargon of removedJargonLabels)assert.equal(labels.includes(jargon),false,jargon);
});

test('The reason guidance records an agreement without claiming the extra is approved',()=>{
  assert.match(ADDITIONAL_REASON_HINT,/acordó con el cliente/);
  assert.equal(/aprob/i.test(ADDITIONAL_REASON_HINT),false);
});

test('The extra line saved by the cost flow is reported as an additional item with its revision state',()=>{
  const parent=quote('q1',1,'Aprobado');
  const plan=planAdditionalItem(parent);
  const priced={...plan.lines[plan.newLineIndex],description:'Inyectores',unitPrice:'150',unitCost:'40'};
  const versions:BudgetQuoteForAdditionals[]=[
    {id:'q1',revision:1,parent_id:null,status:'Aprobado',snapshot:{lines:parent.snapshot.lines}},
    {id:'q2',revision:2,parent_id:'q1',status:'Borrador',
      snapshot:{lines:[...parent.snapshot.lines,priced].map(line=>({description:line.description,
        quantity:Number(line.quantity),unitPrice:Number(line.unitPrice),unitCost:line.unitCost===''?null:Number(line.unitCost)}))}},
  ];
  const items=budgetAdditionalItems(versions,[{id:'c1',description:'Inyectores',amount:40,
    disposition:'Adicional autorizado',estimate_id:'q1'}]);
  assert.deepEqual(items.lines,[{quoteId:'q2',revision:2,status:'Borrador',description:'Inyectores',amount:150}]);
  assert.deepEqual(items.outside,[{costId:'c1',description:'Inyectores',amount:40}]);
  // The approved version stays the only chargeable scope: the extra is still pending.
  assert.equal(items.lines[0].status,'Borrador');
});
