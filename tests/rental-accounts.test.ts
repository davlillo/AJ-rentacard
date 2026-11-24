import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rentalAccounts,rentalAccountsAdvice,rentalLifecycle,rentalMoneyEvidence,rentalPendingSentence,type RentalMoneyEvidence} from '../src/controladores/rental-lifecycle';
import {rentalSection,rentalSections,rentalWorkflow} from '../src/controladores/rental-workflow';
import {operationMoney} from '../src/controladores/operation-money';
import type {CaseFile} from '../src/lib/supabase/cases';
import type {Reservation} from '../src/lib/supabase/reservations';

const booking={id:'rental',version:4,status:'Confirmada',rental_state:'Cerrado',
  starts_at:'2026-11-01T12:00:00-06:00',ends_at:'2026-11-08T12:00:00-06:00',
  actual_departure_at:'2026-11-02T12:00:00-06:00',actual_return_at:'2026-11-05T12:00:00-06:00',
  daily_rate:50,total:350} as Reservation;
const document={id:'doc',description:'Alquiler',amount:100,scope_amount:100,scope_balance:60,
  issued_on:'2026-11-02',due_on:'2026-11-05'};
const grouped={id:'group',description:'Alquiler agrupado',amount:900,scope_amount:20,scope_balance:20,
  issued_on:'2026-11-02',due_on:'2026-11-05',grouped:true};
const application={id:'app',payment_id:'pay',document_id:'doc',kind:'Aplicacion',amount:40,scope_amount:40,
  effective_on:'2026-11-03',reason:'Cobro parcial'};

function caseFile(overrides:Partial<CaseFile>={}){
  return{vehicle:{id:'car'} as CaseFile['vehicle'],financialAccess:true,orders:[],reservations:[booking],
    commitments:[],inspections:[],files:[],documents:[document,grouped],applications:[application],
    expenses:[],payments:[],advances:[],...overrides} as unknown as CaseFile;
}
function evidence(overrides:Partial<RentalMoneyEvidence>={}):RentalMoneyEvidence{
  return{charged:120,balance:80,paid:40,advances:0,agreed:350,estimate:150,...overrides};
}
function stage(progress:ReturnType<typeof rentalLifecycle>,label:string){
  return progress.stages.find(stage=>stage.label===label);
}

test('the Cuentas checkpoint completes only from persisted money evidence',()=>{
  const flow=rentalWorkflow(booking,[]);
  const unpaid=rentalLifecycle(booking,flow,evidence());
  assert.equal(unpaid.current,3);
  assert.equal(stage(unpaid,'Cuentas')?.complete,false);
  assert.equal(stage(unpaid,'Cuentas')?.current,true);
  assert.equal(stage(unpaid,'Finalizado')?.current,false);
  assert.equal(stage(unpaid,'Finalizado')?.complete,false);
  const settled=rentalLifecycle(booking,flow,evidence({charged:350,balance:0,paid:350}));
  assert.equal(settled.current,4);
  assert.equal(stage(settled,'Cuentas')?.complete,true);
  assert.equal(stage(settled,'Cuentas')?.current,false);
  assert.equal(stage(settled,'Finalizado')?.current,true);
  assert.equal(stage(settled,'Finalizado')?.current,true);
  const blind=rentalLifecycle(booking,flow);
  assert.equal(blind.current,3);
  assert.equal(stage(blind,'Cuentas')?.complete,false);
  assert.equal(stage(blind,'Finalizado')?.current,false);
});

test('the money decides only the last stage of the flow',()=>{
  const flow=rentalWorkflow(booking,[]);
  // An amount still outstanding keeps the rental in Cuentas.
  assert.equal(rentalLifecycle(booking,flow,evidence()).current,3);
  // Without money evidence the settlement cannot be asserted either.
  assert.equal(rentalLifecycle(booking,flow,null).current,3);
  // Nothing agreed and nothing issued means nothing pending: then the rental can be finished.
  assert.equal(rentalLifecycle(booking,flow,evidence({charged:0,balance:0,paid:0,agreed:null})).current,4);
  const active={...booking,rental_state:'Entregado'} as Reservation;
  assert.equal(rentalLifecycle(active,rentalWorkflow(active,[]),evidence({charged:0,balance:0,paid:0})).current,2);
});

