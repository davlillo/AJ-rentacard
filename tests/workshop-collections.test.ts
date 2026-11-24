import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {CaseFile} from '../src/lib/supabase/cases';
import {workshopCollections} from '../src/controladores/workshop-collections';

const fixture=()=>({
  financialAccess:true,orders:[{id:'job',active_estimate_id:'approved'}],
  quotes:[
    {id:'approved',order_id:'job',revision:1,status:'Aprobado',snapshot:{total:1200}},
    {id:'draft',order_id:'job',revision:2,status:'Borrador',snapshot:{total:1600}},
  ],
  documents:[{id:'doc',amount:9000,scope_amount:1000,scope_balance:400}],
  applications:[{kind:'Aplicacion',scope_amount:650},{kind:'Reversion',scope_amount:50}],
  payments:[{amount:99999}],advances:[{amount:99999,available_amount:100}],
} as unknown as CaseFile);

test('Collections use approved agreement, signed scoped applications and authoritative balance, never receipt headers',()=>{
  const summary=workshopCollections(fixture(),'job');
  assert.equal(summary.agreed,1200);
  assert.equal(summary.charged,1000);
  assert.equal(summary.paid,600);
  assert.equal(summary.balance,400);
  assert.equal(summary.advances,100);
  assert.equal(summary.unbilled,200);
  assert.equal('received' in summary,false);
});

test('Missing financial arrays are unknown rather than an empty settled balance',()=>{
  const file=fixture();delete file.documents;
  const summary=workshopCollections(file,'job');
  assert.equal(summary.known,false);
});

test('A revoked financial snapshot is never known even when cached arrays remain',()=>{
  const file=fixture();file.financialAccess=false;
  assert.equal(workshopCollections(file,'job').known,false);
});

test('Authoritative scoped balances include adjustments without deriving fake debt from applications',()=>{
  const file=fixture();file.documents![0].scope_balance=325;
  assert.equal(workshopCollections(file,'job').balance,325);
});

test('A draft alone does not become agreed price or billable difference',()=>{
  const file=fixture();file.quotes=file.quotes!.slice(1);file.orders[0].active_estimate_id=null;
  const summary=workshopCollections(file,'job');
  assert.equal(summary.agreed,null);assert.equal(summary.unbilled,0);
});

test('A shared document contributes only authoritative line-scoped amounts',()=>{
  const file=fixture();file.documents![0].grouped=true;
  const summary=workshopCollections(file,'job');
  assert.equal(summary.charged,1000);assert.equal(summary.balance,400);
});

test('A changed balance or advance invalidates the captured financial intent',()=>{
  const file=fixture();const first=workshopCollections(file,'job').revision;
  file.documents![0].scope_balance=250;
  const second=workshopCollections(file,'job').revision;assert.notEqual(first,second);
  file.advances![0].available_amount=0;
  assert.notEqual(second,workshopCollections(file,'job').revision);
});

test('Malformed scoped balances remain unknown, never coerced to a settled zero',()=>{
  const file=fixture();file.documents![0].scope_balance=null as unknown as number;
  assert.equal(workshopCollections(file,'job').known,false);
});
