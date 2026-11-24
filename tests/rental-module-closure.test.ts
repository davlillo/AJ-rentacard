import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rentalAccounts,rentalAccountsAdvice,rentalLifecycle,rentalMoneyEvidence,rentalPendingSentence,rentalStages,type RentalMoneyEvidence} from '../src/controladores/rental-lifecycle';
import {rentalSection,rentalSectionStage,rentalSections} from '../src/controladores/rental-workflow';
import type {Reservation} from '../src/lib/supabase/reservations';

const source=(path:string)=>readFileSync(path,'utf8');
const occurrences=(text:string,needle:string):number=>text.split(needle).length-1;
// Extracts every <Button ...> opening tag; a button is primary when it keeps the default variant.
function primaryButtons(text:string):string[]{
  const tags:string[]=[];
  for(let index=text.indexOf('<Button');index>=0;){
    let depth=0,quote='';let end=index;
    for(end=index;end<text.length;end++){const char=text[end];
      if(quote){if(char===quote)quote='';continue;}
      if(char==='"'||char==="'"){quote=char;continue;}
      if(char==='{'||char==='('||char==='[')depth++;
      else if(char==='}'||char===')'||char===']')depth--;
      else if(char==='>'&&depth===0)break;}
    tags.push(text.slice(index,end+1));index=text.indexOf('<Button',end+1);}
  return tags.filter(tag=>!/variant\s*=\s*(?:"(?:outline|ghost|destructive)"|\{'outline'\}|\{uploadVariant\})/.test(tag));
}

const documents=source('src/components/organisms/customer-documents.tsx');
const profile=source('src/components/templates/customer-profile-screen.tsx');
const folio=source('src/components/templates/rental-case-screen.tsx');
const wizard=source('src/components/templates/rental-create-screen.tsx');
const accounts=source('src/components/organisms/rental-accounts.tsx');
const periods=source('src/components/organisms/rental-periods.tsx');
const lifecycle=source('src/controladores/rental-lifecycle.ts');

const booking={id:'rental',version:4,status:'Confirmada',rental_state:'Cerrado',
  starts_at:'2026-11-01T12:00:00-06:00',ends_at:'2026-11-08T12:00:00-06:00',
  actual_departure_at:'2026-11-02T12:00:00-06:00',actual_return_at:'2026-11-05T12:00:00-06:00',
  daily_rate:50,total:350};
function evidence(overrides:Partial<RentalMoneyEvidence>={}):RentalMoneyEvidence{
  return{charged:120,balance:80,paid:40,advances:0,agreed:350,estimate:150,...overrides};
}

test('the identity document opens in an accessible modal and never below the list',()=>{
  assert.ok(documents.includes("from '@/components/ui/dialog'"));
  for(const part of ['DialogContent','DialogTitle','DialogDescription']){
    assert.ok(documents.includes(part),part);
  }
  // The image is rendered inside the dialog, not appended under the document list.
  assert.ok(documents.indexOf('<Dialog')>=0);
  assert.ok(documents.indexOf('<Dialog')<documents.indexOf('<img'));
  assert.ok(!documents.includes('Ocultar foto'));
  assert.ok(documents.includes('<details'),'the photo history stays available');
  // The authorization path does not change: the same private file is read through the same RPC.
  assert.ok(documents.includes('readCustomerDocument('));
  assert.ok(documents.includes('customer.document.view'));
  assert.ok(!documents.includes('createSupabaseBrowserClient'));
  assert.ok(!documents.includes('storage'));
});

test('the identity document viewer names the customer and keeps the privacy statement',()=>{
  assert.ok(documents.includes('customerName'));
  assert.ok(profile.includes('customerName'));
  assert.ok(profile.includes('Fotos privadas de DUI y licencia'));
  assert.ok(documents.includes('Fotos privadas, disponibles solo para el personal autorizado'));
  // One card per document kind, with an honest empty state.
  assert.ok(documents.includes('Sin foto registrada'));
  assert.equal(occurrences(documents,'Documento de identidad (DUI)'),1);
  assert.equal(occurrences(documents,'Licencia de conducir'),1);
});

