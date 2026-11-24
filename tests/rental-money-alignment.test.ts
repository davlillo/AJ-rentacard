import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {rentalAccounts,rentalMoneyEvidence} from '../src/controladores/rental-lifecycle';
import {operationMoney} from '../src/controladores/operation-money';
import {dossierMoney,dossierRentalScope} from '../src/controladores/vehicle-dossier';
import type {CaseFile} from '../src/lib/supabase/cases';
import type {Reservation} from '../src/lib/supabase/reservations';

const read=(path:string)=>readFileSync(path,'utf8');
// The money rows of one operation card on the /cobros page.
const moneyRows=(source:string)=>{
  const start=source.indexOf('<dl className="operation-amounts">');
  const end=source.indexOf('</dl>',start);
  return source.slice(start,end);
};
const FOLIO='src/components/organisms/rental-operation.tsx';
const BILLING='src/components/templates/operational-billing.tsx';
const DOSSIER='src/components/templates/vehicle-dossier.tsx';
const SHARED='src/controladores/operation-money.ts';

const booking={id:'rental',version:1,status:'Confirmada',rental_state:'Entregado',
  starts_at:'2026-11-01T12:00:00-06:00',ends_at:'2026-11-03T12:00:00-06:00',
  daily_rate:40,total:80,customer_snapshot:{name:'Cliente de prueba'},
  vehicle_snapshot:{}} as unknown as Reservation;

function caseFile(overrides:Partial<CaseFile>={}){
  return{vehicle:{id:'car'} as CaseFile['vehicle'],financialAccess:true,orders:[],reservations:[booking],
    commitments:[],inspections:[],files:[],documents:[],applications:[],expenses:[],payments:[],advances:[],
    quotes:[],costs:[],...overrides} as unknown as CaseFile;
}
// A document of the rental scope: what was issued to the customer and what is still on it.
function issued(amount:number,balance:number){
  return[{id:'doc',description:'Alquiler',amount,scope_amount:amount,scope_balance:balance,
    issued_on:'2026-11-02',due_on:'2026-11-05'}];
}
function applied(amount:number){
  return[{id:'app',payment_id:'pay',document_id:'doc',kind:'Aplicacion',amount,scope_amount:amount,
    effective_on:'2026-11-03',reason:'Cobro parcial',created_by:'user'}];
}

test('the rental folio money block never says that nothing is owed when an amount was agreed',()=>{
  const source=read(FOLIO);
  assert.equal(source.includes('Sin cargo emitido'),false,'the folio still says "Sin cargo emitido"');
  assert.equal(source.includes('Cargos de este alquiler'),false);
  assert.equal(source.includes('Por cobrar de este alquiler'),false);
  // The block reads the canonical model instead of a second derivation.
  assert.equal(source.includes('rentalMoneyEvidence('),true);
  assert.equal(source.includes('rentalAccounts('),true);
  assert.equal(source.includes('Lo acordado'),true);
  assert.equal(source.includes('Lo pendiente'),true);
  assert.equal(source.includes('rentalPendingSentence('),true);
});

test('the /cobros rental row shows the canonical pending amount and plain captions',()=>{
  const source=read(BILLING);
  assert.equal(source.includes('Según cargo del alquiler'),false,'the rental row still points to the charge of the rental');
  assert.equal(source.includes('Saldo de los cargos emitidos'),false);
  // A rental row never borrows the workshop money and never derives its own pending amount.
  assert.equal(source.includes('rentalAccounts('),true);
  assert.equal(source.includes('rentalMoneyEvidence('),true);
  // Only the row of the operation card is renamed; the workshop breakdown keeps its own wording.
  const rows=moneyRows(source);
  assert.equal(rows.includes('Cargos emitidos'),false);
  assert.equal(rows.includes('Abonos aplicados'),false);
  assert.equal(rows.includes('Importe acordado'),true);
  assert.equal(rows.includes('Importes emitidos al cliente'),true);
  assert.equal(rows.includes('Cobros aplicados'),true);
  assert.equal(rows.includes('Saldo pendiente'),true);
});

test('the dossier amounts of a rental scope show the agreed and the pending amount in plain words',()=>{
  const source=read(DOSSIER);
  assert.equal(source.includes('Cargos emitidos'),false,'the dossier still labels the issued amounts as charges');
  assert.equal(source.includes('Abonos aplicados'),false);
  assert.equal(source.includes('Saldo por cobrar'),false);
  assert.equal(source.includes('Sin cargos, aplicaciones ni egresos vinculados'),false);
  assert.equal(source.includes('dossierRentalScope('),true);
  assert.equal(source.includes('Lo acordado'),true);
  assert.equal(source.includes('Lo pendiente'),true);
  assert.equal(source.includes('Egresos vinculados'),true);
});