test('an issued unpaid document is a receivable and a settled one is not',()=>{
  const pending=rentalAccounts(evidence());
  assert.equal(pending?.issued,true);
  assert.equal(pending?.settled,false);
  assert.equal(pending?.balance,80);
  assert.match(rentalAccountsAdvice(pending),/Pendiente por cobrar: \$310\.00/);
  const paid=rentalAccounts(evidence({balance:0,paid:120}));
  assert.equal(paid?.settled,true);
  assert.match(rentalAccountsAdvice(paid),/Pendiente de emitir el documento de cobro: \$230\.00/);
});

test('an agreed amount that was never issued is the pending to issue, not nothing owed',()=>{
  const nothing=rentalAccounts(evidence({charged:0,balance:0,paid:0}));
  assert.equal(nothing?.issued,false);
  assert.equal(nothing?.settled,false);
  assert.equal(nothing?.balance,0);
  assert.equal(nothing?.unissued,350);
  // The operator must see what the customer still owes, even before the document exists.
  assert.equal(nothing?.pending,350);
  assert.equal(nothing?.pendingIssued,0);
  assert.equal(nothing?.pendingToEmit,350);
  const advice=rentalAccountsAdvice(nothing);
  assert.match(advice,/Pendiente por cobrar: \$350\.00/);
  assert.match(advice,/Pendiente de emitir el documento de cobro: \$350\.00/);
  assert.doesNotMatch(advice,/Sin saldo pendiente/);
  assert.doesNotMatch(advice,/cuenta por cobrar/i);
});

test('the agreed eighty with nothing issued and nothing collected is pending to issue',()=>{
  const accounts=rentalAccounts(evidence({charged:0,balance:0,paid:0,agreed:80,estimate:null}));
  assert.equal(accounts?.pending,80);
  assert.equal(accounts?.pendingToEmit,80);
  const sentence=rentalPendingSentence(accounts!);
  assert.match(sentence,/Pendiente de emitir el documento de cobro: \$80\.00/);
  assert.doesNotMatch(sentence,/Sin saldo pendiente/);
  assert.doesNotMatch(sentence,/cargo/i);
});

test('the pending amount is tied to the document that was already issued',()=>{
  const accounts=rentalAccounts(evidence({charged:80,balance:30,paid:50,agreed:80,estimate:null}));
  assert.equal(accounts?.pending,30);
  assert.equal(accounts?.pendingIssued,30);
  assert.equal(accounts?.pendingToEmit,0);
  const sentence=rentalPendingSentence(accounts!);
  assert.match(sentence,/Pendiente del documento emitido: \$30\.00/);
  assert.doesNotMatch(sentence,/Sin saldo pendiente/);
});

test('an applied advance reduces the pending amount and an unapplied one does not',()=>{
  const unapplied=rentalAccounts(evidence({charged:80,balance:80,paid:0,advances:50,agreed:80,estimate:null}));
  assert.equal(unapplied?.pending,80);
  assert.equal(unapplied?.advances,50);
  assert.equal(unapplied?.paid,0);
  const applied=rentalAccounts(evidence({charged:80,balance:30,paid:50,advances:0,agreed:80,estimate:null}));
  assert.equal(applied?.pending,30);
  // The unapplied advance is money already received, never money that lowers the debt.
  assert.equal(rentalAccounts(evidence({charged:0,balance:0,paid:0,advances:50,agreed:80,estimate:null}))?.pending,80);
});

test('an open ended rental takes the pending only from the issued documents',()=>{
  const open={...booking,open_ended:true,ends_at:'infinity',total:0} as Reservation;
  const scoped=rentalMoneyEvidence(caseFile({reservations:[open],documents:[],applications:[]}),open,150);
  assert.equal(scoped?.agreed,null);
  assert.equal(scoped?.charged,0);
  const accounts=rentalAccounts(scoped);
  assert.equal(accounts?.unissued,0);
  assert.equal(accounts?.settled,false);
  assert.equal(accounts?.pending,0);
  assert.match(rentalAccountsAdvice(accounts),/Este alquiler no tiene un total acordado/);
  // With an issued document the pending is the balance of that document and nothing else.
  const issued=rentalAccounts(rentalMoneyEvidence(caseFile({reservations:[open]}),open,150));
  assert.equal(issued?.pending,80);
  assert.equal(issued?.pendingToEmit,0);
});

test('an accrued forecast never becomes a receivable',()=>{
  const forecast=rentalAccounts(evidence({charged:0,balance:0,paid:0,estimate:150}));
  assert.equal(forecast?.estimate,150);
  assert.equal(forecast?.balance,0);
  assert.equal(forecast?.settled,false);
  // The forecast is not money: it never adds to the pending amount.
  assert.equal(forecast?.pending,350);
  assert.doesNotMatch(rentalPendingSentence(forecast!),/150/);
  assert.doesNotMatch(rentalAccountsAdvice(forecast),/cuenta por cobrar/i);
});