test('the folio shows the rental agreement as a detailed card',()=>{
  assert.ok(folio.includes('Acuerdo del alquiler'));
  for(const fact of ['Cliente','Vehículo','Entrega prevista','Devolución prevista','Duración',
    'Tarifa diaria','Total acordado','Estado del alquiler','Estado del vehículo']){
    assert.ok(folio.includes(fact),fact);
  }
  // The old flat panel is gone: the agreement is its own card now.
  assert.ok(!folio.includes('<h2 className="font-semibold">Acuerdo del alquiler</h2>'));
});

test('the client detail document is offered at agreement time in the folio and in the wizard',()=>{
  assert.ok(folio.includes('Descargar el detalle para el cliente'));
  assert.ok(folio.includes('rentalDocument(documentFacts)'));
  // One in the agreement card and one in Cuentas. The return step does not repeat it.
  assert.equal(occurrences(folio,'<RentalDocumentExport'),1);
  assert.ok(folio.includes('antes de que se le entregue el vehículo'));
  assert.ok(wizard.includes('<RentalDocumentExport'));
  assert.ok(wizard.includes('rentalDocument('));
  assert.ok(wizard.includes('antes de entregar el vehículo'));
});

test('the folio is one ordered flow: the circles are the only navigation',()=>{
  // The second tab bar is gone: the stages are the navigation.
  assert.ok(!folio.includes('Consulta y gestión del folio'));
  assert.ok(!folio.includes('rentalNavigationSections'));
  assert.ok(!folio.includes('rentalSectionTarget'));
  assert.ok(folio.includes('<RentalStageProgress'));
  assert.ok(folio.includes('rentalSectionStage'));
  // Every legacy section still resolves to a real stage of the flow.
  for(const section of rentalSections){
    const stage=rentalSectionStage(section);
    assert.ok(Number.isInteger(stage)&&stage>=0&&stage<rentalStages.length,section);
  }
  assert.equal(rentalSectionStage('Resumen'),0);
  assert.equal(rentalSectionStage('Salida y devolución'),2);
  assert.equal(rentalSectionStage('Cuentas'),3);
  assert.equal(rentalSectionStage('Cargos y abonos'),3);
  assert.equal(rentalSectionStage('Gastos'),4);
  assert.equal(rentalSectionStage('Fotos y documentos'),4);
  assert.equal(rentalSectionStage('Contrato'),4);
  // The release moved to the vehicle side, so the old section lands on the return stage.
  assert.equal(rentalSectionStage('Limpieza'),2);
  assert.equal(rentalSection('Limpieza'),'Limpieza');
  // The three former tabs that are not stages live inside the last one.
  assert.ok(folio.includes('Cierre del alquiler'));
  assert.ok(folio.includes('<CaseFiles'));
  assert.ok(folio.includes('<RentalContracts'));
});

test('the folio, the stage list and the return step speak about no cleaning step',()=>{
  const operation=source('src/components/organisms/rental-operation.tsx');
  const inspection=source('src/components/organisms/rental-inspection.tsx');
  for(const [path,text] of [['src/components/templates/rental-case-screen.tsx',folio],
    ['src/components/organisms/rental-operation.tsx',operation],
    ['src/components/organisms/rental-inspection.tsx',inspection]] as const){
    assert.doesNotMatch(text,/limpieza/i,path);
  }
  assert.ok(!folio.includes('RentalCleaning'));
  assert.ok(!folio.includes('rental-cleaning'));
  assert.ok(!folio.includes('Continuar con limpieza'));
  // The compact journey of the operation reads the same ordered flow.
  assert.ok(operation.includes("['Reserva','Alquilado','Devolución','Cuentas','Finalizado']"));
});