test('an agreed eighty with nothing issued and nothing collected is pending eighty everywhere',()=>{
  const file=caseFile();
  const accounts=rentalAccounts(rentalMoneyEvidence(file,booking,null));
  assert.equal(accounts?.agreed,80);
  assert.equal(accounts?.charged,0);
  assert.equal(accounts?.paid,0);
  // The operator must never be told that nothing is owed.
  assert.equal(accounts?.pending,80);
  assert.equal(accounts?.pendingIssued,0);
  assert.equal(accounts?.pendingToEmit,80);
  // The same amount reaches the dossier of that rental scope.
  assert.deepEqual(dossierRentalScope(file,booking,true),{agreed:80,pending:80});
  // And the folio block and the /cobros row read that pending amount.
  assert.equal(read(FOLIO).includes('accounts?.pending??0'),true);
  assert.equal(read(BILLING).includes('money(accounts.pending)'),true);
});

test('an issued eighty with fifty collected leaves thirty pending',()=>{
  const file=caseFile({documents:issued(80,30),applications:applied(50)});
  const accounts=rentalAccounts(rentalMoneyEvidence(file,booking,null));
  assert.equal(accounts?.charged,80);
  assert.equal(accounts?.paid,50);
  assert.equal(accounts?.balance,30);
  assert.equal(accounts?.pending,30);
  assert.equal(accounts?.pendingIssued,30);
  assert.equal(accounts?.pendingToEmit,0);
  assert.deepEqual(dossierRentalScope(file,booking,true),{agreed:80,pending:30});
});

test('an open ended rental takes the pending only from the issued documents',()=>{
  const open={...booking,open_ended:true,ends_at:'infinity',total:0} as unknown as Reservation;
  const bare=caseFile({reservations:[open]});
  const accounts=rentalAccounts(rentalMoneyEvidence(bare,open,null));
  assert.equal(accounts?.agreed,null);
  assert.equal(accounts?.pending,0);
  assert.equal(accounts?.pendingToEmit,0);
  const issuedFile=caseFile({reservations:[open],documents:issued(80,80)});
  const withDocument=rentalAccounts(rentalMoneyEvidence(issuedFile,open,null));
  assert.equal(withDocument?.pending,80);
  assert.equal(withDocument?.pendingIssued,80);
  assert.equal(withDocument?.pendingToEmit,0);
  assert.deepEqual(dossierRentalScope(issuedFile,open,true),{agreed:null,pending:80});
});

test('the workshop rows keep the approved scope and the unbilled difference with plain labels',()=>{
  const workshop={vehicle:{id:'car'},financialAccess:true,orders:[{id:'OT-1',active_estimate_id:'approved'}],
    quotes:[{id:'approved',order_id:'OT-1',revision:1,status:'Aprobado',snapshot:{total:1856}},
      {id:'draft',order_id:'OT-1',revision:2,status:'Borrador',snapshot:{total:2190}}],
    documents:[],applications:[],expenses:[],costs:[],payments:[],advances:[]} as unknown as CaseFile;
  const summary=operationMoney(workshop,'OT-1');
  // The workshop semantics are untouched: approved scope, unbilled difference, issued documents, balance.
  assert.equal(summary.quoted,2190);
  assert.equal(summary.unbilled,1856);
  assert.equal(summary.state,'Por emitir');
  const billed=operationMoney({...workshop,documents:[{scope_amount:2190,scope_balance:1490}]} as unknown as CaseFile,'OT-1');
  assert.equal(billed.charged,2190);
  assert.equal(billed.balance,1490);
  assert.equal(billed.unbilled,0);
  assert.equal(billed.state,'Pendiente');
  // Only the wording of the shared captions changed.
  const source=read(BILLING);
  assert.equal(source.includes('Hay presupuesto aprobado por emitir'),true);
  assert.equal(source.includes('Presupuesto pendiente de aprobar'),true);
  assert.equal(source.includes('Saldo pendiente'),true);
  assert.equal(source.includes('Sin cargo'),true,'the workshop keeps its own empty wording');
});

test('the shared money helper was not touched by the rental alignment',()=>{
  const committed=execFileSync('git',['show',`HEAD:${SHARED}`],{encoding:'utf8'});
  assert.equal(read(SHARED).replace(/\r\n/g,'\n'),committed.replace(/\r\n/g,'\n'),
    'the shared money helper changed; the workshop semantics must stay as they were');
});

test('no protected amount is rendered without financial access',()=>{
  const blind=caseFile({financialAccess:false});
  assert.equal(rentalMoneyEvidence(blind,booking,null),null);
  assert.equal(dossierRentalScope(blind,booking,true),null);
  assert.equal(dossierMoney(blind,true),null);
  assert.equal(dossierMoney(caseFile(),false),null);
  // Every surface that shows money keeps the permission and the case access gate.
  assert.equal(read(FOLIO).includes("file.financialAccess&&can('expenses.read')"),true);
  assert.equal(read(DOSSIER).includes("can('expenses.read')&&file.financialAccess"),true);
});