test('an advance already received is not new income and does not settle a balance',()=>{
  const withAdvance=rentalAccounts(evidence({advances:10}));
  assert.equal(withAdvance?.advances,10);
  assert.equal(withAdvance?.paid,40);
  assert.equal(withAdvance?.settled,false);
  assert.match(rentalAccountsAdvice(withAdvance),/Pendiente por cobrar: \$310\.00/);
});

test('a grouped document keeps the rental share and never the group total',()=>{
  const totals=operationMoney(caseFile());
  assert.equal(totals.charged,120);
  assert.equal(totals.balance,80);
  const scoped=rentalMoneyEvidence(caseFile(),booking,150);
  assert.equal(scoped?.charged,120);
  assert.equal(scoped?.balance,80);
  assert.equal(scoped?.agreed,350);
});

test('money evidence requires the current financial access',()=>{
  assert.equal(rentalMoneyEvidence(caseFile({financialAccess:false}),booking,150),null);
  assert.equal(rentalMoneyEvidence(caseFile(),booking,150)?.charged,120);
});

test('a canceled folio completes no stage at all',()=>{
  const canceled={...booking,status:'Cancelada'} as Reservation;
  const progress=rentalLifecycle(canceled,rentalWorkflow(canceled,[]),evidence({charged:120,balance:0,paid:120}));
  assert.equal(progress.current,null);
  assert.equal(progress.currentIndex,null);
  assert.equal(progress.stages.some(stage=>stage.complete),false);
});

test('reading the accounts never issues money nor changes the folio',()=>{
  const file=caseFile();
  const snapshot=JSON.stringify(file);
  const flow=rentalWorkflow(booking,[]);
  for(let attempt=0;attempt<3;attempt+=1){
    const scoped=rentalMoneyEvidence(file,booking,150);
    rentalLifecycle(booking,flow,scoped);
    rentalAccounts(scoped);
  }
  assert.equal(JSON.stringify(file),snapshot);
  assert.equal(file.documents?.length,2);
  assert.equal(rentalSections.includes('Cuentas'),true);
});

test('the Cuentas section is visible and legacy section aliases keep working',()=>{
  assert.equal(rentalSection('Cuentas'),'Cuentas');
  assert.equal(rentalSection('Cuentas y cobros'),'Cuentas');
  assert.equal(rentalSection('Períodos y abonos'),'Cargos y abonos');
  assert.equal(rentalSection('Cargos y abonos'),'Cargos y abonos');
  assert.equal(rentalSection('Limpieza'),'Limpieza');
  assert.equal(rentalSection('Gastos'),'Gastos');
  assert.equal(rentalSection('Contrato'),'Contrato');
  assert.equal(rentalSection('arbitrary'),'Resumen');
  for(const section of ['Resumen','Salida y devolución','Cargos y abonos','Limpieza','Gastos','Fotos y documentos','Contrato'])
    assert.equal(rentalSections.includes(section as never),true);
});

test('the issuing action of Cuentas opens a modal instead of expanding a form inline',()=>{
  const source=readFileSync('src/components/organisms/rental-accounts.tsx','utf8');
  // The inline expansion of the period form is gone from the Cuentas section.
  assert.doesNotMatch(source,/<RentalPeriods/);
  assert.doesNotMatch(source,/aria-expanded/);
  // The action opens the issuing modal with the facts the section already shows.
  assert.match(source,/<Dialog open=\{issuing\} onOpenChange=\{setIssuing\}>/);
  assert.match(source,/<DialogTrigger asChild><Button>Emitir importe a cobrar<\/Button><\/DialogTrigger>/);
  assert.match(source,/<RentalIssueModal open=\{issuing\} booking=\{booking\} vehicle=\{file\.vehicle\}/);
  assert.match(source,/agreed=\{accounts\?accounts\.agreed:null\}/);
  assert.match(source,/pending=\{pending\}/);
  assert.match(source,/pendingToEmit=\{accounts\?accounts\.pendingToEmit:0\}/);
  // The period form keeps its other use: the extension action of Resumen.
  const periods=readFileSync('src/components/organisms/rental-periods.tsx','utf8');
  assert.match(periods,/export function RentalPeriods\(/);
  assert.match(periods,/export function RentalIssueModal\(/);
});
