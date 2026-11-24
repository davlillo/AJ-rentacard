// The reconciliation alarm: one read-only warning that tells the operator when a folio issued
// less (or more) than what was agreed. It never blocks: no button, no command and no permission
// changes because of it, and it never invents an amount.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {rentalAccounts,rentalMoneyEvidence,rentalReconciliationAlarm,reconciliationAlarm} from '../src/controladores/rental-lifecycle';
import {workshopCollections,workshopReconciliationAlarm} from '../src/controladores/workshop-collections';
import type {CaseFile} from '../src/lib/supabase/cases';
import type {Reservation} from '../src/lib/supabase/reservations';

const read=(path:string)=>readFileSync(path,'utf8');
const BILLING='src/components/templates/operational-billing.tsx';
const RENTAL_ACCOUNTS='src/components/organisms/rental-accounts.tsx';
const WORKSHOP_COLLECTIONS='src/components/organisms/workshop-collections.tsx';
const ISSUE_MODAL='src/controladores/rental-issue-modal.ts';

const booking={id:'rental',version:4,status:'Confirmada',rental_state:'Cerrado',
  starts_at:'2026-11-01T12:00:00-06:00',ends_at:'2026-11-08T12:00:00-06:00',
  daily_rate:50,total:150,open_ended:false} as unknown as Reservation;

// A rental folio with one document of the period: the agreed total and what was issued.
function rentalFile(overrides:Partial<CaseFile>={},issued:number|null=100){
  const document={id:'doc',description:'Alquiler',amount:issued,scope_amount:issued,scope_balance:issued,
    issued_on:'2026-11-02',due_on:'2026-11-08',source_key:null};
  return{vehicle:{id:'car'} as CaseFile['vehicle'],financialAccess:true,orders:[],reservations:[booking],
    commitments:[],inspections:[],files:[],documents:issued===null?[]:[document],applications:[],expenses:[],
    payments:[],advances:[],quotes:[],costs:[],...overrides} as unknown as CaseFile;
}
function rentalAlarm(file:CaseFile,record:Reservation=booking){
  return rentalReconciliationAlarm(rentalAccounts(rentalMoneyEvidence(file,record,null)));
}

// A workshop job with an approved quote of 150 and one document of 100.
function workshopFile(overrides:Partial<CaseFile>={},issued:number|null=100,total=150){
  return{vehicle:{id:'car'} as CaseFile['vehicle'],financialAccess:true,
    orders:[{id:'job',active_estimate_id:'approved'}],
    quotes:[{id:'approved',order_id:'job',revision:1,status:'Aprobado',snapshot:{total}}],
    documents:issued===null?[]:[{id:'doc',amount:issued,scope_amount:issued,scope_balance:issued}],
    applications:[],expenses:[],costs:[],payments:[],advances:[],...overrides} as unknown as CaseFile;
}

test('the alarm states the difference of a rental with plain words and the exact numbers',()=>{
  const alarm=rentalAlarm(rentalFile({},100));
  assert.equal(alarm?.agreed,150);
  assert.equal(alarm?.issued,100);
  assert.equal(alarm?.difference,50);
  assert.equal(alarm?.text,'Facturado $100.00 de $150.00 acordados · faltan $50.00 por emitir.');
  // The alarm states the same fact as the amount that is left to issue.
  const accounts=rentalAccounts(rentalMoneyEvidence(rentalFile({},100),booking,null));
  assert.equal(alarm?.difference,accounts?.pendingToEmit);
  assert.equal(alarm?.difference,50);
});

test('the alarm of a rental that issued more than what was agreed asks for a review',()=>{
  const alarm=rentalAlarm(rentalFile({},180));
  assert.equal(alarm?.difference,-30);
  assert.equal(alarm?.text,'Facturado $180.00 de $150.00 acordados · hay $30.00 de diferencia por revisar.');
  // It never calls the difference a loss, a margin or a fiscal document.
  assert.doesNotMatch(alarm?.text??'',/p[eé]rdida|margen|facturaci[oó]n|factura fiscal|\bcargo\b|\babono\b/i);
});

test('a rental without an issued document says that nothing was issued yet',()=>{
  const alarm=rentalAlarm(rentalFile({},null));
  assert.equal(alarm?.text,'Todavía no se emitió ningún importe: de $150.00 acordados · faltan $150.00 por emitir.');
  // No zero is invented as an amount that was issued.
  assert.doesNotMatch(alarm?.text??'',/\$0\.00/);
});

test('without an agreed amount there is no alarm at all',()=>{
  // An open ended rental has no agreed total to compare.
  const open={...booking,open_ended:true,ends_at:'infinity',total:0} as unknown as Reservation;
  assert.equal(rentalAlarm(rentalFile({reservations:[open]},100),open),null);
  // A rental without money evidence has no numbers to compare either.
  assert.equal(rentalAlarm(rentalFile({financialAccess:false},100)),null);
  // A workshop job without an approved quote has no agreed amount.
  assert.equal(workshopReconciliationAlarm(workshopCollections(workshopFile({quotes:[]},100),'job')),null);
  // A draft quote is not an agreement.
  const draft=workshopFile({},100);
  draft.quotes=[{id:'draft',order_id:'job',revision:1,status:'Borrador',snapshot:{total:150}}] as never;
  draft.orders=[{id:'job',active_estimate_id:null}] as never;
  assert.equal(workshopReconciliationAlarm(workshopCollections(draft,'job')),null);
  // An internal job has no customer amount to compare.
  assert.equal(workshopReconciliationAlarm(workshopCollections(workshopFile({quotes:[]},100),'job')),null);
});

