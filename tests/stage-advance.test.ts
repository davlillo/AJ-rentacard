import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stageAdvance,typingInFolio} from '../src/controladores/stage-advance';
import {rentalSectionStage} from '../src/controladores/rental-workflow';
import {workshopSection} from '../src/controladores/workshop-pipeline';
// The folio follows the derived stage only after a successful action: never while a
// form is being typed, never against a manual pick and never in a loop.
const source=(path:string)=>readFileSync(path,'utf8');

test('a stage that changed after a successful action advances',()=>{
  const decision=stageAdvance({previous:0,current:1,confirmed:true,dirty:false,manual:false});
  assert.deepEqual(decision,{advance:true,stage:1,reason:'advanced'});
  // The rental stages are the real values of the folio.
  assert.equal(stageAdvance({previous:rentalSectionStage('Resumen'),current:rentalSectionStage('Cuentas'),
    confirmed:true,dirty:false,manual:false}).stage,3);
});

test('a stage that did not change stays put',()=>{
  const decision=stageAdvance({previous:2,current:2,confirmed:true,dirty:false,manual:false});
  assert.deepEqual(decision,{advance:false,stage:2,reason:'unchanged'});
});

test('a manual selection is respected',()=>{
  const decision=stageAdvance({previous:0,current:3,confirmed:true,dirty:false,manual:true});
  assert.equal(decision.advance,false);
  assert.equal(decision.reason,'manual-selection');
});

test('a form being typed never triggers a jump',()=>{
  const decision=stageAdvance({previous:0,current:2,confirmed:true,dirty:true,manual:false});
  assert.equal(decision.advance,false);
  assert.equal(decision.reason,'form-dirty');
});

test('a reload that did not follow a successful action never advances',()=>{
  const decision=stageAdvance({previous:0,current:4,confirmed:false,dirty:false,manual:false});
  assert.equal(decision.advance,false);
  assert.equal(decision.reason,'not-confirmed');
});

test('a delivered workshop job has no stage to advance to',()=>{
  const decision=stageAdvance<string>({previous:'approval',current:null,confirmed:true,dirty:false,manual:false});
  assert.deepEqual(decision,{advance:false,stage:null,reason:'no-stage'});
  // The workshop sections are comparable values, so the same helper serves both folios.
  const moved=stageAdvance({previous:workshopSection('Presupuestos'),current:workshopSection('Cobros'),
    confirmed:true,dirty:false,manual:false});
  assert.equal(moved.advance,true);
  assert.equal(moved.stage,'collections');
});

test('the typing guard is inert without a document and never throws',()=>{
  assert.equal(typingInFolio(null),false);
  assert.equal(typingInFolio(undefined),false);
});

// The surfaces that own the folio disclosures.
const DISCLOSURE='src/components/organisms/disclosure.tsx';
const DISCLOSURE_CSS='src/components/organisms/disclosure.module.css';
const RENTAL='src/components/templates/rental-case-screen.tsx';
const RENTAL_CSS='src/components/templates/rental-case-screen.module.css';
const WORKSHOP='src/components/templates/workshop-case-screen.tsx';
const COLLECTIONS='src/components/organisms/workshop-collections.tsx';
const OWNED=[DISCLOSURE,RENTAL,WORKSHOP,COLLECTIONS];

test('no raw details/summary disclosure remains in the folio surfaces',()=>{
  for(const path of OWNED){
    const text=source(path);
    assert.equal(text.includes('<details'),false,`${path} still renders a raw <details>`);
    assert.equal(text.includes('<summary'),false,`${path} still renders a raw <summary>`);
  }
  assert.ok(source(RENTAL_CSS).includes('summary')===false,'the rental styles no longer style a summary');
});

