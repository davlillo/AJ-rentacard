import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {workshopPipeline,workshopSection,workshopMoney} from '../src/controladores/workshop-pipeline';
import type {CaseFile,CaseOrder} from '../src/lib/supabase/cases';

const job=(values:Partial<CaseOrder>={})=>({id:'OT-1',status:'Diagnóstico',internal_job:false,
  active_estimate_id:null,pending_fields:[],...values}) as CaseOrder;
const file=(values:Partial<CaseFile>={})=>({orders:[job()],financialAccess:true,quotes:[],costs:[],expenses:[],
  documents:[],applications:[],advances:[],...values}) as unknown as CaseFile;
const quote=(id:string,revision:number,status:string)=>({id,order_id:'OT-1',revision,status,
  snapshot:{cost:40,costComplete:true,total:100,lines:[{}]}}) as NonNullable<CaseFile['quotes']>[number];

test('Quote-only intake never pretends physical reception or approval exists',()=>{
  const flow=workshopPipeline(file(),job({status:'Presupuesto'}));
  assert.equal(flow.stages[0].complete,false);
  assert.equal(flow.current,'diagnosis');
  assert.match(flow.description,/recepción física pendiente/i);
  assert.equal(flow.stages.some(s=>s.key==='collections'),true);
});
test('The customer journey is exactly five stages and the internal one exactly three',()=>{
  const customer=workshopPipeline(file(),job());
  assert.deepEqual(customer.stages.map(stage=>stage.label),
    ['Ingreso y diagnóstico','Costos y presupuesto','Aprobación','Cobros','Entrega']);
  assert.deepEqual(customer.stages.map(stage=>stage.key),['diagnosis','budget','approval','collections','delivery']);
  const internal=workshopPipeline(file(),job({internal_job:true}));
  assert.deepEqual(internal.stages.map(stage=>stage.label),['Ingreso y diagnóstico','Costos reales','Entrega']);
  assert.deepEqual(internal.stages.map(stage=>stage.key),['diagnosis','collections','delivery']);
  // The removed stage no longer exists on any journey.
  for(const flow of [customer,internal])assert.equal(flow.stages.some(stage=>(stage.key as string)==='work'),false);
});
test('Customer diagnosis leads to planned costs, then approval, without a task-count completion shortcut',()=>{
  assert.equal(workshopPipeline(file(),job()).current,'budget');
  for(const status of ['Borrador','Rechazado']){
    const flow=workshopPipeline(file({quotes:[quote('latest',2,status)]}),job());
    assert.equal(flow.current,'approval');
    assert.equal(flow.stages.find(s=>s.key==='approval')?.complete,false);
    assert.match(flow.description,status==='Rechazado'?/rechazad/i:/decisión/i);
  }
});
test('The recommended phase is never a stage the journey does not render',()=>{
  // Every reachable state of both journeys, with and without financial access.
  const states:[Partial<CaseOrder>,Partial<CaseFile>][]=[
    [{status:'Presupuesto'},{}],[{},{}],[{active_estimate_id:'approved'},{quotes:[quote('approved',1,'Aprobado')]}],
    [{active_estimate_id:'approved'},{quotes:[quote('approved',1,'Aprobado')],
      documents:[{scope_amount:100,scope_balance:70} as never]}],
    [{active_estimate_id:'approved',status:'Entregado'},{quotes:[quote('approved',1,'Aprobado')]}],
    [{internal_job:true},{}],[{internal_job:true,status:'Entregado'},{}],
  ];
  for(const financialAccess of [true,false])for(const [order,rest] of states){
    const flow=workshopPipeline(file({...rest,financialAccess} as Partial<CaseFile>),job(order),financialAccess);
    const keys=flow.stages.map(stage=>stage.key);
    assert.equal(new Set(keys).size,keys.length,'a stage key is repeated');
    if(flow.current!==null)assert.equal(keys.includes(flow.current),true,`${flow.current} is not rendered`);
    // A delivered job recommends nothing because every stage is closed.
    if(order.status==='Entregado')assert.equal(flow.current,null);
  }
});
test('Internal jobs recommend the real costs stage, never a customer collection',()=>{
  const flow=workshopPipeline(file(),job({internal_job:true}));
  assert.equal(flow.current,'collections');
  assert.equal(flow.stages[1].label,'Costos reales');
  assert.match(flow.description,/costos/i);
  assert.match(flow.description,/no es una venta/i);
});
test('Only the active approved scope counts; a pending or rejected revision remains visible',()=>{
  const approved=quote('approved',1,'Aprobado');
  for(const status of ['Borrador','Rechazado']){
    const flow=workshopPipeline(file({quotes:[approved,quote('new',2,status)]}),job({active_estimate_id:'approved'}));
    assert.equal(flow.current,'approval');
    assert.equal(flow.approved?.id,'approved');
    assert.match(flow.description,/vigente/i);
    assert.equal(flow.stages.find(s=>s.key==='approval')?.complete,false);
  }
  assert.equal(workshopPipeline(file({quotes:[approved]}),job()).current,'approval');
  assert.equal(workshopPipeline(file({quotes:[approved]}),job({active_estimate_id:'approved'})).current,'collections');
});
test('Internal jobs use three stages independently of fleet membership and never invent customer collections',()=>{
  for(const in_rental_fleet of [false,true]){
    const flow=workshopPipeline(file({vehicle:{in_rental_fleet} as CaseFile['vehicle']}),job({internal_job:true}));
    assert.deepEqual(flow.stages.map(s=>s.key),['diagnosis','collections','delivery']);
    assert.deepEqual(flow.stages.map(s=>s.label),['Ingreso y diagnóstico','Costos reales','Entrega']);
    assert.equal(flow.current,'collections');
  }
});
test('Only persisted delivery completes the last stage, including delivery with debt',()=>{
  const source=file({documents:[{scope_amount:100,scope_balance:75} as never]});
  const flow=workshopPipeline(source,job({status:'Entregado'}));
  assert.equal(flow.current,null);
  assert.equal(flow.stages.find(s=>s.key==='delivery')?.complete,true);
  assert.equal(workshopMoney(source,'OT-1').balance,75);
});
test('P2: issued unpaid customer scope recommends the collections circle without completing work costs',()=>{
  const source=file({quotes:[quote('approved',1,'Aprobado')],
    documents:[{amount:99999,scope_amount:100,scope_balance:70} as never]});
  const flow=workshopPipeline(source,job({active_estimate_id:'approved'}));
  assert.deepEqual(flow.stages.map(stage=>stage.key),['diagnosis','budget','approval','collections','delivery']);
  assert.equal(flow.current,'collections');
  assert.equal(flow.stages.find(stage=>stage.key==='collections')?.complete,false);
  assert.match(flow.stages.find(stage=>stage.key==='collections')?.evidence??'',/saldo pendiente/i);
  assert.equal(flow.stages.find(stage=>stage.key==='delivery')?.complete,false);
  assert.match(flow.description,/trabajo.*no.*finalizado/i);
  assert.doesNotMatch(flow.description,/99999|99,999|70/);
});
test('P2: only documented settled scope completes collections, never delivery',()=>{
  const source=file({quotes:[quote('approved',1,'Aprobado')],
    documents:[{scope_amount:100,scope_balance:0} as never]});
  const flow=workshopPipeline(source,job({active_estimate_id:'approved'}));
  assert.equal(flow.stages.find(stage=>stage.key==='collections')?.complete,true);
  assert.match(flow.stages.find(stage=>stage.key==='collections')?.evidence??'',/sin saldo/i);
  assert.equal(flow.stages.find(stage=>stage.key==='delivery')?.complete,false);
  assert.equal(flow.current,'collections');
  for(const documents of [[],[{scope_amount:20,scope_balance:0} as never],
    [{scope_amount:100,scope_balance:undefined} as never]]){
    const incomplete=workshopPipeline(file({quotes:source.quotes,documents,
      advances:[{available_amount:100} as never]}),job({active_estimate_id:'approved'}));
    assert.equal(incomplete.stages.find(stage=>stage.key==='collections')?.complete,false);
  }
});
test('P2: delivered debt remains an outstanding collections fact rather than all circles complete',()=>{
  const flow=workshopPipeline(file({quotes:[quote('approved',1,'Aprobado')],
    documents:[{scope_amount:100,scope_balance:70} as never]}),job({active_estimate_id:'approved',status:'Entregado'}));
  assert.equal(flow.current,null);
  assert.equal(flow.stages.find(stage=>stage.key==='delivery')?.complete,true);
  assert.equal(flow.stages.find(stage=>stage.key==='collections')?.complete,false);
  assert.match(flow.stages.find(stage=>stage.key==='collections')?.evidence??'',/saldo pendiente/i);
});
test('P2: financial evidence respects both current permission and the case access flag',()=>{
  const source=file({quotes:[quote('approved',1,'Aprobado')],
    documents:[{scope_amount:100,scope_balance:70} as never]});
  for(const [financialAccess,allowed] of [[false,true],[true,false]]){
    const flow=workshopPipeline({...source,financialAccess},job({active_estimate_id:'approved'}),allowed);
    assert.notEqual(flow.current,'collections');
    assert.equal(flow.stages.find(stage=>stage.key==='collections')?.complete,false);
    assert.match(flow.stages.find(stage=>stage.key==='collections')?.evidence??'',/restringida/i);
    assert.doesNotMatch(JSON.stringify(flow.stages),/saldo pendiente|sin saldo|99999|\$70/);
  }
});
test('P2: a newer pending or rejected revision still takes precedence over the collections recommendation',()=>{
  for(const status of ['Borrador','Rechazado']){
    const flow=workshopPipeline(file({quotes:[quote('approved',1,'Aprobado'),quote('new',2,status)],
      documents:[{scope_amount:100,scope_balance:70} as never]}),job({active_estimate_id:'approved'}));
    assert.equal(flow.current,'approval');
    assert.match(flow.stages.find(stage=>stage.key==='collections')?.evidence??'',/saldo pendiente/i);
  }
});
test('Money keeps cost, price, cash, scoped collections and advances distinct without header fallback',()=>{
  const summary=workshopMoney(file({quotes:[quote('q',1,'Borrador')],
    costs:[{amount:40} as never],expenses:[{amount:9999,scope_amount:15} as never,{amount:8888,shared:true} as never],
    documents:[{amount:9999,scope_amount:100,scope_balance:70} as never],
    applications:[{kind:'Aplicacion',scope_amount:35} as never,{kind:'Reversion',scope_amount:5} as never],
    payments:[{amount:9000} as never],advances:[{amount:8000,available_amount:7} as never]}),'OT-1');
  assert.deepEqual([summary.costs,summary.quoted,summary.cashOut,summary.charged,summary.paid,summary.balance,summary.advances],
    [40,100,15,100,30,70,7]);
});
test('All historical section URLs remain navigation aliases',()=>{
  // Costos, Tareas and the removed stage name all land in the collections stage,
  // which is where the money of the shop and of the client now lives.
  for(const [legacy,current] of Object.entries({'Recepción':'diagnosis','Diagnóstico':'diagnosis',
    'Ingreso y diagnóstico':'diagnosis','Presupuestos':'budget','Costos y presupuesto':'budget',
    'Aprobación':'approval','Costos':'collections','Trabajo y costos reales':'collections',
    'Tareas':'tasks','Cargos y abonos':'collections','Cobros':'collections',
    'Salida':'delivery','Entrega':'delivery','Fotos y documentos':'documents'})){
    assert.equal(workshopSection(legacy),current);
  }
  assert.equal(workshopSection('Costos previstos y presupuesto'),'budget');
  // The removed stage key is no longer a section value.
  assert.equal(workshopSection('work'),'summary');
});
test('Order composition preserves the permanent dossier dispatcher and sanitizes file slots',()=>{
  const source=readFileSync('src/components/templates/vehicle-case-screen.tsx','utf8');
  assert.match(source,/if\(scope==='vehicle'\)return <VehicleDossier/);
  assert.match(source,/<WorkshopCaseScreen/);
  assert.match(source,/filesSlot={<CaseFiles file={sanitizedDossierFile\(file,can\('expenses.read'\)\)/);
});
test('Workshop labels are opt-in for shared payments and finance gates use current permissions',()=>{
  const payments=readFileSync('src/components/organisms/case-payments.tsx','utf8');
  assert.match(payments,/workshopContext=false/);
  assert.match(payments,/can\('expenses.read'\)/);
  const screen=readFileSync('src/components/templates/workshop-case-screen.tsx','utf8');
  assert.match(screen,/file.financialAccess&&can\('expenses.read'\)/);
  assert.match(screen,/<WorkshopDeliveryReview/);
  assert.match(screen,/<WorkshopCollections[^>]*job=\{job\}/);
  const collections=readFileSync('src/components/organisms/case-payments.tsx','utf8');
  assert.match(collections,/workshopContext\?<WorkshopCollections \{\.\.\.props\}\/>/);});
