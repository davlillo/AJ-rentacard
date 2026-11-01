import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,statSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';

const container='supabase_db_aj-rentacar';
if(!readFileSync('supabase/config.toml','utf8').includes('project_id = "aj-rentacar"'))throw new Error('AJ local project required.');
const backupIndex=process.argv.indexOf('--backup');
if(backupIndex<0)throw new Error('Supply --backup <verified database.dump>. Default mode is inspection only.');
const backup=resolve(process.argv[backupIndex+1]);
const rehearsal=process.argv.includes('--verify-rollback');
const manifestPath=join(dirname(backup),'cleanup-manifest.json');
if(process.argv.includes('--apply')&&existsSync(manifestPath))throw new Error('This cleanup was already applied.');
if(!backup.startsWith(resolve('test-results')+'\\')&&!backup.startsWith(resolve('test-results')+'/'))throw new Error('Private test-results backup required.');
const bytes=readFileSync(backup);
if(bytes.subarray(0,5).toString()!=='PGDMP'||statSync(backup).size<10000)throw new Error('Invalid database backup.');
const archive=execFileSync('docker',['exec','-i',container,'pg_restore','--list'],{input:bytes,encoding:'utf8',maxBuffer:10000000});
if(!archive.includes('TABLE DATA public customers')||!archive.includes('TABLE DATA private source_workbook_bytes'))throw new Error('Incomplete backup.');
function sql(query){return execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'],
  {input:query,encoding:'utf8',timeout:60000,maxBuffer:10000000,stdio:['pipe','pipe','pipe']}).trim();}

// Deliberately excludes auth, roles, catalogs, migration backups, audit history and source workbooks.
// No CASCADE, database reset, trigger disabling or schema deletion is permitted here.
const tables=['billing_application_lines','billing_credit_lines','billing_credits','payment_refunds','payment_applications',
  'billing_document_lines','rental_periods','billing_documents','customer_payments','payment_import_origins','payment_imports',
  'expense_import_origins','expense_import_rows','expense_imports','expenses','cost_allocations','workshop_costs',
  'task_time_spans','task_timers','workshop_tasks','workshop_deliveries','workshop_inspections','vehicle_files',
  'commission_entries','commission_bindings','commission_eligibility','contract_acceptances','rental_contracts',
  'rental_extra_proposals','rental_inspections','reservation_evidence','vehicle_commitments','reservations',
  'supplier_obligations','stock_movements','purchase_orders','stock_items','budget_purchase_links','budget_expense_links',
  'report_outbox','report_schedules','agent_expense_proposals','integration_inbox','estimate_documents','estimate_approvals',
  'estimate_versions','work_orders','customer_aliases','vehicles','customers','cash_entries'].map(name=>'public.'+name)
  .concat(['private.contract_files','private.estimate_document_files','private.expense_import_files',
    'private.payment_import_files','private.vehicle_file_bytes','private.command_results']);
const protectedQuery=`select jsonb_build_object(
 'users',(select md5(coalesce(jsonb_agg(to_jsonb(u) order by id)::text,'')) from auth.users u),
 'roles',(select md5(coalesce(jsonb_agg(to_jsonb(r) order by user_id,role)::text,'')) from public.user_roles r),
 'books',(select md5(coalesce(jsonb_agg(to_jsonb(b) order by id)::text,'')) from public.source_workbooks b),
 'items',(select md5(coalesce(jsonb_agg(to_jsonb(i) order by id)::text,'')) from public.source_workbook_items i),
 'originals',(select md5(coalesce(jsonb_agg(to_jsonb(b) order by workbook_id)::text,'')) from private.source_workbook_bytes b),
 'centers',(select md5(coalesce(jsonb_agg(to_jsonb(c) order by id)::text,'')) from public.cost_centers c),
 'tariffs',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.workshop_tariffs t),
 'rules',(select md5(coalesce(jsonb_agg(to_jsonb(r) order by id)::text,'')) from public.commission_rules r));`;
const before=JSON.parse(sql(protectedQuery));
const counts=Object.fromEntries(tables.map(table=>[table,Number(sql(`select count(*) from ${table};`))]));
const guards=`
if exists(select 1 from public.customers where name !~ '^(Acceptance |Survivor |Case HTTP |Control HTTP |Rental HTTP |Review HTTP |Browser acceptance |Grouped HTTP )')
 or exists(select 1 from public.vehicles where plate !~ '^(TEST-|CASE-HTTP-|CTRL-|REV-COST-|REV-RENT-|RENT-|FLEET-|CLIENT-|GROUP-|CCF-HTTP-)')
 or exists(select 1 from public.work_orders where service !~ '^(HTTP acceptance|Synthetic Excel acceptance|Source-grounded assistant HTTP|Review linked payment|Browser workbook acceptance )')
 or exists(select 1 from public.stock_items where name<>'Synthetic brake pad')
 or exists(select 1 from public.integration_inbox where source<>'local-test-adapter')
 or exists(select 1 from public.source_workbook_items where status<>'Pendiente')
 then raise exception 'NON_TEST_OR_REVIEWED_RECORD_FOUND';end if;`;
sql(`do $$begin ${guards} end$$;`);
const manifest={backup,protected:before,counts,applied:false};
if(!process.argv.includes('--apply')&&!rehearsal){console.log(JSON.stringify({mode:'inspection',...manifest},null,2));process.exit(0);}
const values=readFileSync('.env.local','utf8');
const email=values.match(/^AJ_LOCAL_OWNER_EMAIL=(.+)$/m)?.[1].trim();
if(!email||!/^owner-[a-f\d]+@aj\.local$/.test(email))throw new Error('Generated local owner required.');
const owner=sql(`select id from auth.users where email='${email}';`);
if(!/^[a-f\d-]{36}$/.test(owner))throw new Error('Local owner not found.');
const checks=Object.entries(counts).map(([table,count])=>`if (select count(*) from ${table})<>${count} then raise exception 'WORKSPACE_CHANGED';end if;`).join('\n');
const expected=JSON.stringify(before).replaceAll("'","''");
sql(`begin;
set local lock_timeout='10s';
select pg_advisory_xact_lock(6192,1);
lock table ${tables.join(',')} in access exclusive mode;
do $$begin ${guards} ${checks} end$$;
truncate table ${tables.join(',')} continue identity restrict;
do $$declare after_state jsonb;begin
 select * into after_state from (${protectedQuery.replace(/;$/,'')}) preserved;
 if after_state<>'${expected}'::jsonb then raise exception 'PRESERVED_DATA_CHANGED';end if;
end$$;
insert into public.audit_events(actor,entity,entity_id,action,after_data)
values('${owner}','workspace','generated-test-records','CLEAN_TEST_DATA',jsonb_build_object('backup',${"'"+backup.replaceAll("'","''")+"'"},'tables',${"'"+JSON.stringify(counts)+"'"}::jsonb));
${rehearsal?'rollback':'commit'};`);
const after=JSON.parse(sql(protectedQuery));
if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Post-cleanup protected-data mismatch.');
if(rehearsal){
  for(const [table,count] of Object.entries(counts))if(Number(sql(`select count(*) from ${table};`))!==count)throw new Error('Rollback did not restore '+table);
  console.log(JSON.stringify({mode:'rollback-verified',tables:tables.length,protectedDataUnchanged:true}));process.exit(0);
}
manifest.applied=true;manifest.completedAt=new Date().toISOString();
writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({mode:'applied',removed:Object.values(counts).reduce((a,b)=>a+b,0),preserved:'users, roles, configuration, audit history and four original workbooks',manifest:manifestPath}));
