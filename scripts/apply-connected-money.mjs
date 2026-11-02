import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';

const version='20261102000100';
const name='connected_money';
const container='supabase_db_aj-rentacar';
if(!readFileSync('supabase/config.toml','utf8').includes('project_id = "aj-rentacar"'))throw new Error('AJ local project required.');
const sql=input=>execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'],
  {input,encoding:'utf8',timeout:120000,maxBuffer:20000000,stdio:['pipe','pipe','pipe']}).trim();
const up=readFileSync(`supabase/migrations/${version}_${name}.sql`,'utf8');
const down=readFileSync(`supabase/rollback/${version}_${name}.sql`,'utf8');
const applied=sql(`select count(*) from supabase_migrations.schema_migrations where version='${version}';`)==='1';
if(applied){console.log(JSON.stringify({alreadyApplied:true,version}));process.exit(0);}
const tables=JSON.parse(sql("select jsonb_agg(tablename order by tablename) from pg_tables where schemaname='public';"));
if(tables.some(table=>!/^[a-z_][a-z_0-9]*$/.test(table)))throw new Error('Unexpected public table identifier.');
const snapshot=()=>JSON.parse(sql(`select jsonb_object_agg(name,jsonb_build_object('count',rows,'hash',hash)) from (${tables.map(table=>
  `select '${table}' name,count(*) rows,md5(coalesce(jsonb_agg(to_jsonb(t)-'linked_expense_id' order by (to_jsonb(t)-'linked_expense_id')::text)::text,'[]')) hash from public."${table}" t`
).join(' union all ')}) records;`));
const before=snapshot();
const probe=`
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='owner' limit 1),true);
set local role authenticated;
do $$declare customer jsonb;car jsonb;job jsonb;expense jsonb;receipt jsonb;quote jsonb;charge jsonb;file jsonb;diary jsonb;
  jobs jsonb:='[]';allocations jsonb:='[]';amounts numeric[]:=array[75,100,5];i integer;today date:=(now() at time zone 'America/El_Salvador')::date;
begin
  customer:=public.execute_command('create_customer',jsonb_build_object('name','Connected workflow verification (rolled back)','phone','','type','Personal'),gen_random_uuid());
  for i in 1..3 loop
    car:=public.execute_command('create_vehicle',jsonb_build_object('plate','VERIFY-'||i||'-'||substr(gen_random_uuid()::text,1,6),
      'brand','Test','model','Rollback verification','year',2026,'category','SUV','color','White','daily',0,'km',100,
      'ownership','Cliente','ownerCustomerId',customer->>'id','inRentalFleet',false),gen_random_uuid());
    job:=public.execute_command('receive_vehicle',jsonb_build_object('customerId',customer->>'id','vehicleId',car->>'id','area','Pintura','service','Rollback verification'),gen_random_uuid());
    jobs:=jobs||jsonb_build_array(job||jsonb_build_object('vehicleId',car->>'id'));
    allocations:=allocations||jsonb_build_array(jsonb_build_object('orderId',job->>'id','amount',amounts[i]));
  end loop;
  expense:=public.record_linked_expense(jsonb_build_object('date',today,'concept','One verified payment, rolled back','amount',180,
    'category','Verification','method','Efectivo','account','Verification only','allocations',allocations,'reason','Verify split without duplicate cash'),gen_random_uuid());
  file:=public.vehicle_case_file((jobs->0->>'vehicleId')::uuid,jobs->0->>'id');
  if (file->'expenses'->0->>'scope_amount')::numeric<>75 then raise exception 'NATIVE_SCOPE_CHECK_FAILED';end if;
  receipt:=public.record_linked_receipt(jsonb_build_object('customerId',customer->>'id','orderId',jobs->0->>'id','amount',200,
    'date',today,'method','Efectivo','account','Verification only','reference','Advance, rolled back'),gen_random_uuid());
  file:=public.vehicle_case_file((jobs->0->>'vehicleId')::uuid,jobs->0->>'id');
  if (file->'advances'->0->>'available_amount')::numeric<>200 then raise exception 'NATIVE_ADVANCE_CHECK_FAILED';end if;
  quote:=public.record_connected_quote(jsonb_build_object('orderId',jobs->0->>'id','reason','Verification only','lines',jsonb_build_array(
    jsonb_build_object('description','Verified work','kind','Trabajo','quantity',1,'unitPrice',500))),gen_random_uuid());
  perform public.execute_estimate_command('approve',jsonb_build_object('estimateId',quote->>'id','approverName','Verification only','evidence','Not a real agreement; transaction rolled back'),gen_random_uuid());
  charge:=public.execute_case_command('bill_scope',jsonb_build_object('orderId',jobs->0->>'id','date',today,'dueOn',today),gen_random_uuid());
  perform public.record_linked_receipt(jsonb_build_object('customerId',customer->>'id','orderId',jobs->0->>'id','documentId',charge->>'id',
    'paymentId',receipt->'receipt'->>'id','amount',100,'date',today),gen_random_uuid());
  diary:=public.cash_diary(today,today,'Verification only');
  if (diary->>'income')::numeric<>200 or (diary->>'outgoing')::numeric<>180 then raise exception 'NATIVE_CASH_CHECK_FAILED';end if;
end $$;
reset role;`;
// Exercise real PostgreSQL, then remove only these transient test effects using a savepoint.
sql(`begin;\n${up}\nsavepoint verification;\n${probe}\nrollback to savepoint verification;\n${down}\n${up}\nrollback;`);
if(JSON.stringify(snapshot())!==JSON.stringify(before))throw new Error('Rehearsal changed business data.');
if(!process.argv.includes('--apply')){console.log(JSON.stringify({mode:'rollback-verified',version,businessDataUnchanged:true}));process.exit(0);}
mkdirSync('test-results',{recursive:true});
const bytes=execFileSync('docker',['exec',container,'pg_dump','-U','postgres','-d','postgres','-Fc'],
  {timeout:120000,maxBuffer:150000000,stdio:['ignore','pipe','pipe']});
if(bytes.subarray(0,5).toString()!=='PGDMP')throw new Error('Invalid private archive header.');
execFileSync('docker',['exec','-i',container,'pg_restore','--list'],{input:bytes,timeout:30000,maxBuffer:20000000,stdio:['pipe','pipe','pipe']});
const backup=`test-results/before-connected-money-${Date.now()}.dump`;
writeFileSync(backup,bytes,{flag:'wx',mode:0o600});
writeFileSync(backup+'.json',JSON.stringify({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},null,2),{flag:'wx',mode:0o600});
const literal=up.replaceAll("'","''");
sql(`begin;\n${up}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','${name}',array['${literal}']);
notify pgrst,'reload schema';\ncommit;`);
const after=snapshot();
if(JSON.stringify(after)!==JSON.stringify(before))throw new Error('Migration changed existing business records; retain the archive and investigate.');
const result={mode:'applied',version,backup,businessDataUnchanged:true,verifiedAt:new Date().toISOString(),before,after};
writeFileSync(`test-results/connected-money-migration-${Date.now()}.json`,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({mode:result.mode,version,backup,businessDataUnchanged:true}));
