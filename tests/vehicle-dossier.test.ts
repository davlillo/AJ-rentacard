import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  dossierSection,dossierMoney,dossierLedger,dossierFiles,documentChecklist,
  rentalRows,workshopRows,dossierDate,dossierChartOption,sanitizedDossierFile,dossierRentalScope,
} from '../src/controladores/vehicle-dossier';
import type {CaseFile} from '../src/lib/supabase/cases';
import type {Reservation} from '../src/lib/supabase/reservations';

const fixture=()=>({
  vehicle:{id:'vehicle'},financialAccess:true,orders:[],reservations:[],commitments:[],inspections:[],files:[],
  documents:[{id:'group',grouped:true,amount:9000,scope_amount:120,scope_balance:47,issued_on:'2026-11-14',description:'Grouped'}],
  applications:[
    {id:'apply',document_id:'group',kind:'Aplicacion',amount:1000,scope_amount:80,effective_on:'2026-11-15'},
    {id:'reverse',document_id:'group',kind:'Reversion',amount:100,scope_amount:5,effective_on:'2026-11-16'}],
  expenses:[{id:'shared',amount:800,scope_amount:20,shared:true,date:'2026-11-17',concept:'Scoped expense'}],
  costs:[{amount:800}],payments:[{amount:7000}],advances:[{available_amount:5000}],
  quotes:[{revision:1,snapshot:{total:9999}}],
}) as unknown as CaseFile;

test('S2/S5 canonical scoped totals do not double count quotes, costs, receipts or advances; balance stays server-owned',()=>{
  assert.deepEqual(dossierMoney(fixture(),true),{charged:120,paid:75,balance:47,expenses:20});
  const rows=dossierLedger(fixture(),true)!;
  assert.deepEqual(rows.map(row=>[row.kind,row.amount,row.date]),[
    ['Egreso',20,'2026-11-17'],['Reversión',-5,'2026-11-16'],
    ['Abono',80,'2026-11-15'],['Cargo',120,'2026-11-14'],
  ]);
  assert.equal(rows.find(row=>row.kind==='Cargo')?.origin,'Documento agrupado');
  assert.equal(rows.find(row=>row.kind==='Abono')?.origin,'Documento agrupado');
  assert.equal(rows.length,4); // No invented dated credit or refund from the balance difference.
});

test('S5/S6 the rental scope of the dossier reads the canonical rental model',()=>{
  const file=fixture();
  file.documents=[];file.applications=[];
  const booking={id:'rental',total:80,open_ended:false} as unknown as Reservation;
  file.reservations=[booking];
  // Nothing was issued: the agreed amount is what the customer still owes.
  assert.deepEqual(dossierRentalScope(file,booking,true),{agreed:80,pending:80});
  // An open ended rental has no agreed amount and takes the pending only from the issued documents.
  const open={...booking,open_ended:true,total:0} as unknown as Reservation;
  assert.deepEqual(dossierRentalScope(file,open,true),{agreed:null,pending:0});
  file.documents=[{id:'doc',scope_amount:80,scope_balance:30}] as never;
  file.applications=[{id:'app',kind:'Aplicacion',scope_amount:50}] as never;
  assert.deepEqual(dossierRentalScope(file,booking,true),{agreed:80,pending:30});
  // Without the current financial access there is no protected amount at all.
  file.financialAccess=false;
  assert.equal(dossierRentalScope(file,booking,true),null);
  assert.equal(dossierRentalScope(file,booking,false),null);
});

test('S2/S5 missing or malformed amounts and dates stay unknown, never silently zero',()=>{
  const file=fixture();file.documents![0].scope_amount=Number.NaN;
  assert.equal(dossierMoney(file,true)?.charged,null);
  assert.equal(dossierLedger(file,true)!.find(row=>row.kind==='Cargo')?.amount,null);
  assert.equal(dossierDate('bad'),'Sin fecha registrada');
  assert.equal(dossierDate(''),'Sin fecha registrada');
  assert.equal(dossierDate('infinity'),'Sin fecha final definida');
  assert.match(dossierDate('2026-11-14'),/14/);
  assert.equal(dossierDate('2026-02-31'),'Sin fecha registrada');
  assert.equal(dossierDate('0'),'Sin fecha registrada');
});

test('S5 shared expenses with a missing allocation never fall back to the full receipt',()=>{
  const file=fixture();
  delete file.expenses![0].scope_amount;
  assert.equal(dossierMoney(file,true)?.expenses,null);
  assert.equal(dossierLedger(file,true)!.find(row=>row.kind==='Egreso')?.amount,null);
});

