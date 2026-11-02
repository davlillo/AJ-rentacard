import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

if(!readFileSync('supabase/config.toml','utf8').includes('project_id = "aj-rentacar"'))throw new Error('AJ local project required.');
const actorEmail=readFileSync('.env.local','utf8').match(/^AJ_LOCAL_OWNER_EMAIL=(.+)$/m)?.[1].trim();
if(!actorEmail||!/^owner-[a-f\d]+@aj\.local$/.test(actorEmail))throw new Error('Local owner required.');
const sql=input=>execFileSync('docker',['exec','-i','supabase_db_aj-rentacar','psql','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'],
  {input,encoding:'utf8',timeout:60000,maxBuffer:10000000,stdio:['pipe','pipe','pipe']}).trim();
const rows=JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) order by id),'[]') from public.vehicles v
  where in_rental_fleet and status='Por confirmar' and source_workbook_id is not null
  and not exists(select 1 from public.vehicle_commitments c where c.vehicle_id=v.id and c.active and c.ends_at>now());`));
if(!rows.length){console.log(JSON.stringify({alreadyConfirmed:true,changed:0}));process.exit(0);}
if(rows.length!==27)throw new Error('Source fleet changed; review the current records before confirming availability.');
const apply=process.argv.includes('--apply');let backup;
if(apply){
  const bytes=execFileSync('docker',['exec','supabase_db_aj-rentacar','pg_dump','-U','postgres','-d','postgres','-Fc'],{timeout:120000,maxBuffer:100000000,stdio:['ignore','pipe','pipe']});
  if(bytes.subarray(0,5).toString()!=='PGDMP')throw new Error('Backup header invalid.');
  execFileSync('docker',['exec','-i','supabase_db_aj-rentacar','pg_restore','--list'],{input:bytes,timeout:30000,maxBuffer:10000000,stdio:['pipe','pipe','pipe']});
  backup='test-results/before-availability-'+Date.now()+'.dump';writeFileSync(backup,bytes,{flag:'wx',mode:0o600});
  writeFileSync(backup+'.json',JSON.stringify({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},null,2),{flag:'wx',mode:0o600});
}
const ids=rows.map(r=>r.id);const encoded=JSON.stringify(rows).replaceAll("'","''");
sql(`begin;
select set_config('request.jwt.claim.sub',(select id::text from auth.users where email='${actorEmail}'),true);
set local role authenticated;
do $$declare item jsonb;begin
  for item in select value from jsonb_array_elements('${encoded}'::jsonb) loop
    perform public.save_registry_details('vehicle',jsonb_build_object('id',item->>'id','expectedVersion',item->'version',
      'status','Disponible','reason','Disponibilidad inicial de los 27 vehículos de flota confirmada expresamente por el usuario el 1 de noviembre de 2026. Kilometraje, tarifa y propiedad permanecen pendientes.'),gen_random_uuid());
  end loop;
end $$;
${apply?'commit':'rollback'};`);
const result={verifiedAt:new Date().toISOString(),mode:apply?'applied':'rollback-verified',changed:27,vehicleIds:ids,backup,
  noFinancialPostings:true,odometerRatesAndOwnershipNotInvented:true};
if(apply)writeFileSync('test-results/availability-confirmation-'+Date.now()+'.json',JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({mode:result.mode,changed:27,backup,noFinancialPostings:true}));
