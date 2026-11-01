import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';

if(!readFileSync('supabase/config.toml','utf8').includes('project_id = "aj-rentacar"'))throw new Error('AJ local project required.');
const email=readFileSync('.env.local','utf8').match(/^AJ_LOCAL_OWNER_EMAIL=(.+)$/m)?.[1].trim();
if(!email||!/^owner-[a-f\d]+@aj\.local$/.test(email))throw new Error('Local owner required.');
const sql=input=>execFileSync('docker',['exec','-i','supabase_db_aj-rentacar','psql','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'],
  {input,encoding:'utf8',timeout:60000,maxBuffer:10000000,stdio:['pipe','pipe','pipe']}).trim();
const snapshot=`select jsonb_build_object(
 'users',(select count(*) from auth.users),'customers',(select count(*) from public.customers),
 'vehicles',(select count(*) from public.vehicles),'orders',(select count(*) from public.work_orders),
 'quotes',(select count(*) from public.estimate_versions),'books',(select count(*) from public.source_workbooks),
 'finance',(select count(*) from public.customer_payments)+(select count(*) from public.billing_documents)+(select count(*) from public.expenses),
 'audit',(select count(*) from public.audit_events),
 'originals',(select md5(jsonb_agg(jsonb_build_object('id',workbook_id,'hash',encode(sha256(content),'hex')) order by workbook_id)::text) from private.source_workbook_bytes),
 'registry',(select md5(jsonb_agg(to_jsonb(c) order by id)::text) from public.customers c),
 'vehicleFacts',(select md5(jsonb_agg(to_jsonb(v) order by id)::text) from public.vehicles v),
 'quoteFacts',(select md5(jsonb_agg(to_jsonb(q) order by id)::text) from public.estimate_versions q));`;
const before=JSON.parse(sql(snapshot));
sql(`begin;
select set_config('request.jwt.claim.sub',(select id::text from auth.users where email='${email}'),true);
set local role authenticated;
do $$declare original public.estimate_versions;job public.work_orders;payload jsonb;result jsonb;retry jsonb;file jsonb;
  key uuid:=gen_random_uuid();contact public.customers;registered public.vehicles;begin
  select * into original from public.estimate_versions where source_reference<>'' order by created_at limit 1;
  if original.id is null or (original.snapshot->>'total')::numeric<>2190 then raise exception 'REAL_QUOTE_MISSING';end if;
  select * into job from public.work_orders where id=original.order_id;
  payload:=jsonb_build_object('orderId',job.id,'parentId',original.id,'reason','Transcription verification; transaction will roll back',
    'discount','0','lines',original.snapshot->'lines');
  result:=public.save_workshop_quote(payload,key);retry:=public.save_workshop_quote(payload,key);
  if result<>retry or (result->>'revision')::integer<>original.revision+1 or (result->'snapshot'->>'total')::numeric<>2190
    then raise exception 'LIVE_QUOTE_REPLAY_FAILED';end if;
  file:=public.vehicle_case_file(job.vehicle_id,job.id);
  if jsonb_array_length(file->'quotes')<2 or jsonb_array_length(file->'documents')<>0 or jsonb_array_length(file->'payments')<>0
    or jsonb_array_length(file->'inspections')<>0 or jsonb_array_length(file->'commitments')<>0
    then raise exception 'QUOTE_CREATED_UNEXPECTED_FINANCIAL_OR_PHYSICAL_EVENT';end if;
  select * into contact from public.customers where id=job.customer_id;
  result:=public.save_registry_details('customer',jsonb_build_object('id',contact.id,'expectedVersion',contact.version,
    'name',contact.name,'phone',contact.phone,'email',contact.email,'document',contact.document,
    'reason','Verify same known facts; transaction will roll back'),gen_random_uuid());
  if (result->>'version')::integer<>contact.version+1 then raise exception 'LIVE_DETAILS_VERSION_FAILED';end if;
  result:=public.execute_command('create_vehicle',jsonb_build_object('plate','','brand',original.vehicle_snapshot->>'brand',
    'model',original.vehicle_snapshot->>'model','year',original.vehicle_snapshot->'year','category','SUV','color','',
    'daily',0,'km',0,'ownership','Por confirmar','inRentalFleet',false,'initialStatus','Por confirmar',
    'unverifiedFields',jsonb_build_array('plate','color','daily','km','ownership','status')),gen_random_uuid());
  select * into registered from public.vehicles where id=(result->>'id')::uuid;
  if registered.status<>'Por confirmar' or not ('km'=any(registered.unverified_fields))
    or not ('daily'=any(registered.unverified_fields)) then raise exception 'LIVE_UNKNOWN_FACTS_REGISTRATION_FAILED';end if;
  if has_function_privilege('anon','public.save_workshop_quote(jsonb,uuid)','EXECUTE')
    or has_function_privilege('anon','public.save_registry_details(text,jsonb,uuid)','EXECUTE')
    then raise exception 'ANONYMOUS_WRITE_EXPOSED';end if;
end $$;
rollback;`);
const after=JSON.parse(sql(snapshot));
if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Verification changed the real workspace.');
const manifest={verifiedAt:new Date().toISOString(),quoteRpc:true,replay:true,caseLinks:true,registryCorrection:true,unknownFactRegistration:true,
  anonymousDenied:true,transactionRolledBack:true,noFixtureRecords:true,workspaceUnchanged:true,counts:after};
const path='test-results/real-workspace-verification-'+Date.now()+'.json';
writeFileSync(path,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({passed:true,quoteRpc:true,replay:true,caseLinks:true,registryCorrection:true,unknownFactRegistration:true,workspaceUnchanged:true,manifest:path}));