test('S5/S6 cached financial totals, rows and file metadata fail closed under both permissions',()=>{
  const file=fixture();
  file.files=[
    {id:'public',purpose:'Vehículo',financial:false,name:'Vehicle'},
    {id:'private',purpose:'Soporte',financial:true,name:'Private receipt'},
  ] as CaseFile['files'];
  for(const highLevel of [false,true]){
    file.financialAccess=highLevel;
    assert.equal(dossierMoney(file,false),null);
    assert.equal(dossierLedger(file,false),null);
    assert.deepEqual(dossierFiles(file,false).map(row=>row.id),['public']);
  }
  file.financialAccess=false;
  assert.equal(dossierMoney(file,true),null);
  assert.equal(dossierLedger(file,true),null);
  assert.deepEqual(dossierFiles(file,true).map(row=>row.id),['public']);
  const sanitized=sanitizedDossierFile(file,true);
  for(const key of ['documents','applications','expenses','quotes','costs','allocations','payments','advances'] as const){
    assert.equal(sanitized[key],undefined);
  }
  assert.deepEqual(sanitized.files.map(row=>row.id),['public']);
  assert.equal(file.files.length,2); // Sanitization does not mutate the cached source.
});

test('S3/S4 history is one row per identity, preserving canceled/draft and unreceived workshop states',()=>{
  const file=fixture();
  file.reservations=[
    {id:'draft',status:'Borrador',rental_state:'Preparado',starts_at:'2026-11-14'},
    {id:'cancel',status:'Cancelada',rental_state:'Entregado',starts_at:'2026-11-13'},
    {id:'draft',status:'Borrador',rental_state:'Preparado',starts_at:'2026-11-14'},
  ] as CaseFile['reservations'];
  file.orders=[
    {id:'quote',status:'Presupuesto',occurred_at:'2026-11-14'},
    {id:'internal',status:'Entregado',internal_job:true,occurred_at:'2026-11-13'},
    {id:'quote',status:'Presupuesto',occurred_at:'2026-11-14'},
  ] as CaseFile['orders'];
  assert.equal(rentalRows(file).length,2);
  assert.deepEqual(rentalRows(file).map(row=>row.status),['Borrador','Cancelada']);
  assert.equal(workshopRows(file).length,2);
  assert.equal(workshopRows(file)[0].reception,'Sin recepción');
  assert.equal(workshopRows(file)[1].origin,'Interno');
});

test('S6 checklist classifies actual registered purposes only, without inferred legal requirements',()=>{
  const file=fixture();
  file.files=[
    {id:'1',purpose:'Vehículo',financial:false},
    {id:'2',purpose:'Ingreso',financial:false},
    {id:'3',purpose:'Salida',financial:false},
    {id:'4',purpose:'Soporte',financial:true},
  ] as CaseFile['files'];
  assert.deepEqual(documentChecklist(dossierFiles(file,false)).map(row=>[row.purpose,row.count]),[
    ['Vehículo',1],['Ingreso',1],['Salida',1],['Soporte',0],
  ]);
  assert.equal(documentChecklist([]).some(row=>row.count>0),false);
});

test('S7 exactly five canonical sections retain the legacy workshop Ingresos meaning',()=>{
  for(const [old,key] of [
    ['Ingresos','maintenance'],['Alquileres','rentals'],['Costos','financial'],
    ['Cargos y abonos','financial'],['Fotos y documentos','documents'],['Datos de flota','summary'],
    ['financial','financial'],['unknown','summary'],
  ])assert.equal(dossierSection(old),key);
});

test('S2 chart options use supported real bar series and safe text tooltips',()=>{
  const option=dossierChartOption([{name:'Borrador',value:2},{name:'Cancelada',value:1}]);
  assert.equal((option.series as {type:string}[])[0].type,'bar');
  assert.equal((option.tooltip as {renderMode:string}).renderMode,'richText');
  assert.deepEqual((option.series as {data:number[]}[])[0].data,[2,1]);
});

test('S1/S7 explicit vehicle dispatch leaves existing order reception, payments and delivery commands in place',()=>{
  const source=readFileSync('src/components/templates/vehicle-case-screen.tsx','utf8');
  const workshop=readFileSync('src/components/templates/workshop-case-screen.tsx','utf8');
  assert.match(source,/if\(scope==='vehicle'\)return <VehicleDossier/);
  assert.match(source,/const \[file,setFile\]=useState/);
  assert.match(source,/return <WorkshopCaseScreen/);
  assert.match(source,/receptionSlot=\{<CaseReception file=\{file\} orderId=\{job.id\}/);
  assert.match(workshop,/section==='collections'&&financial/);
  assert.match(workshop,/<WorkshopCollections file=\{file\} job=\{job\} onChange=\{onChange\}/);
  assert.match(workshop,/<WorkshopDeliveryReview orderId=\{job.id\}/);
  assert.match(source,/readRevision.current\+\+/);
});