test('the release of the vehicle is confirmed from the vehicle dossier',()=>{
  const dossier=source('src/components/templates/vehicle-dossier.tsx');
  const release=source('src/components/organisms/vehicle-release-review.tsx');
  assert.ok(dossier.includes('<VehicleReleaseReview'));
  assert.ok(dossier.includes('Historial de alquileres'));
  // The canonical command, its payload, both optimistic versions and the permission check.
  assert.ok(release.includes('review_return_cleaning'));
  assert.ok(release.includes('expectedVersion:booking.version'));
  assert.ok(release.includes('expectedVehicleVersion:file.vehicle.version'));
  assert.ok(release.includes('idempotency_key:key'));
  assert.ok(release.includes("can('orders.write')"));
  assert.ok(release.includes('Confirmar entrega y liberar el vehículo'));
  assert.ok(release.includes('no cobra nada'));
  assert.doesNotMatch(release,/limpieza/i);
});

test('the return step is one primary action and the extras are behind a disclosure',()=>{
  const inspection=source('src/components/organisms/rental-inspection.tsx');
  assert.ok(inspection.includes('Registrar devolución'));
  assert.ok(inspection.includes('Confirmar devolución'));
  // The extras are exceptional: they only appear inside a collapsed disclosure.
  assert.ok(inspection.includes('Diferencias detectadas en la inspección'));
  assert.ok(inspection.includes('<details'));
  assert.ok(inspection.includes("decision==='Aprobado'&&!(Number(amount)>0)"));
  // The states of every proposal stay visible.
  for(const state of ['Propuesto','Aprobado','Rechazado'])assert.ok(inspection.includes(state),state);
  // The readings, the confirmation and the quiet discard stay.
  assert.ok(inspection.includes('Kilometraje (km)'));
  assert.ok(inspection.includes('Combustible (%)'));
  assert.ok(inspection.includes('Revisión general del vehículo (360°)'));
  assert.match(inspection,/variant="outline"[\s\S]{0,240}?Descartar borrador/);
});

test('the derived stage keeps Cuentas open while an amount is still pending',()=>{
  const booking={id:'rental',version:4,status:'Confirmada',rental_state:'Cerrado',
    starts_at:'2026-11-01T12:00:00-06:00',ends_at:'2026-11-08T12:00:00-06:00',
    actual_departure_at:'2026-11-02T12:00:00-06:00',actual_return_at:'2026-11-05T12:00:00-06:00',
    daily_rate:50,total:350} as unknown as Reservation;
  const unpaid=rentalLifecycle(booking,{label:'Alquiler finalizado',tone:'green',step:3,action:null,description:''},
    evidence({charged:120,balance:80,paid:40}));
  assert.equal(unpaid.current,3);
  assert.equal(unpaid.stages.find(stage=>stage.label==='Cuentas')?.current,true);
  assert.equal(unpaid.stages.find(stage=>stage.label==='Finalizado')?.current,false);
  const settled=rentalLifecycle(booking,{label:'Alquiler finalizado',tone:'green',step:3,action:null,description:''},
    evidence({charged:350,balance:0,paid:350}));
  assert.equal(settled.current,4);
  assert.equal(settled.stages.find(stage=>stage.label==='Cuentas')?.complete,true);
  assert.equal(settled.stages.find(stage=>stage.label==='Finalizado')?.current,true);
});

test('the period form is reachable from Cuentas and still belongs to the rental',()=>{
  const extension=folio.slice(folio.indexOf('function RentalExtension'),folio.indexOf('function RentalAgreements'));
  assert.ok(extension.includes('<RentalPeriods'));
  // The issuing action reuses the same canonical form of the periods module.
  assert.ok(accounts.includes('Emitir importe a cobrar'));
  assert.ok(accounts.includes("from '@/components/organisms/rental-periods'"));
  assert.equal(occurrences(folio,'<RentalPeriods'),1);
});

// The closing stage of the folio: one status, a compact summary, optional extras.
const closing=folio.slice(folio.indexOf('shown===4&&<>'),folio.indexOf('{(error||loadError)'));

