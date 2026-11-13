import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {CASH,LABEL,ROOT,readJson,saveJson,seedLocalScenario} from './local-workspace/scenario.mjs';

export const API='http://127.0.0.1:55321';
export const DATABASE='postgres';
export const CONTAINER='supabase_db_aj-rentacar';
export const operationalTables=[
  'receipt_operation_contexts','billing_application_lines','billing_credit_lines','billing_credits',
  'payment_refunds','payment_applications','billing_document_lines','rental_periods','billing_documents',
  'customer_payments','payment_import_origins','payment_imports','expense_import_origins','expense_import_rows',
  'expense_imports','expenses','cost_allocations','workshop_costs','task_time_spans','task_timers',
  'workshop_tasks','workshop_deliveries','workshop_inspections','vehicle_files','commission_entries',
  'commission_bindings','commission_eligibility','contract_acceptances','rental_contracts',
  'rental_extra_proposals','rental_inspections','reservation_evidence','vehicle_commitments','reservations',
  'supplier_obligations','stock_movements','purchase_orders','stock_items','budget_purchase_links',
  'budget_expense_links','report_outbox','report_schedules','agent_expense_proposals','integration_inbox',
  'estimate_documents','estimate_approvals','estimate_versions','work_orders','customer_aliases','vehicles',
  'customers','cash_entries',
].map(name=>'public.'+name).concat([
  'private.contract_files','private.estimate_document_files','private.expense_import_files',
  'private.payment_import_files','private.vehicle_file_bytes','private.command_results',
]);
const planPath=`${ROOT}/replacement.json`;
const digest=value=>createHash('sha256').update(value).digest('hex');
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function docker(args,input,encoding='utf8'){
  return execFileSync('docker',args,{input,encoding,timeout:120000,maxBuffer:150000000,
    stdio:['pipe','pipe','pipe']});
}
function sql(query){
  return docker(['exec','-i',CONTAINER,'psql','-X','-U','postgres','-d',DATABASE,'-Atq',
    '-v','ON_ERROR_STOP=1'],"set statement_timeout='60s';\n"+query).trim();
}
export function assertLocalTarget(config){
  if(config.api!==API||config.database!==DATABASE||config.container!==CONTAINER)
    throw new Error('FIXED_LOCAL_AJ_TARGET_REQUIRED');
}
function configuration(){
  if(!readFileSync('supabase/config.toml','utf8').includes('project_id = "aj-rentacar"'))
    throw new Error('AJ_REPOSITORY_REQUIRED');
  const env=Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/)
    .filter(line=>line.includes('=')&&!line.startsWith('#'))
    .map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1).trim()]));
  assertLocalTarget({api:env.NEXT_PUBLIC_SUPABASE_URL,database:DATABASE,container:CONTAINER});
  if(env.NEXT_PUBLIC_DATA_SOURCE!=='supabase'||!/^owner-[a-f\d]+@aj\.local$/.test(env.AJ_LOCAL_OWNER_EMAIL??''))
    throw new Error('EXISTING_LOCAL_OWNER_REQUIRED');
  return env;
}
async function authenticate(env){
  const client=createClient(API,env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(30000)})},
  });
  const login=await client.auth.signInWithPassword({
    email:env.AJ_LOCAL_OWNER_EMAIL,password:env.AJ_LOCAL_OWNER_PASSWORD,
  });
  if(login.error||!login.data.user)throw new Error('EXISTING_LOCAL_OWNER_LOGIN_FAILED');
  return{client,owner:login.data.user.id};
}
function fileHashes(){
  return Object.fromEntries(['.env.local',...readdirSync('docs/excels').filter(file=>/\.xlsx$/i.test(file))
    .map(file=>'docs/excels/'+file)].map(path=>[path,digest(readFileSync(path))]));
}
function tableStateQuery(tables,projection=()=> 'to_jsonb(t)',where=()=> ''){
  if(tables.some(name=>! /^(public|private|auth)\.[a-z_][a-z_0-9]*$/.test(name)))
    throw new Error('INVALID_SNAPSHOT_IDENTIFIER');
  return `select jsonb_object_agg(name,jsonb_build_object('count',rows,'hash',hash)) from (
    ${tables.map(table=>`select ${literal(table)} name,count(*) rows,
      md5(coalesce(jsonb_agg(${projection(table)} order by (${projection(table)})::text)::text,'[]')) hash
      from ${table} t ${where(table)}`).join(' union all ')}) states`;
}
function protectedQuery(plan){
  return tableStateQuery(plan.protectedTables,table=>{
    if(table==='auth.users'||table==='auth.identities')return "to_jsonb(t)-'last_sign_in_at'-'updated_at'";
    if(table==='public.source_workbook_items')return "jsonb_build_object('id',t.id,'book',t.workbook_id,'ref',t.source_ref,'metadata',t.metadata)";
    return 'to_jsonb(t)';
  },table=>table==='public.audit_events'?`where t.created_at<=${literal(plan.auditCutoff)}::timestamptz`:'');
}
function snapshot(plan){
  return JSON.parse(sql(`begin read only;select jsonb_build_object(
    'operational',(${tableStateQuery(operationalTables)}),
    'protected',(${protectedQuery(plan)}),
    'sourceReviews',(${tableStateQuery(['public.source_workbook_items'])}));commit;`));
}
function validateBackup(metadata){
  assertLocalTarget(metadata);
  const path=resolve(metadata.backup);
  if(!path.startsWith(resolve(ROOT)+'/')&&!path.startsWith(resolve(ROOT)+'\\'))
    throw new Error('PRIVATE_LOCAL_BACKUP_REQUIRED');
  const bytes=readFileSync(path);
  if(bytes.subarray(0,5).toString()!=='PGDMP'||bytes.length<10000||digest(bytes)!==metadata.sha256)
    throw new Error('BACKUP_CHECKSUM_MISMATCH');
  const temporary=`/tmp/aj-local-restore-check-${randomUUID()}.dump`;
  try{
    docker(['cp',path,`${CONTAINER}:${temporary}`]);
    const list=docker(['exec',CONTAINER,'pg_restore','--list',temporary]);
    for(const required of ['TABLE DATA auth users','TABLE DATA public customers','TABLE DATA public vehicles',
      'TABLE DATA public source_workbooks','TABLE DATA private source_workbook_bytes'])
      if(!list.includes(required))throw new Error('INCOMPLETE_LOCAL_BACKUP');
    // Reading every archive entry also verifies compressed data, without executing restoration SQL.
    docker(['exec',CONTAINER,'pg_restore','--file=/dev/null',temporary]);
  }finally{docker(['exec',CONTAINER,'rm','-f','--',temporary]);}
}
async function prepare(env){
  if(existsSync(planPath))throw new Error('REPLACEMENT_ALREADY_PREPARED_USE_EXISTING_PLAN');
  const {owner}=await authenticate(env);
  prepareImages();
  if(sql("select count(*) from public.user_roles where role='technician';")<2)
    throw new Error('EXISTING_WORKSHOP_ASSIGNEES_REQUIRED');
  const tables=JSON.parse(sql(`begin read only;select jsonb_agg(schemaname||'.'||tablename order by 1)
    from pg_tables where schemaname in('public','private');commit;`));
  if(operationalTables.some(table=>!tables.includes(table)))throw new Error('LOCAL_SCHEMA_MISMATCH');
  const auditCutoff=sql('select clock_timestamp();');
  const plan={version:1,label:LABEL,id:randomUUID(),api:API,database:DATABASE,container:CONTAINER,
    owner,auditCutoff,protectedTables:tables.filter(table=>!operationalTables.includes(table))
      .concat(['auth.users','auth.identities']).sort(),files:fileHashes(),rehearsed:false,applied:false};
  plan.before=snapshot(plan);
  const backup=`${ROOT}/before-replacement-${Date.now()}.dump`;
  const bytes=docker(['exec',CONTAINER,'pg_dump','-U','postgres','-d',DATABASE,'-Fc'],undefined,null);
  // execFileSync defaults to binary output when encoding is null.
  writeFileSync(backup,bytes,{flag:'wx',mode:0o600});
  plan.backup=backup;plan.sha256=digest(bytes);plan.preparedAt=new Date().toISOString();
  validateBackup(plan);
  if(!equal(plan.before,snapshot(plan))||!equal(plan.files,fileHashes()))throw new Error('WORKSPACE_CHANGED_DURING_BACKUP');
  saveJson(planPath,plan);
  return{prepared:true,backup,operationalTables:operationalTables.length,
    before:{customers:plan.before.operational['public.customers'].count,
      vehicles:plan.before.operational['public.vehicles'].count,
      users:plan.before.protected['auth.users'].count}};
}
function loadPlan(){
  const plan=readJson(planPath);assertLocalTarget(plan);
  if(plan.label!==LABEL||plan.version!==1||! /^[a-f\d-]{36}$/.test(plan.id)||
    ! /^[a-f\d-]{36}$/.test(plan.owner)||!equal(plan.files,fileHashes()))throw new Error('LOCAL_PLAN_MISMATCH');
  return plan;
}
function appliedMarker(plan){
  return sql(`select count(*) from public.audit_events where entity='workspace'
    and entity_id=${literal(plan.id)} and action='REPLACE_LOCAL_RECORDS';`)==='1';
}
function cleanup(plan,rollback){
  const before=JSON.stringify(plan.before);
  const protectedBefore=JSON.stringify(plan.before.protected);
  const query=`begin;set local lock_timeout='15s';select pg_advisory_xact_lock(6192,1);
    lock table ${operationalTables.join(',')},public.source_workbook_items in access exclusive mode;
    select set_config('request.jwt.claim.sub',${literal(plan.owner)},true);
    do $$declare current_state jsonb;begin
      select jsonb_build_object('operational',(${tableStateQuery(operationalTables)}),
        'protected',(${protectedQuery(plan)}),
        'sourceReviews',(${tableStateQuery(['public.source_workbook_items'])})) into current_state;
      if current_state<>${literal(before)}::jsonb then raise exception 'WORKSPACE_CHANGED';end if;
      if exists(select 1 from public.source_workbook_items where record_id is not null
        and coalesce(record_type,'') not in('vehicle','quote','order','reservation','document','expense','receipt'))
        then raise exception 'UNRECOGNIZED_WORKBOOK_LINK';end if;
    end$$;
    update public.source_workbook_items set status='Excluido',record_type=null,record_id=null,proposal=null,
      reason='Vínculo retirado al reemplazar los registros operativos. Archivo original conservado.',
      version=version+1,reviewed_by=${literal(plan.owner)}::uuid,reviewed_at=now() where record_id is not null;
    truncate table ${operationalTables.join(',')} continue identity restrict;
    do $$begin
      if (${protectedQuery(plan)})<>${literal(protectedBefore)}::jsonb
        then raise exception 'PROTECTED_DATA_CHANGED';end if;
    end$$;
    insert into public.audit_events(actor,entity,entity_id,action,after_data)
      values(${literal(plan.owner)}::uuid,'workspace',${literal(plan.id)},'REPLACE_LOCAL_RECORDS',
        jsonb_build_object('backup',${literal(plan.backup)},'sha256',${literal(plan.sha256)},
          'previous',${literal(JSON.stringify(plan.before.operational))}::jsonb));
    ${rollback?'rollback':'commit'};`;
  sql(query);
  const after=snapshot(plan);
  if(!equal(plan.before.protected,after.protected)||!equal(plan.files,fileHashes()))
    throw new Error('PROTECTED_DATA_CHANGED');
  if(rollback&&!equal(plan.before,after))throw new Error('ROLLBACK_MISMATCH');
  if(!rollback&&Object.values(after.operational).some(table=>table.count!==0))throw new Error('CLEANUP_INCOMPLETE');
}
function prepareImages(){
  const python=process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python';
  const result=spawnSync(python,['-X','utf8','-B','scripts/local-workspace/images.py'],{
    encoding:'utf8',stdio:'pipe',timeout:30000,
  });
  if(result.status!==0)throw new Error('LOCAL_IMAGE_PREPARATION_FAILED');
}
async function verify(client,plan){
  const manifest=readJson(`${ROOT}/manifest.json`);
  if(manifest.replacementId!==plan.id||!appliedMarker(plan))throw new Error('LOCAL_MANIFEST_MISMATCH');
  const rows=async table=>{
    const result=await client.from(table).select('*');
    if(result.error)throw new Error('LOCAL_READ_FAILED '+table);return result.data;
  };
  const [cars,customers,reservations,jobs,files,tasks,charges,payments,applications,refunds,expenses]=
    await Promise.all(['vehicles','customers','reservations','work_orders','vehicle_files','workshop_tasks',
      'billing_documents','customer_payments','payment_applications','payment_refunds','expenses'].map(rows));
  const fleet=cars.filter(car=>car.in_rental_fleet);
  const reserved=fleet.filter(car=>car.status==='Disponible'&&reservations.some(r=>r.vehicle_id===car.id&&
    r.status==='Confirmada'&&r.rental_state==='Preparado'&&Date.parse(r.ends_at)>Date.now())).length;
  const counts={vehicles:cars.length,customers:customers.length,fleet:fleet.length,
    available:fleet.filter(car=>car.status==='Disponible').length-reserved,
    rented:fleet.filter(car=>car.status==='Alquilado').length,reserved,
    workshop:jobs.filter(job=>job.status!=='Entregado').length,
    closedFolios:jobs.filter(job=>job.status==='Entregado').length,
    completedRentals:reservations.filter(r=>r.rental_state==='Devuelto').length,
    reservations:reservations.length,vehicleImages:cars.filter(car=>files.some(file=>
      file.vehicle_id===car.id&&file.purpose==='Vehículo')).length,tasks:tasks.length};
  if(counts.vehicles!==7||counts.customers!==7||counts.closedFolios!==3||counts.completedRentals!==5||
    counts.reservations!==7||counts.vehicleImages!==7||
    ['fleet','available','rented','reserved','workshop'].some(key=>counts[key]!==manifest.expected[key]))
    throw new Error('LOCAL_DATASET_COUNT_MISMATCH '+JSON.stringify(counts));
  const diary=await client.rpc('cash_diary',{from_date:manifest.today,to_date:manifest.today,account_filter:CASH});
  const billing=await client.rpc('receivables_at',{cutoff:manifest.today});
  if(diary.error||billing.error)throw new Error('LOCAL_FINANCIAL_READ_FAILED');
  const advances=payments.reduce((sum,payment)=>sum+Number(payment.amount)-applications
    .filter(item=>item.payment_id===payment.id).reduce((sum,item)=>sum+
      (item.kind==='Aplicacion'?1:-1)*Number(item.amount),0)-refunds
    .filter(item=>item.payment_id===payment.id).reduce((sum,item)=>sum+Number(item.amount),0),0);
  const money={charges:charges.reduce((sum,item)=>sum+Number(item.amount),0),
    receipts:payments.reduce((sum,item)=>sum+Number(item.amount),0),
    expenses:expenses.reduce((sum,item)=>sum+Number(item.amount),0),
    balance:billing.data.reduce((sum,item)=>sum+Number(item.balance),0),advances,
    cashNet:diary.data.netMovement,cashBalance:diary.data.balanceAfter};
  for(const key of ['charges','receipts','expenses','balance','advances','cashNet'])
    if(money[key]!==manifest.expected[key])throw new Error('LOCAL_MONEY_MISMATCH '+key);
  if(money.cashBalance!==1478||payments.length!==9||expenses.length!==9)
    throw new Error('LOCAL_CASH_DUPLICATION_DETECTED');
  const after=snapshot(plan);
  if(!equal(plan.before.protected,after.protected)||!equal(plan.files,fileHashes()))
    throw new Error('PROTECTED_DATA_CHANGED');
  if(sql("select count(*) from public.source_workbook_items where record_id is not null;")!=='0')
    throw new Error('STALE_SOURCE_LINK');
  const report={passed:true,database:DATABASE,api:API,counts,money,protectedDataUnchanged:true,
    originalWorkbooks:plan.before.protected['public.source_workbooks'].count,
    users:plan.before.protected['auth.users'].count,checkedAt:new Date().toISOString()};
  saveJson(`${ROOT}/verification.json`,report);return report;
}
async function main(){
  const mode=process.argv[2]??'inspect';
  if(!['prepare','inspect','rehearse','apply','verify'].includes(mode))throw new Error('LOCAL_MODE_REQUIRED');
  const env=configuration();mkdirSync(ROOT,{recursive:true});
  if(mode==='prepare')return prepare(env);
  const plan=loadPlan();
  if(mode==='inspect')return{mode,applied:appliedMarker(plan),backup:plan.backup,before:plan.before.operational};
  if(mode==='verify')return verify((await authenticate(env)).client,plan);
  if(mode==='apply'&&!process.argv.includes('--confirm-local-replacement'))
    throw new Error('EXPLICIT_LOCAL_REPLACEMENT_CONFIRMATION_REQUIRED');
  validateBackup(plan);
  if(mode==='rehearse'){
    if(appliedMarker(plan))throw new Error('LOCAL_REPLACEMENT_ALREADY_APPLIED');
    cleanup(plan,true);plan.rehearsed=true;plan.rehearsedAt=new Date().toISOString();saveJson(planPath,plan);
    return{rollbackVerified:true,protectedDataUnchanged:true,tables:operationalTables.length};
  }
  if(!plan.rehearsed)throw new Error('ROLLBACK_REHEARSAL_REQUIRED');
  if(!appliedMarker(plan)){
    if(plan.applied)throw new Error('LOCAL_CLEANUP_MARKER_MISSING');
    cleanup(plan,false);
  }
  plan.applied=true;saveJson(planPath,plan);
  const {client,owner}=await authenticate(env);
  if(owner!==plan.owner)throw new Error('LOCAL_OWNER_CHANGED');
  const staff=JSON.parse(sql(`select jsonb_agg(id) from(select user_id id from public.user_roles
    where role='technician' order by user_id limit 2) candidates;`));
  if(!staff||staff.length!==2)throw new Error('EXISTING_WORKSHOP_ASSIGNEES_REQUIRED');
  prepareImages();await seedLocalScenario(client,{mechanic:staff[0],painter:staff[1]},plan.id);
  return verify(client,plan);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{
    mkdirSync(ROOT,{recursive:true});
    // API and SQL failures stay private; credentials are never printed or copied to a public environment.
    writeFileSync(`${ROOT}/last-error.txt`,String(error.message)+'\n',{mode:0o600});
    console.error('Local replacement stopped. Inspect test-results/local-workspace/last-error.txt; resume the existing plan.');
    process.exitCode=1;
  });
}
