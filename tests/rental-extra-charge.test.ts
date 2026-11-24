import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Module from 'node:module';
import {rentalAccounts,rentalMoneyEvidence} from '../src/controladores/rental-lifecycle';
import {rentalIssuePeriod,rentalIssuePrefill,rentalPeriodCharge,type RentalPeriodDocument} from '../src/controladores/rental-issue-modal';
import type {CaseFile} from '../src/lib/supabase/cases';
import type {RentalExtra,Reservation} from '../src/lib/supabase/reservations';

// The components of the app import CSS modules; the node runner only needs the markup.
const extensions=(Module as unknown as {_extensions:Record<string,unknown>})._extensions;
extensions['.css']=(module:{exports:unknown})=>{module.exports=new Proxy({},{get:()=>undefined});};
const {rentalExtraCanIssue,rentalExtraState}=require('../src/components/organisms/rental-inspection') as
  {rentalExtraState:(extra:RentalExtra)=>string;rentalExtraCanIssue:(extra:RentalExtra)=>boolean};

const booking={id:'rental-extra',version:4,status:'Confirmada',rental_state:'Devuelto',
  starts_at:'2026-11-01T12:00:00-06:00',ends_at:'2026-11-08T12:00:00-06:00',
  daily_rate:50,total:350} as Reservation;
const periodDocument={id:'doc-period',description:'Alquiler',amount:120,scope_amount:120,scope_balance:120,
  issued_on:'2026-11-02',due_on:'2026-11-08',source_key:null};
const extraDocument={id:'doc-extra',description:'Extra de inspección',amount:25,scope_amount:25,scope_balance:25,
  issued_on:'2026-11-10',due_on:'2026-11-24',source_key:'rental-extra:proposal-1'};
const documents=[periodDocument,extraDocument] as unknown as (CaseFile['documents']&{source_key?:string|null})[];

function caseFile(overrides:Partial<CaseFile>={}){
  return{vehicle:{id:'car'} as CaseFile['vehicle'],financialAccess:true,orders:[],reservations:[booking],
    commitments:[],inspections:[],files:[],documents,applications:[],expenses:[],payments:[],advances:[],
    ...overrides} as unknown as CaseFile;
}
function extra(overrides:Partial<RentalExtra>={}):RentalExtra{
  return{id:'proposal-1',reservation_id:'rental-extra',description:'Diferencias de condición',amount:25,
    status:'Aprobado',version:2,reason:'Daño confirmado',...overrides};
}

test('an approved extra says what is left to do: it is pending until its document exists',()=>{
  assert.equal(rentalExtraState(extra()),'Aprobado · pendiente de emitir');
  assert.equal(rentalExtraState(extra({document_id:'doc-extra',issued_on:'2026-11-10',due_on:'2026-11-24'})),'Aprobado · emitido');
  assert.equal(rentalExtraState(extra({status:'Propuesto'})),'Propuesto');
  assert.equal(rentalExtraState(extra({status:'Rechazado'})),'Rechazado');
  // Only an approved extra with an amount and no document can be issued.
  assert.equal(rentalExtraCanIssue(extra()),true);
  assert.equal(rentalExtraCanIssue(extra({document_id:'doc-extra'})),false);
  assert.equal(rentalExtraCanIssue(extra({status:'Propuesto'})),false);
  assert.equal(rentalExtraCanIssue(extra({amount:null})),false);
});

test('the folio offers the emission of the extra and says that it does not receive money',()=>{
  const source=readFileSync('src/components/organisms/rental-inspection.tsx','utf8');
  assert.match(source,/Emitir el importe del extra/);
  assert.match(source,/No recibe dinero/);
  // The amount is never typed by the operator when the extra is issued.
  assert.match(source,/issueRentalExtra\(/);
  assert.doesNotMatch(source,/name="amount"[^>]*(?=.*issueRentalExtra)/);
});

test('the period prefill is the same with an issued extra document: the extra never under-bills the period',()=>{
  const withExtra=rentalMoneyEvidence(caseFile(),booking,null);
  const withoutExtra=rentalMoneyEvidence(caseFile({documents:[periodDocument]} as Partial<CaseFile>),booking,null);
  assert.equal(withExtra?.charged,145,'the extra is charged money');
  assert.equal(withExtra?.periodCharged,120,'but it is not a period of the rental');
  assert.equal(withExtra?.periodPaid,0);
  // The pending amount to issue is the agreed amount minus the period, never minus the extra.
  assert.equal(rentalAccounts(withExtra)?.pendingToEmit,230);
  assert.equal(rentalAccounts(withoutExtra)?.pendingToEmit,230);
  // And the modal starts with that same amount, with the extra document in the folio or not.
  const period=rentalIssuePeriod(booking,[]);
  const prefilled=rentalIssuePrefill(period,'2026-11-22',350,230,documents as unknown as RentalPeriodDocument[]);
  const plain=rentalIssuePrefill(period,'2026-11-22',350,230);
  assert.equal(prefilled.amount,'230.00');
  assert.equal(plain.amount,'230.00');
  assert.equal(rentalPeriodCharge(documents as unknown as RentalPeriodDocument[]),120);
  // The extra document is a receivable of its own: it is part of the money already owed.
  assert.equal(rentalAccounts(withExtra)?.pendingIssued,145);
});