test('the closing stage states the status once and keeps a compact summary',()=>{
  assert.ok(closing.includes('Cierre del alquiler'));
  // One status line: the detail list no longer repeats the rental state.
  assert.ok(!closing.includes('Estado del alquiler'),'the status must not be duplicated in the detail list');
  // One status line per state: the closed release and the retained-release branch.
  assert.equal(occurrences(closing,'cerrado operativamente'),2);
  // The compact read-only summary keeps every closing fact.
  for(const fact of ['Folio','Cliente','Vehículo','Entrega','Devolución','Total acordado',
    'Pendiente por cobrar','Estado del vehículo']){
    assert.ok(closing.includes(fact),fact);
  }
  // The pending amount is stated in plain words, with or without a balance.
  assert.ok(folio.includes('Pendiente por cobrar: ${money(accounts.pending)}'));
  assert.ok(closing.includes('${pendingNote}'));
  assert.ok(folio.includes('Sin saldo pendiente por cobrar'));
  // The money figure still comes from the same account model.
  assert.ok(closing.includes('money(booking.total)'));
  assert.ok(closing.includes('money(accounts.pending)'));
});

test('the three closing extras are collapsed and clearly optional',()=>{
  // Gastos and Fotos are details here; the contract block carries its own details organism.
  assert.equal(occurrences(closing,'<details'),2);
  for(const hint of ['Opcional · registre un gasto solo si pagó algo de este alquiler',
    'Opcional · guarde fotos o soportes','Opcional · condiciones y aceptación del contrato']){
    assert.ok(closing.includes(hint),hint);
  }
  // Nothing looks mandatory before a block is opened, and the uploads stay secondary.
  assert.ok(closing.includes('<CaseFiles file={file} reservationId={id} onChange={reload}/>'));
  const primary=primaryButtons(closing);
  assert.equal(primary.length,0,'no primary button of the stage itself is visible by default');
});

test('a rental still pending release offers the release action from the closing stage',()=>{
  // The action appears exactly when the vehicle is still retained, inline in the folio.
  assert.ok(closing.includes("['Devuelto','Cerrado'].includes(booking.rental_state)&&<div className={styles.releaseAction}>"));
  const release=closing.slice(closing.indexOf('releaseAction'));
  assert.ok(release.includes('<VehicleReleaseReview'),'the release is confirmed inline, no navigation needed');
  assert.ok(!release.includes('vehicleHref(car.id)'),'the closing stage no longer sends the operator to the dossier');
  assert.ok(!release.includes('expediente del vehículo'));
});

test('the contract block speaks plainly and keeps the versioned commands',()=>{
  const contracts=source('src/components/organisms/rental-contracts.tsx');
  assert.ok(contracts.includes('Las condiciones acordadas con el cliente y su aceptación'));
  assert.ok(contracts.includes('no cobra nada y no entrega el vehículo'));
  // The same commands, the same required reason field and the stored-PDF download stay.
  assert.ok(contracts.includes("submit('version'"));
  assert.ok(contracts.includes("submit('accept'"));
  assert.ok(contracts.includes('<input name="reason" required/>'));
  assert.ok(contracts.includes('storedContractPdf(contract.id)'));
  assert.ok(contracts.includes('Descargar contrato V{contract.revision}'));
});

test('the accounts lead with three facts and keep the technical detail collapsed',()=>{
  for(const fact of ['Lo acordado','Lo cobrado','Lo pendiente']){
    assert.ok(accounts.includes(fact),fact);
  }
  assert.ok(accounts.includes('Detalle de importes'));
  assert.ok(accounts.indexOf('Lo acordado')<accounts.indexOf('Detalle de importes'));
  const detail=accounts.slice(accounts.indexOf('Detalle de importes'));
  for(const row of ['Importes emitidos al cliente','Cobros aplicados (netos)',
    'Saldo pendiente del documento de cobro','Anticipos por aplicar']){
    assert.ok(detail.includes(row),row);
  }
  // The technical rows do not lead the section any more.
  assert.ok(accounts.indexOf('Detalle de importes')<accounts.indexOf('Importes emitidos al cliente'));
});