test('an issued amount that equals the agreed amount raises no alarm',()=>{
  assert.equal(rentalAlarm(rentalFile({},150)),null);
  const workshop=workshopFile({},150);
  assert.equal(workshopReconciliationAlarm(workshopCollections(workshop,'job')),null);
  // The generic builder refuses to invent a comparison without an agreed amount.
  assert.equal(reconciliationAlarm(null,100),null);
  assert.equal(reconciliationAlarm(150,null),null);
  assert.equal(reconciliationAlarm(150,150),null);
});

test('the workshop alarm uses the approved scope against the issued documents',()=>{
  const summary=workshopCollections(workshopFile({},100),'job');
  const alarm=workshopReconciliationAlarm(summary);
  assert.equal(alarm?.text,'Facturado $100.00 de $150.00 acordados · faltan $50.00 por emitir.');
  // The difference is the same fact as the approved difference that is still to be issued.
  assert.equal(alarm?.difference,summary.unbilled);
  const over=workshopReconciliationAlarm(workshopCollections(workshopFile({},180),'job'));
  assert.equal(over?.text,'Facturado $180.00 de $150.00 acordados · hay $30.00 de diferencia por revisar.');
});

test('an empty database raises no alarm and no invented zero',()=>{
  const empty={vehicle:{id:'car'},financialAccess:true,orders:[],quotes:[],documents:[],applications:[],
    expenses:[],costs:[],payments:[],advances:[]} as unknown as CaseFile;
  assert.equal(workshopReconciliationAlarm(workshopCollections(empty,'job')),null);
  assert.equal(workshopReconciliationAlarm({agreed:null,charged:0}),null);
  assert.equal(reconciliationAlarm(null,0),null);
  // The page shows its empty state instead of a card with an amount.
  assert.match(read(BILLING),/No hay operaciones en esta vista/);
});

test('the alarm never disables a button and never changes a command or a payload',()=>{
  for(const [name,source] of [['the collections card',read(BILLING)],
    ['the rental accounts',read(RENTAL_ACCOUNTS)],['the workshop collections',read(WORKSHOP_COLLECTIONS)]] as const){
    // No disabled state depends on the alarm.
    for(const disabled of source.match(/disabled=\{[^}]*\}/g)??[])assert.equal(disabled.includes('alarm'),false,name);
    // The alarm is a plain line: it never carries an action of its own.
    assert.equal(/onClick[^>]*alarm/.test(source),false,name);
  }
  // The emission of the card keeps its command and its payload.
  const billing=read(BILLING);
  assert.match(billing,/const payload=\{orderId:operation\.id,date:String\(f\.get\('date'\)\),dueOn:String\(f\.get\('dueOn'\)\)\};/);
  assert.match(billing,/execute\('bill_scope',payload,key=>caseCommand\('bill_scope',payload,key\)\)/);
  // The permissions of the actions are untouched by the alarm.
  assert.match(billing,/const canIssue=can\('expenses\.write'\)&&operation\.kind==='Taller'&&!operation\.internal&&!inconsistentWorkshop&&!!amount\?\.unbilled;/);
  const accounts=read(RENTAL_ACCOUNTS);
  assert.match(accounts,/const canIssue=allowed&&booking\.status==='Confirmada'&&can\('orders\.write'\)&&can\('expenses\.write'\);/);
  assert.match(accounts,/agreed=\{accounts\?accounts\.agreed:null\}\s+pending=\{pending\}\s+pendingToEmit=\{accounts\?accounts\.pendingToEmit:0\}/);
  // The modal of the emission keeps its canonical body: it was never touched by the alarm.
  const modal=execFileSync('git',['diff','--',ISSUE_MODAL],{encoding:'utf8'});
  assert.equal(modal.trim(),'','the emission modal was changed');
});

test('the workshop card and the rental section state the same fact once',()=>{
  // The workshop section replaces its own line about the agreed difference with the alarm.
  const workshop=read(WORKSHOP_COLLECTIONS);
  assert.match(workshop,/\{alarm\?<p className=\{styles\.alarm\}/);
  assert.match(workshop,/!overview\.notInvoiced\.available&&<p className=\{styles\.agreement\}/);
  // The rental section explains the pending that belongs to an issued document, and lets the
  // alarm state the difference that is still to be issued, only once.
  const accounts=read(RENTAL_ACCOUNTS);
  assert.match(accounts,/alarm\?rentalIssuedPendingSentence\(accounts\):rentalPendingSentence\(accounts\)/);
  // The prose that repeated the difference in another sentence is gone from the section.
  assert.equal(accounts.includes('Pendiente de emitir el documento de cobro'),false);
  // The section shows the alarm once, next to the agreed and the pending figures.
  assert.equal((accounts.match(/data-testid="reconciliation-alarm"/g)??[]).length,1);
  assert.equal((workshop.match(/data-testid="reconciliation-alarm"/g)??[]).length,1);
  assert.equal((read(BILLING).match(/data-testid="reconciliation-alarm"/g)??[]).length,1);
});

test('the alarm is informative: it is never an error state and it never blocks the flow',()=>{
  for(const [name,source] of [['the collections card',read(BILLING)],
    ['the rental accounts',read(RENTAL_ACCOUNTS)],['the workshop collections',read(WORKSHOP_COLLECTIONS)]] as const){
    // No toast, no alert and no confirmation interrupts the operator.
    assert.equal(/role="alert"[^>]*alarm/.test(source),false,name);
    assert.equal(/toast\([^)]*alarm/.test(source),false,name);
    // The warning is not painted as a failure.
    assert.equal(/form-error[^>]*alarm/.test(source),false,name);
  }
});
