import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// The operator must SEE the next money action: after the client approves, the
// approval stage itself offers the issuance of the importe a cobrar; a pending
// cost shows its classification question on the card surface; and the delivery
// review names every blocker with a link to the stage that resolves it. The
// canonical bill_scope command, the classification command and every amount
// keep their existing shape: this is presentation only.

const read=(path:string)=>readFileSync(path,'utf8');
const SCREEN='src/components/templates/workshop-case-screen.tsx';
const COLLECTIONS='src/components/organisms/workshop-collections.tsx';
const COSTS='src/components/organisms/workshop-costs.tsx';
const DELIVERY='src/components/organisms/workshop-delivery.tsx';

function block(source:string,start:string,end:string):string{
  const from=source.indexOf(start);
  assert.ok(from>=0,`the block "${start}" is present`);
  const to=source.indexOf(end,from);
  assert.ok(to>from,`the block "${start}" is closed by "${end}"`);
  return source.slice(from,to);
}

test('After an approval decision the approval stage offers the issuance inline',()=>{
  const approval=block(read(SCREEN),"{section==='approval'","{section==='collections'");
  assert.match(approval,/Emitir importe a cobrar/);
  assert.match(approval,/No recibe dinero ni cambia el costo\./);
  // It reuses the shared issuance form component; no second bill_scope call site.
  assert.match(approval,/<WorkshopIssueForm/);
  // The approved total is shown as the reference of the issuance.
  assert.match(approval,/approvedScope/);
  // The card comes before the quote tables so it is never buried below them.
  assert.ok(approval.indexOf('issueCard')<approval.indexOf('<CaseQuotes'),'the issuance card must precede the quote list');
  // The quote list no longer carries its own issuance control.
  assert.equal(read('src/components/organisms/case-quotes.tsx').includes("'bill_scope'"),false);
});

test('The bill_scope command, payload and guards exist exactly once and are shared',()=>{
  const collections=read(COLLECTIONS);
  const form=collections.indexOf('export function WorkshopIssueForm');
  assert.ok(form>=0,'the shared issuance form is exported');
  const calls=collections.split("execute('bill_scope'").length-1;
  assert.equal(calls,1,'bill_scope must be issued from one place only');
  assert.match(collections,/orderId:job\.id,date:String\(form\.get\('date'\)\),dueOn:String\(form\.get\('dueOn'\)\)/);
  // The collections stage still keeps its own collection actions and mounts the
  // same form for its issuance editor, without duplicating the markup.
  assert.match(collections,/Preparar importe a cobrar|prepareAction/);
  assert.match(collections,/<WorkshopIssueForm/);
});

test('A pending cost asks its classification question on the card surface',()=>{
  const costs=read(COSTS);
  assert.match(costs,/Pendiente de clasificar/);
  assert.match(costs,/¿Este costo está incluido en el presupuesto\?/);
  // The classification form mounts open for a pending cost and keeps the
  // progressive disclosure for a decided one.
  assert.match(costs,/expanded=\{cost\.disposition==='Pendiente'\}/);
  assert.match(costs,/if\(expanded\)return <div/);
  assert.match(costs,/<Disclosure label="Revisar relación con el presupuesto">/);
  // The compact state line of a decided cost stays.
  assert.match(costs,/styles\.status/);
});

test('The delivery review names each blocker with its resolving stage',()=>{
  const delivery=read(DELIVERY);
  assert.match(delivery,/deliveryPendingCost/);
  assert.match(delivery,/clasificar en/);
  assert.match(delivery,/seccion='\+encodeURIComponent\('Costos'\)/);
  // The undecided revision points at the stage where the decision happens.
  assert.match(delivery,/encodeURIComponent\('Aprobación del cliente'\)/);
  // Open tasks are named, not just counted.
  assert.match(delivery,/openTasks\.map/);
  assert.match(delivery,/encodeURIComponent\('Tareas'\)/);
  assert.match(delivery,/>Costos del trabajo<\/Link>/);
  assert.match(delivery,/>revisar en Tareas<\/Link>/);
});

test('The new surfaces keep the money wording free of cargo and abono jargon',()=>{
  for(const path of [SCREEN,COLLECTIONS,COSTS,DELIVERY]){
    const source=read(path);
    assert.doesNotMatch(source,/Cargo o anticipo|Destino del abono|Importe del abono|Sin cargo\.|a un cargo\b|Total acordado/,
      `${path} introduced money jargon`);
  }
});