test('no rental money surface still speaks about charges',()=>{
  for(const [path,text] of [['src/components/organisms/rental-accounts.tsx',accounts],
    ['src/components/organisms/rental-periods.tsx',periods],
    ['src/components/templates/rental-case-screen.tsx',folio],
    ['src/controladores/rental-lifecycle.ts',lifecycle]] as const){
    assert.equal(/\bcargos?\b/i.test(text),false,`${path} still uses the charge jargon`);
  }
  // The plain wording replaces it without promising a tax invoice.
  assert.ok(accounts.includes('documento de cobro'));
  // The wording about the document that is still to be issued lives in the controller; the section
  // states that difference once, in the reconciliation alarm.
  assert.ok(lifecycle.includes('Pendiente de emitir el documento de cobro'));
  assert.ok(accounts.includes('data-testid="reconciliation-alarm"'));
  assert.ok(accounts.includes('Cobros aplicados (netos)'));
  assert.ok(periods.includes('Emitir importe a cobrar del período'));
  assert.ok(!/\bfacturaci[oó]n\b/i.test(accounts),'the rental money block must not imply a tax invoice');
});

test('the pending amount is explained in plain words',()=>{
  const nothing=rentalAccounts(evidence({charged:0,balance:0,paid:0}));
  const advice=rentalAccountsAdvice(nothing);
  assert.match(advice,/Pendiente por cobrar: \$350\.00/);
  assert.match(advice,/Pendiente de emitir el documento de cobro: \$350\.00/);
  assert.doesNotMatch(advice,/Sin saldo pendiente/);
  assert.doesNotMatch(advice,/cuenta por cobrar/i);
  assert.match(advice,/Lo acordado son \$350\.00/);
  assert.match(advice,/ya se emitieron \$0\.00/);
  assert.match(advice,/todavía falta emitir \$350\.00/);
  const pending=rentalAccountsAdvice(rentalAccounts(evidence()));
  assert.match(pending,/Pendiente por cobrar: \$310\.00/);
  assert.match(pending,/Lo acordado son \$350\.00/);
  assert.match(pending,/ya se emitieron \$120\.00/);
  assert.match(pending,/todavía falta emitir \$230\.00/);
  // The money evidence itself never changes while it is explained.
  const scope=rentalMoneyEvidence({financialAccess:true,reservations:[booking],documents:[],
    applications:[]} as never,booking as never,150);
  assert.equal(scope?.charged,0);
});

test('the agreed amount is the pending to issue when no document exists',()=>{
  const accounts=rentalAccounts(evidence({charged:0,balance:0,paid:0,agreed:80,estimate:null}));
  assert.equal(accounts?.pending,80);
  const sentence=rentalPendingSentence(accounts!);
  assert.match(sentence,/Pendiente de emitir el documento de cobro: \$80\.00/);
  assert.doesNotMatch(sentence,/Sin saldo pendiente/);
});

test('the issuing action lives in Cuentas and reuses the canonical period command',()=>{
  assert.ok(accounts.includes('Emitir importe a cobrar'));
  assert.ok(accounts.includes('setIssuing'));
  assert.ok(accounts.includes('pendingToEmit'));
  // The same form, the same command and every guard of the canonical path.
  assert.ok(periods.includes("reservationCommand('period'"));
  assert.ok(lifecycle.includes('expectedVersion:booking.version'));
  assert.ok(periods.includes('reviewRentalPeriod('));
  assert.ok(periods.includes("can('orders.write')"));
  assert.ok(periods.includes("can('expenses.write')"));
  assert.ok(periods.includes('useCaseAction'));
  assert.ok(periods.includes("execute('period'"));
});