test('the disclosure is a real button with an expanded state and a rotating chevron',()=>{
  const text=source(DISCLOSURE);
  assert.match(text,/<button type="button"/);
  assert.match(text,/aria-expanded=\{expanded\}/);
  assert.match(text,/aria-controls=\{panelId\}/);
  assert.match(text,/role="region"/);
  assert.match(text,/aria-labelledby=\{buttonId\}/);
  assert.match(text,/ChevronDown/);
  assert.match(text,/hidden=\{!expanded\}/);
  // A controlled caller can drive it.
  assert.match(text,/open\?:boolean/);
  assert.match(text,/onOpenChange\?\.\(next\)/);
  const css=source(DISCLOSURE_CSS);
  assert.match(css,/\.trigger\[aria-expanded="true"\] \.chevron \{ transform: rotate\(180deg\)/);
  assert.match(css,/\.trigger:hover/);
  assert.match(css,/\.trigger:focus-visible/);
});

test('the short always-relevant blocks are shown open with a heading',()=>{
  const text=source(RENTAL);
  // Agreements and observations: no interaction required.
  assert.match(text,/aria-label="Acuerdos y observaciones del folio"/);
  assert.match(text,/<h3 className=\{styles\.openBlockTitle\}>Acuerdos y observaciones del folio<\/h3>/);
  assert.match(text,/aria-label="Cancelar reserva no entregada"/);
  assert.match(text,/<h3 className=\{styles\.openBlockTitle\}>Cancelar reserva no entregada<\/h3>/);
  assert.match(source(RENTAL_CSS),/\.openBlock \{/);
});

test('the optional blocks keep their hint inside the styled disclosure',()=>{
  const text=source(RENTAL);
  assert.match(text,/<Disclosure className=\{styles\.optionalBlock\} label="Gastos de este alquiler"\s*hint="Opcional · registre un gasto solo si pagó algo de este alquiler">/);
  assert.match(text,/<Disclosure className=\{styles\.optionalBlock\} label="Fotos y documentos" hint="Opcional · guarde fotos o soportes">/);
  assert.match(text,/label="Extender o acordar la fecha de devolución"/);
  // The workshop history keeps its own disclosure.
  assert.match(source(COLLECTIONS),/<Disclosure className=\{styles\.history\} label="Documentos y movimientos" defaultOpen>/);
});

test('every form, field and submit handler inside the moved blocks is unchanged',()=>{
  const text=source(RENTAL);
  // The cancel form: same field, same payload, same guard.
  assert.match(text,/<input name="reason" required\/>/);
  assert.match(text,/mutate\('cancel',\{reservationId:id,expectedVersion:booking\.version,reason:String\(f\.get\('reason'\)\)\}\)/);
  assert.match(text,/booking\.status!=='Cancelada'&&booking\.rental_state==='Preparado'&&can\('orders\.write'\)/);
  // The agreements form: same textarea, same command and payload.
  assert.match(text,/<textarea name="body" required maxLength=\{20000\}\/>/);
  assert.match(text,/execute\('reservation\.evidence',payload,key=>reservationCommand\('evidence',payload,key\)\)/);
  // The extension form keeps its fields and its confirmation command.
  assert.match(text,/<input name="endsAt" type="datetime-local" required/);
  assert.match(text,/<textarea name="extensionReason" aria-label="Motivo del cambio de fecha" required/);
  assert.match(text,/execute\('reservation\.'\+preview\.command,preview\.payload,/);
  assert.match(text,/<RentalPeriods key=\{booking\.id\} booking=\{booking\} onChange=\{onChange\}\/>/);
  // The upload block keeps the same shared component and the same scope.
  assert.match(text,/<CaseFiles file=\{file\} reservationId=\{id\} onChange=\{reload\}\/>/);
});

test('the automatic advance is wired to the successful reload of each folio',()=>{
  const rental=source(RENTAL);
  assert.match(rental,/const reload=useCallback\(async\(\)=>\{actionAt\.current=\+\+sequence\.current;\s*previousCurrent\.current=currentStageRef\.current;await readAndRefresh\(\);setActionReload\(value=>value\+1\);\},\[readAndRefresh\]\)/);
  assert.match(rental,/stageAdvance\(\{previous:previousCurrent\.current,current:currentStage,confirmed:true,/);
  assert.match(rental,/dirty:typingInFolio\(folioRef\.current\),manual:manualAt\.current>actionAt\.current/);
  assert.match(rental,/role="status">\{advanceNotice\}/);
  // The manual circles still navigate and reset the notice.
  assert.match(rental,/onSelect=\{index=>pickStage\(index\)\}/);
  const workshop=source(WORKSHOP);
  assert.match(workshop,/const observed=previousCurrent\.current;/);
  assert.match(workshop,/if\(observed===pipeline\.current\)return;/);
  assert.match(workshop,/stageAdvance\(\{previous:observed,current:pipeline\.current,confirmed:true,/);
  assert.match(workshop,/previousCurrent\.current=pipelineRef\.current\.current;/);
  assert.match(workshop,/role="status">\{advanceNotice\}/);
  assert.match(workshop,/function select\(next:WorkshopSection\)\{manualAt\.current=\+\+sequence\.current;/);
  // The circles keep working: the progress component still receives onSelect.
  assert.match(workshop,/<WorkshopStageProgress pipeline=\{pipeline\} onSelect=\{select\} selected=\{section\}/);
});
