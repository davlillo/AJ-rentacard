import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseSourceWorkbook} from '../src/controladores/source-workbooks';
import {fleetSourceRows,humanName,sourceQuoteLines} from '../src/controladores/workbook-facts';

const names=['ejemplo calendario carros renta.xlsx','Ejemplo presupuesto taller.xlsx','Ejemplo cuadro cuentas por cobrar.xlsx'];
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const identity=(value:string)=>{
  const hash=createHash('sha256').update('aj-source-v1:'+value).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
};

export function realDataPlan(){
  const books=names.map(name=>{const bytes=readFileSync('docs/excels/'+name);
    const parsed=parseSourceWorkbook(name,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    return{...parsed,hash:createHash('sha256').update(bytes).digest('hex')};});
  const fleet=books[0];const budget=books[1];const debts=books[2];
  const customers=new Map<string,{id:string;name:string;type:string;references:string[]}>();
  function contact(raw:string,reference:string){
    if(!raw||raw==='NO DISPONIBLE')return;
    const name=humanName(raw),key=name.toLocaleLowerCase('es-SV');
    const customer=customers.get(key)??{id:identity('customer:'+key),name,
      type:/corpo\.|hermanos|distribuciones|distrubuciones|radiocom/i.test(raw)?'Empresa':'Personal',references:[]};
    customer.references.push(reference);customers.set(key,customer);
  }
  const vehicles=fleetSourceRows(fleet.sheets).filter(row=>row.plate).map(row=>{
    const match=row.description.match(/^(\S+)\s+(.+?)\s+(20\d{2})(?:\s+(.*))?$/);
    if(!match)throw new Error('Unrecognized source vehicle row '+row.row);
    contact(row.customer,`${fleet.fileName} · H${row.row}`);
    const tail=match[4]??'';const color=tail.replace(/\bHATCHBACK\b|\bSEDAN\b/gi,'').trim();
    return{id:identity('vehicle:'+row.plate),plate:row.plate,brand:humanName(match[1]),model:match[2],year:Number(match[3]),
      color:humanName(color),category:/pick/i.test(row.line)?'Pickup':/suv/i.test(row.line)?'SUV':'Sedán',
      holder:humanName(row.holder),line:row.line,hash:fleet.hash,reference:`${fleet.sheets[0].name}!C${row.row}:I${row.row}`,
      sourceRow:row.row};
  });
  for(const sheet of debts.sheets)for(const row of sheet.rows){
    const name=String(row.cells.find(cell=>cell.address==='A'+row.number)?.value??'').trim();
    // A vehicle nickname is not enough evidence to create a person called “Anita”.
    if(name&&!/NISSAN|ROGUE|^total/i.test(name))contact(name,`${debts.fileName} · A${row.number}`);
  }
  if(!budget.sheets.some(sheet=>sheet.rows.some(row=>row.cells.some(cell=>/RAFAEL VARGAS/.test(String(cell.value))))))
    throw new Error('Budget customer evidence missing.');
  contact('RAFAEL VARGAS',`${budget.fileName} · B53:B54`);
  const customer=customers.get('rafael vargas')!;
  const quoteLines=sourceQuoteLines(budget.sheets);
  if(vehicles.length!==27||quoteLines.length!==27||quoteLines.reduce((sum,line)=>sum+Number(line.unitPrice),0)!==2190)
    throw new Error('Source controls changed; review before importing.');
  return{books,customers:[...customers.values()],vehicles,budget:{hash:budget.hash,reference:`${budget.sheets[0].name}!E3:F49`,
    vehicleId:identity('budget-vehicle:'+budget.hash),customerId:customer.id,quoteId:identity('budget-quote:'+budget.hash),
    lines:quoteLines,totals:{initial:1856,additional:334,advanceNotPosted:750,balanceNotPosted:1440}}};
}

export function realDataSql(plan:ReturnType<typeof realDataPlan>,actor:string,commit=false):string{
  if(!/^[a-f\d-]{36}$/.test(actor))throw new Error('Invalid import actor.');
  const payload=literal(JSON.stringify({customers:plan.customers,vehicles:plan.vehicles,budget:plan.budget}));
  const hashes=literal(JSON.stringify(plan.books.map(book=>({hash:book.hash,name:book.fileName}))));
  return `begin;
set local lock_timeout='10s';
select pg_advisory_xact_lock(6192,1);
select set_config('request.jwt.claim.sub',${literal(actor)},true);
create temporary table real_import_input(payload jsonb,hashes jsonb) on commit drop;
insert into real_import_input values(${payload}::jsonb,${hashes}::jsonb);
do $import$ declare data jsonb:=(select payload from pg_temp.real_import_input);item jsonb;car uuid;book uuid;job text;line jsonb;lines jsonb:='[]';begin
  if not public.has_permission('expenses.write') or not public.has_permission('vehicles.write') then raise exception 'IMPORT_OWNER_REQUIRED';end if;
  for item in select value from jsonb_array_elements((select hashes from pg_temp.real_import_input)) loop
    if not exists(select 1 from public.source_workbooks b join private.source_workbook_bytes f on f.workbook_id=b.id
      where b.file_hash=item->>'hash' and b.file_name=item->>'name' and encode(sha256(f.content),'hex')=b.file_hash)
      then raise exception 'ORIGINAL_HASH_MISMATCH';end if;
  end loop;
  for item in select value from jsonb_array_elements(data->'customers') loop
    insert into public.customers(id,name,phone,type,source_reference)
    values((item->>'id')::uuid,item->>'name','',item->>'type',array_to_string(array(select jsonb_array_elements_text(item->'references')),'; '))
    on conflict(id) do nothing;
  end loop;
  for item in select value from jsonb_array_elements(data->'vehicles') loop
    select id into book from public.source_workbooks where file_hash=item->>'hash';
    insert into public.vehicles(id,plate,brand,model,year,category,color,daily,km,status,ownership,in_rental_fleet,registered_holder,commercial_line,
      unverified_fields,source_workbook_id,source_ref)
    values((item->>'id')::uuid,item->>'plate',item->>'brand',item->>'model',(item->>'year')::integer,item->>'category',item->>'color',0,0,
      'Por confirmar','Por confirmar',true,item->>'holder',item->>'line',array['daily','km','status','ownership']||case when item->>'color'='' then array['color'] else '{}'::text[] end,book,item->>'reference')
    on conflict(id) do nothing;
    update public.source_workbook_items set status='Vinculado',record_type='vehicle',record_id=item->>'id',
      reason='Identidad y titular del original. Propiedad, disponibilidad y fechas de alquiler sin confirmar.',
      version=version+1,reviewed_by=auth.uid(),reviewed_at=now()
      where workbook_id=book and (metadata->>'row')::integer=(item->>'sourceRow')::integer and status='Pendiente';
  end loop;
  select id into book from public.source_workbooks where file_hash=data->'budget'->>'hash';
  car:=(data->'budget'->>'vehicleId')::uuid;
  insert into public.vehicles(id,plate,brand,model,year,category,color,daily,km,status,ownership,in_rental_fleet,
    unverified_fields,source_workbook_id,source_ref)
  values(car,'','Nissan','Rogue',2018,'SUV','',0,0,'Por confirmar','Por confirmar',false,
    array['plate','color','daily','km','status','ownership'],book,'Hoja1!E3') on conflict(id) do nothing;
  if not exists(select 1 from public.estimate_versions where id=(data->'budget'->>'quoteId')::uuid) then
    insert into public.work_orders(vehicle_id,customer_id,internal_job,area,service,status,due,created_by)
    values(car,(data->'budget'->>'customerId')::uuid,false,'Pintura','Enderezado y pintura de la parte delantera y puerta izquierda',
      'Presupuesto',(now() at time zone 'America/El_Salvador')::date,auth.uid()) returning id into job;
    for line in select value from jsonb_array_elements(data->'budget'->'lines') loop
      lines:=lines||jsonb_build_array(line||jsonb_build_object('tariffId',null,'code','Libre','tariffRevision',0,
        'quantity',1,'unitPrice',(line->>'unitPrice')::numeric,'price',(line->>'unitPrice')::numeric,'cost',null));
    end loop;
    insert into public.estimate_versions(id,order_id,revision,snapshot,customer_snapshot,vehicle_snapshot,reason,created_by,source_reference,source_totals)
    values((data->'budget'->>'quoteId')::uuid,job,1,jsonb_build_object('policy','manual-before-tax-v1','currency','USD',
      'rounding','half-up-per-line-2-decimals','method','commercial','ratio',null,'lines',lines,'cost',0,'costComplete',false,
      'commercial',2190,'subtotal',2190,'discount',0,'total',2190,'margin',null,'marginPct',null),
      (select to_jsonb(c)-'phone_key'-'document_key' from public.customers c where c.id=(data->'budget'->>'customerId')::uuid),
      (select to_jsonb(v) from public.vehicles v where v.id=car),'Transcripción del presupuesto original; no acredita recepción, aprobación ni pagos.',
      auth.uid(),data->'budget'->>'reference',data->'budget'->'totals');
  end if;
  update public.source_workbook_items set status='Vinculado',record_type='quote',record_id=data->'budget'->>'quoteId',
    reason='Partida comercial transcrita al presupuesto. No es un cargo ni un pago.',version=version+1,reviewed_by=auth.uid(),reviewed_at=now()
    where workbook_id=book and status='Pendiente' and split_part(source_ref,':',1) in
      (select split_part(value->'source'->>'ref',':',1) from jsonb_array_elements(data->'budget'->'lines'));
end $import$;
${commit?'commit':'rollback'};`;
}

function main(){
  if(!readFileSync('supabase/config.toml','utf8').includes('project_id = "aj-rentacar"'))throw new Error('AJ local project required.');
  const sql=(input:string)=>execFileSync('docker',['exec','-i','supabase_db_aj-rentacar','psql','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'],
    {input,encoding:'utf8',timeout:60000,maxBuffer:10000000,stdio:['pipe','pipe','pipe']}).trim();
  const email=readFileSync('.env.local','utf8').match(/^AJ_LOCAL_OWNER_EMAIL=(.+)$/m)?.[1].trim();
  if(!email||!/^owner-[a-f\d]+@aj\.local$/.test(email))throw new Error('Local owner required.');
  const actor=sql(`select id from auth.users where email=${literal(email)};`);
  const plan=realDataPlan();const apply=process.argv.includes('--apply');
  sql(realDataSql(plan,actor,apply));
  console.log(JSON.stringify({mode:apply?'applied':'rollback-verified',customers:plan.customers.length,fleetVehicles:27,workshopVehicles:1,quotes:1,
    inventedFinancialPostings:0,originalsUnchanged:true}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
