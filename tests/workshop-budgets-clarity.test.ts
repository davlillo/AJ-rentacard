import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// The budget must be workable inside the folio: the stage owns the action, the
// editor mounts inline and the save keeps the canonical command, the parent
// revision and the version guard. The costs block is worded apart from the
// customer receivable and the empty stage is a bug. No command, payload, version
// guard or money number changes here.

const read=(path:string)=>readFileSync(path,'utf8');
const SCREEN='src/components/templates/workshop-case-screen.tsx';
const ESTIMATES='src/components/templates/operational-estimates.tsx';
const COLLECTIONS='src/components/organisms/workshop-collections.tsx';
const COSTS='src/components/organisms/workshop-costs.tsx';
const PIPELINE='src/controladores/workshop-pipeline.ts';
const LANGUAGE='src/controladores/workshop-money-language.ts';

// Extracts every <Button ...> opening tag, ignoring the '>' characters that live
// inside inline handlers. A button without a variant is the single primary.
function buttonTags(text:string):string[]{
  const tags:string[]=[];
  for(let index=text.indexOf('<Button');index>=0;){
    let depth=0;let quote='';let end=index;
    for(end=index;end<text.length;end++){
      const char=text[end];
      if(quote){if(char===quote)quote='';continue;}
      if(char==='"'||char==="'"){quote=char;continue;}
      if(char==='{'||char==='('||char==='[')depth++;
      else if(char==='}'||char===')'||char===']')depth--;
      else if(char==='>'&&depth===0)break;
    }
    tags.push(text.slice(index,end+1));
    index=text.indexOf('<Button',end+1);
  }
  return tags;
}
const primary=(text:string)=>buttonTags(text).filter(tag=>
  !/variant\s*=\s*(?:"(?:outline|ghost|destructive)"|\{'outline'\})/.test(tag));

function block(source:string,start:string,end:string):string{
  const from=source.indexOf(start);
  assert.ok(from>=0,`the block "${start}" is present`);
  const to=source.indexOf(end,from);
  assert.ok(to>from,`the block "${start}" is closed by "${end}"`);
  return source.slice(from,to);
}

test('The budget stage offers the creation action when the job has no quote and mounts the editor inline',()=>{
  const budget=block(read(SCREEN),"{section==='budget'","{section==='approval'");
  assert.match(budget,/Crear el presupuesto del trabajo/);
  assert.match(budget,/Editar el presupuesto del trabajo/);
  assert.match(budget,/<BudgetEditor/);
  // The action is the only primary of the stage and it opens the inline editor.
  assert.equal(primary(budget).length,1);
  assert.match(primary(budget)[0],/onClick/);
  assert.match(budget,/startEditor\(\)/);
});

