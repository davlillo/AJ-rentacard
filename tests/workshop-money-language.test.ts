import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {NOT_AVAILABLE,workshopAmountText,workshopMoneyLabels,workshopReceivableOverview} from '../src/controladores/workshop-money-language';
import {workshopSection} from '../src/controladores/workshop-pipeline';

const read=(path:string)=>readFileSync(path,'utf8');
const COLLECTIONS='src/components/organisms/workshop-collections.tsx';
const PAYMENTS='src/components/organisms/case-payments.tsx';
const PIPELINE='src/components/templates/workshop-case-screen.tsx';
const LANGUAGE='src/controladores/workshop-money-language.ts';
const OPERATION_MONEY='src/controladores/operation-money.ts';
const BILLING='src/components/templates/operational-billing.tsx';
const STYLES='src/app/operations.css';

// The card logic is a plain function, so it can be exercised without a browser. The module is
// transpiled and evaluated with stubbed imports: no network, no database, no rendered screen.
interface BillingLogic{
  rentalOperationLabel:(booking:{status:string;rental_state:string}|null|undefined,finalized:boolean)=>string;
  workshopOperationLabel:(status:string|null)=>string;
  collectionMoneyState:(state:string|null)=>string;
  collectionStatusReading:(operationLabel:string,moneyState:string)=>string;
}
function billingModule():BillingLogic{
  const compiled=ts.transpileModule(read(BILLING),{fileName:'operational-billing.tsx',
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module={exports:{} as Record<string,unknown>};
  const context=vm.createContext({module,exports:module.exports,console,
    require:(id:string)=>id==='react/jsx-runtime'?{jsx:()=>null,jsxs:()=>null,Fragment:{}}:{}});
  vm.runInContext(compiled,context);
  return module.exports as unknown as BillingLogic;
}

const summary=(over:Partial<Parameters<typeof workshopReceivableOverview>[0]>={})=>workshopReceivableOverview({
  known:true,agreed:1200,charged:1000,paid:600,balance:400,advances:100,unbilled:200,...over});

test('The workshop collections surface drops the old money jargon',()=>{
  const source=read(COLLECTIONS).toLowerCase();
  for(const jargon of ['Cargos y abonos','Cargos emitidos','Cargos y cobros','Emitir cargo','Total acordado','Acordado aún sin emitir'])
    assert.equal(source.includes(jargon.toLowerCase()),false,`the workshop surface still shows "${jargon}"`);
});

test('The workshop surfaces name the receivable in plain language',()=>{
  const source=read(COLLECTIONS);
  const labels=read(LANGUAGE);
  for(const wording of ['Importe facturado al cliente','Cobro aplicado a este trabajo','Pendiente de cobro','Anticipo disponible',
    'Importe acordado con el cliente','Documento de cobro','Emitir importe a cobrar','Preparar importe a cobrar'])
    assert.equal(labels.includes(wording),true,`the plain wording "${wording}" is missing`);
  assert.equal(source.includes('workshopMoneyLabels.issueAction'),true);
  assert.equal(source.includes('workshopMoneyLabels.prepareAction'),true);
  assert.equal(source.includes('workshopAmountText'),true);
});

test('The workshop tab is plain and the legacy section alias still resolves',()=>{
  assert.equal(workshopSection('Cargos y abonos'),'collections');
  assert.equal(workshopSection('Cobros'),'collections');
  const pipeline=read(PIPELINE);
  const stages=read('src/controladores/workshop-pipeline.ts');
  // The tab is named in plain words: "Cobros", never the old jargon.
  assert.match(stages,/\['collections','Cobros',/);
  // The legacy alias keeps resolving, but no screen shows the old jargon.
  assert.equal(stages.includes("'Cargos y abonos':'collections'"),true);
  assert.equal(pipeline.includes("'Cargos y abonos'"),false);
  assert.equal(pipeline.includes('Cobros de este trabajo'),true);
});

test('The rental default wording of the payments surface stays exactly as it was',()=>{
  const source=read(PAYMENTS);
  for(const rental of ['Cargo, recibo de caja y aplicación son hechos distintos.',
    "'Emitir cargo del alcance aprobado aún no facturado'","'Fecha del cargo'","'Vencimiento del cargo'",
    "'Cargo de este expediente'","'Cobros aplicados'","'Recibo original: '+money(p.amount)+'.'",
    "'Todavía no reduce un cargo de este trabajo.'","'Fecha de emisión':'Fecha del cargo'"])
    assert.equal(source.includes(rental),true,`the rental default lost "${rental}"`);
});

test('The workshop wording of the payments surface is plain and distinct from the rental one',()=>{
  const source=read(PAYMENTS);
  for(const workshop of ['Emitir importe a cobrar del alcance aprobado que falta facturar','Importe facturado al cliente',
    'El importe facturado al cliente, el cobro recibido y el cobro aplicado son hechos distintos.'])
    assert.equal(source.includes(workshop),true,`the workshop wording "${workshop}" is missing`);
  assert.equal(source.includes('Registrar importe a cobrar del alcance aprobado pendiente de emitir'),false);
  assert.equal(source.includes('Importe a cobrar · emitido'),false);
});

test('The workshop overview shows the agreed, invoiced, collected and pending amounts',()=>{
  const overview=summary();
  assert.equal(overview.agreed.label,'Importe acordado con el cliente');
  assert.equal(overview.agreed.value,1200);
  assert.equal(overview.agreed.available,true);
  assert.equal(overview.issued.value,1000);
  assert.equal(overview.collected.value,600);
  assert.equal(overview.pending.value,400);
  assert.equal(overview.advance.value,100);
  assert.equal(overview.notInvoiced.value,200);
});

test('An approved additional raises the agreed amount and the pending receivable',()=>{
  const before=summary({agreed:1000,charged:1000,paid:600,balance:400,unbilled:0});
  const after=summary({agreed:1400,charged:1000,paid:600,balance:400,unbilled:400});
  assert.equal(before.agreed.value,1000);
  assert.equal(after.agreed.value,1400);
  assert.equal(after.notInvoiced.value,400);
  assert.equal(after.additionalNote.includes('adicional'),true);
  assert.equal(after.additionalNote.includes('pendiente'),true);
  assert.equal(after.additionalNote.includes('paga'),true);
  assert.equal(after.pending.value,before.pending.value);
});

test('A missing approved estimate is not available, never a zero',()=>{
  const overview=summary({agreed:null,unbilled:0});
  assert.equal(overview.agreed.available,false);
  assert.equal(overview.agreed.value,null);
  assert.equal(workshopAmountText(overview.agreed,value=>`$${value}`),NOT_AVAILABLE);
  assert.equal(overview.notInvoiced.available,false);
  assert.equal(workshopAmountText(overview.notInvoiced,value=>`$${value}`),NOT_AVAILABLE);
  assert.notEqual(NOT_AVAILABLE,'$0.00');
});

test('An internal job shows an honest unavailable state instead of a zero',()=>{
  assert.equal(workshopMoneyLabels.internalNote.includes('Mantenimiento interno'),true);
  assert.equal(workshopMoneyLabels.internalNote.includes('No hay importe acordado, facturado ni pendiente'),true);
  assert.equal(read(COLLECTIONS).includes('workshopMoneyLabels.internalNote'),true);
});

test('No command, RPC or money helper changed',()=>{
  const source=read(COLLECTIONS);
  assert.equal(source.includes("execute('bill_scope'"),true);
  assert.equal(source.includes("orderId:job.id,date:String(form.get('date')),dueOn:String(form.get('dueOn'))"),true);
  assert.equal((source.match(/execute\(/g)??[]).length,1);
  assert.equal(source.includes('caseCommand('),false);
  assert.equal(source.includes('createSupabaseBrowserClient'),false);
  assert.equal(/^\s*import\s/m.test(read(LANGUAGE)),false,'the wording module must stay pure');
  const committed=execFileSync('git',['show',`HEAD:${OPERATION_MONEY}`],{encoding:'utf8'});
  const current=read(OPERATION_MONEY);
  assert.equal(current.replace(/\r\n/g,'\n'),committed.replace(/\r\n/g,'\n'),'the canonical money helper changed');
});

test('The collections card states the operation and the money together',()=>{
  const billing=billingModule();
  // A rental that is already closed and still owes money: both facts have to be visible.
  assert.equal(billing.rentalOperationLabel({status:'Confirmada',rental_state:'Cerrado'},true),'Finalizado');
  assert.equal(billing.rentalOperationLabel({status:'Confirmada',rental_state:'Entregado'},false),'Alquilado');
  assert.equal(billing.rentalOperationLabel({status:'Confirmada',rental_state:'Devuelto'},false),'Devuelto');
  assert.equal(billing.rentalOperationLabel({status:'Confirmada',rental_state:'Preparado'},false),'Reservado');
  assert.equal(billing.collectionMoneyState('Pendiente'),'Pendiente por cobrar');
  assert.equal(billing.collectionMoneyState('Por emitir'),'Pendiente de emitir el documento');
  assert.equal(billing.collectionMoneyState('Sin cargo'),'Sin importes emitidos');
  assert.equal(billing.collectionMoneyState('Sin saldo'),'Cobrado');
  // The workshop operation state is the state of the work itself.
  assert.equal(billing.workshopOperationLabel('Diagnóstico'),'Diagnóstico');
  assert.equal(billing.workshopOperationLabel('En proceso'),'En proceso');
  assert.equal(billing.workshopOperationLabel('Entregado'),'Entregado');
  // A finished rental that still owes money reads as both facts, never only one of them.
  assert.equal(billing.collectionStatusReading('Finalizado','Pendiente por cobrar'),'Finalizado · Pendiente por cobrar');
  const source=read(BILLING);
  assert.equal(source.includes('collectionStatusReading(operationLabel,moneyState)'),true);
  assert.equal(source.includes('<Badge tone={operationTone}>{operationLabel}</Badge>'),true);
  assert.equal(source.includes('<Badge tone={badgeTone}>{moneyState}</Badge>'),true);
});

test('The collections card leads with three amounts and keeps the rest inside the collapsed detail',()=>{
  const source=read(BILLING);
  // The five row canonical block stays available, but only inside the collapsed detail.
  assert.equal(source.includes('<dl className="collection-money"'),true);
  assert.equal(source.indexOf('<details className="collection-detail">')<source.indexOf('<dl className="operation-amounts">'),true);
  assert.equal(source.includes('className="collection-money"'),true);
  assert.equal(source.includes("agreedLabel=operation.internal&&!isRental?'Costo presupuestado':'Importe acordado'"),true);
  for(const label of ['<dt>Cobrado</dt>','<dt>Por cobrar</dt>'])
    assert.equal(source.includes(label),true,`the card does not show "${label}"`);
  assert.equal(source.includes('<details className="collection-detail"><summary>Detalle</summary>'),true);
  const detail=source.slice(source.indexOf('<details className="collection-detail">'));
  assert.equal(detail.includes('<dl className="operation-amounts">'),true,'the detail does not render the secondary figures');
  for(const label of ['Importes emitidos al cliente','Anticipos vinculados sin aplicar'])
    assert.equal(detail.includes(label),true,`the detail does not keep "${label}"`);
  // The internal costs are not repeated here: the folio is their only home.
  assert.equal(detail.includes('Costos del trabajo'),false,'the card repeats the internal costs of the folio');
  assert.equal(detail.includes('Ver costos en el folio →'),true,'the card does not link to the costs of the folio');
  // The warnings of the card stay available, but they no longer inflate the card.
  for(const warning of ['costos por revisar','saldo vencido','registrado como propio de AJ'])
    assert.equal(detail.includes(warning),true,`the detail lost the warning "${warning}"`);
});

test('The collections page drops the cargo wording and names the action plainly',()=>{
  const source=read(BILLING);
  for(const jargon of ['Crear cargo del presupuesto','Crear el cargo pendiente','Fecha del cargo','Confirmar cargo',
    'Ver cargos, abonos y gastos','Abonos aplicados','Abono aplicado','Reversión de abono','cargos emitidos',
    'Registrar abono'])
    assert.equal(source.includes(jargon),false,`the collections page still shows "${jargon}"`);
  assert.equal(source.includes('Emitir importe a cobrar'),true);
  assert.equal(source.includes('Registrar cobro'),true);
  assert.equal(source.includes("'Sin importes emitidos'"),true);
});

test('The shared money block of the rental folio was not modified',()=>{
  const shared=(source:string)=>source.replace(/\r\n/g,'\n').split('\n').filter(line=>line.includes('.operation-amounts')&&!line.includes('.collection-card'));
  const committed=execFileSync('git',['show',`HEAD:${STYLES}`],{encoding:'utf8'});
  assert.deepEqual(shared(read(STYLES)),shared(committed),'the shared .operation-amounts rules changed');
  // The folio markup of the rental money block is the same one it always was.
  assert.equal(read('src/components/organisms/rental-operation.tsx').includes('className="operation-amounts rental-money"'),true);
});

test('The collections card keeps every action and its permission',()=>{
  const source=read(BILLING);
  for(const fragment of ["can('expenses.write')&&operation.kind==='Taller'&&!operation.internal&&!inconsistentWorkshop&&!!amount?.unbilled",
    "can('expenses.write')&&!operation.internal&&(!inconsistentWorkshop||payable.length>0)&&operation.customerId",
    "open('gasto',operation.id)","onClick={()=>setReceiptOpen(true)}","href={quoteHref}","href={href}",
    "orderHref(operation.id)","rentalHref(operation.id)",
    "execute('bill_scope',payload,key=>caseCommand('bill_scope',payload,key))"])
    assert.equal(source.includes(fragment),true,`the card lost "${fragment}"`);
  // One compact action row with at most one primary action.
  const start=source.indexOf('<div className="collection-actions">');
  const actions=source.slice(start,source.indexOf('{form&&',start));
  assert.equal((actions.match(/<Button(?![^>]*variant)/g)??[]).length,1,'more than one primary action');
  // The card never competes with itself: only the issuing action is primary.
  assert.equal(actions.includes("variant={canIssue?'ghost':'default'}"),false);
  assert.equal(actions.includes('<Button variant="outline" size="sm" onClick={()=>setReceiptOpen(true)}'),true);
  assert.equal((actions.match(/<Button/g)??[]).length+(actions.match(/<Link/g)??[]).length,6);
});