test('An existing draft keeps the editor editable inline and the save reuses the canonical path',()=>{
  const budget=block(read(SCREEN),"{section==='budget'","{section==='approval'");
  // The editor is mounted for a draft as well, not only for the first creation.
  assert.match(budget,/draft|latest/i);
  const editor=read(ESTIMATES);
  // One module owns the editor for the list workspace and for the folio.
  assert.match(editor,/export function BudgetEditor/);
  // The canonical command, its idempotency key and the parent revision are preserved.
  assert.match(editor,/recordConnectedQuote\(payload,key\)/);
  assert.match(editor,/parentId:revisionParent/);
  assert.match(editor,/needsExistingScope/);
  // The re-approval notice of the canonical flow stays part of the editor.
  assert.match(editor,/reApproval/);
  assert.match(editor,/RE_APPROVAL_NOTICE/);
  // The stage adds no second save path of its own.
  assert.equal(/estimateCommand\(/.test(read(SCREEN)),false);
  assert.equal(/recordConnectedQuote\(/.test(read(SCREEN)),false);
});

test('The approval stage still sends and approves inline and never renders empty',()=>{
  const approval=block(read(SCREEN),"{section==='approval'","{section==='collections'");
  assert.match(approval,/<CaseQuotes[^>]*job=\{job\}/);
  // Without any quote the stage still offers one clear action to start it.
  assert.match(approval,/Crear el presupuesto del trabajo/);
});

test('The actual costs live in the costs stage and in collections, never in a removed stage',()=>{
  const screen=read(SCREEN);
  assert.equal(/section==='work'/.test(screen),false);
  assert.equal(/workView/.test(screen),false);
  const collections=block(screen,"{section==='collections'","{section==='delivery'");
  // Customer jobs read the shop money next to the customer money; internal jobs only the shop money.
  assert.match(collections,/<WorkshopCosts/);
  assert.match(collections,/<WorkshopCollections/);
  assert.match(collections,/internal_job/);
  // The costs stay the same component and the same command entry.
  assert.match(read(COSTS),/>Registrar costo</);
  assert.match(read(COSTS),/costEntryQuestion/);
});

test('The two money groups stay separate and the confusing pair is renamed',()=>{
  const source=read(COLLECTIONS);
  // The shop money is named plainly and carries its two amounts.
  assert.match(source,/workshopMoneyLabels.costsHeading/);
  assert.match(source,/workshopMoneyLabels.paidToSupplier/);
  assert.match(source,/workshopMoneyLabels.pendingWithSupplier/);
  assert.match(read(LANGUAGE),/costsHeading:'Costos del trabajo'/);
  assert.match(read(LANGUAGE),/paidToSupplier:'Pagado al proveedor'/);
  assert.match(read(LANGUAGE),/pendingWithSupplier:'Pendiente con el proveedor'/);
  // The customer money is stated as what the client owes, with the four canonical facts.
  assert.match(source,/workshopMoneyLabels.receivableHeading/);
  assert.match(read(LANGUAGE),/receivableHeading:'Lo que el cliente debe'/);
  for(const fact of ['Importe acordado con el cliente','Importe facturado al cliente',
    'Cobro aplicado a este trabajo','Pendiente de cobro'])assert.ok(read(LANGUAGE).includes(fact),fact);
  // The unexplained pair disappears from every surface of the stage.
  const costs=read(COSTS);
  for(const surface of [source,costs]){
    assert.equal(/costos reales y gastos pagados/i.test(surface),false);
  }
});

test('Tareas is no longer a section and the responsible name stays a plain field',()=>{
  const screen=read(SCREEN);
  assert.match(screen,/<TaskBoard orderId=\{job\.id\}\/>/);
  assert.match(screen,/no impiden entregar/);
  // The name is typed; no tracking-account selector stands in front of it.
  assert.match(screen,/Responsable del trabajo/);
  assert.match(screen,/<JobResponsible/);
  assert.equal(/Cuenta de seguimiento/.test(screen),false);
  // The plain field writes through the canonical task command with its version guard.
  assert.match(screen,/executeTaskCommand\(command,payload/);
  assert.match(screen,/\?\{taskId:task\.id,expectedVersion:task\.version/);
});

test('The internal summary points at the real costs stage, never at a customer collection',()=>{
  const screen=read(SCREEN);
  assert.match(screen,/se revisan en la etapa «Costos reales»/);
  assert.match(screen,/Ver costos del trabajo →/);
});

test('Every stage renders its content or one clear action to start it',()=>{
  const screen=read(SCREEN);
  const stages=['summary','diagnosis','budget','approval','collections','delivery','documents'];
  for(const stage of stages)
    assert.ok(screen.includes(`{section==='${stage}'&&`),`the stage ${stage} has no render branch`);
  // The stage recommended by the pipeline is always one of the rendered branches.
  const pipeline=read(PIPELINE);
  for(const key of ["'diagnosis'","'budget'","'approval'","'collections'","'delivery'"])
    assert.ok(pipeline.includes(key),`the pipeline never recommends ${key}`);
  assert.match(pipeline,/current:WorkshopSection\|null=/);
});

test('The stage circles stay the only navigation and the summary stays a utility',()=>{
  const screen=read(SCREEN);
  assert.equal(/aria-label="Trabajo y costos"/.test(screen),false);
  assert.match(screen,/<WorkshopStageProgress/);
  assert.match(screen,/\{key:'summary',label:'Resumen'/);
  assert.equal(primary(screen).length,2);
});
