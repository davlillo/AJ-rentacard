-- Operational fit: one permanent vehicle, one case per workshop visit, explicit rental fleet.
-- Keep exact old definitions for unused-only development recovery, not live rollbacks.
create table private.oct30_functions(signature text primary key,definition text not null);
create table private.oct30_constraints(table_name text,constraint_name text,definition text,
  primary key(table_name,constraint_name));
create function private.capture_oct30_function(signature text) returns void language plpgsql set search_path='' as $$
begin
  insert into private.oct30_functions values(signature,pg_get_functiondef(signature::regprocedure)) on conflict do nothing;
end $$;
select private.capture_oct30_function('public.execute_command(text,jsonb,uuid)');
select private.capture_oct30_function('private.expense_to_workshop_cost()');
select private.capture_oct30_function('private.delivery_checklist(text)');

alter table public.vehicles add column in_rental_fleet boolean not null default false,
  add column registered_holder text not null default '',add column commercial_line text not null default '';
-- Preserve the old explicitly registered Propio inventory; later membership is an independent decision.
update public.vehicles set in_rental_fleet=true where ownership='Propio';
alter table public.work_orders add column internal_job boolean not null default false;
alter table public.work_orders alter column customer_id drop not null;
alter table public.work_orders add constraint case_customer_required check(internal_job or customer_id is not null);
alter table public.expenses add column vehicle_id uuid references public.vehicles,
  add column reservation_id uuid references public.reservations;
insert into private.oct30_constraints select 'expenses',conname,pg_get_constraintdef(oid)
  from pg_constraint where conrelid='public.expenses'::regclass and contype='c'
  and pg_get_constraintdef(oid) like '%num_nonnulls%';
do $$ declare c record;begin
  for c in select constraint_name from private.oct30_constraints where table_name='expenses' loop
    execute format('alter table public.expenses drop constraint %I',c.constraint_name);
  end loop;
end $$;
alter table public.expenses add constraint expense_one_destination
  check(num_nonnulls(operation_id,cost_center_id,vehicle_id,reservation_id)=1);
alter table public.billing_documents add column estimate_id uuid references public.estimate_versions;

create table public.workshop_inspections(
  id uuid primary key default gen_random_uuid(),order_id text not null unique references public.work_orders,
  km integer not null check(km>=0),fuel numeric(5,2) not null check(fuel between 0 and 100 and fuel::text<>'NaN'),
  condition text not null check(length(btrim(condition)) between 1 and 4000),accessories text not null,
  created_by uuid not null references auth.users,created_at timestamptz not null default now()
);
create table public.vehicle_files(
  id uuid primary key default gen_random_uuid(),vehicle_id uuid not null references public.vehicles,
  order_id text references public.work_orders,reservation_id uuid references public.reservations,
  name text not null check(length(btrim(name)) between 1 and 200),mime text not null,
  purpose text not null check(purpose in ('Vehículo','Ingreso','Salida','Soporte')),
  financial boolean not null default false,file_hash text not null,size integer not null check(size between 1 and 2097152),
  created_by uuid not null references auth.users,created_at timestamptz not null default now(),
  check(num_nonnulls(order_id,reservation_id)<=1)
);
create table private.vehicle_file_bytes(file_id uuid primary key references public.vehicle_files,content bytea not null);
create table public.cost_allocations(
  id uuid primary key default gen_random_uuid(),cost_id uuid not null references public.workshop_costs,
  estimate_id uuid references public.estimate_versions,line_index integer check(line_index>=0),
  description text not null check(length(btrim(description)) between 1 and 2000),
  amount numeric(14,2) not null check(amount>0 and amount::text not in ('NaN','Infinity')),
  active boolean not null default true,reason text not null check(length(btrim(reason))>0),
  created_by uuid not null references auth.users,created_at timestamptz not null default now()
);
do $$ declare tbl text;begin
  foreach tbl in array array['workshop_inspections','vehicle_files','cost_allocations'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from anon,authenticated',tbl);
    execute format('grant select on public.%I to authenticated',tbl);
    execute format('create trigger case_audit after insert or update on public.%I for each row execute function private.audit_change()',tbl);
  end loop;
end $$;
create policy intake_read on public.workshop_inspections for select to authenticated using(public.has_permission('orders.read'));
create policy vehicle_file_read on public.vehicle_files for select to authenticated
  using(public.has_permission('vehicles.read') and (not financial or public.has_permission('expenses.read')));
create policy allocation_read on public.cost_allocations for select to authenticated using(public.has_permission('expenses.read'));
create trigger intake_immutable before update or delete on public.workshop_inspections for each row execute function private.immutable_quote_record();
create trigger vehicle_file_immutable before update or delete on public.vehicle_files for each row execute function private.immutable_quote_record();

alter function public.execute_command(text,jsonb,uuid) set schema private;
alter function private.execute_command(text,jsonb,uuid) rename to business_command_before_cases;
revoke all on function private.business_command_before_cases(text,jsonb,uuid) from public,anon,authenticated;
create function public.execute_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;result jsonb;car public.vehicles;request jsonb:=jsonb_build_object('command',command,'payload',payload);
  entity text;booking public.reservations;
begin
  if not public.has_permission(case when command='record_expense' then 'expenses.write' when command='receive_vehicle' then 'orders.write' else 'vehicles.write' end)
    and command in ('create_vehicle','receive_vehicle','record_expense') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='record_expense' and num_nonnulls(payload->>'vehicleId',payload->>'reservationId')>0 then
    if (payload->>'amount')::numeric<>round((payload->>'amount')::numeric,2)
      or not isfinite((payload->>'date')::date) then raise exception 'INVALID_EXPENSE';end if;
    if num_nonnulls(payload->>'vehicleId',payload->>'reservationId',payload->>'operationId',payload->>'costCenterId')<>1 then raise exception 'EXACTLY_ONE_DESTINATION';end if;
    if payload->>'reservationId' is not null then
      select * into booking from public.reservations where id=(payload->>'reservationId')::uuid;
      if booking.id is null then raise exception 'RESERVATION_NOT_FOUND';end if;
    end if;
    insert into public.expenses(date,concept,category,amount,method,account,vehicle_id,reservation_id,support,created_by)
    values((payload->>'date')::date,btrim(payload->>'concept'),btrim(payload->>'category'),(payload->>'amount')::numeric,
      payload->>'method',btrim(payload->>'account'),(payload->>'vehicleId')::uuid,booking.id,coalesce(payload->>'support',''),auth.uid()) returning id into entity;
    result:=jsonb_build_object('id',entity,'command',command,'createdAt',now());
  elsif command='receive_vehicle' and coalesce((payload->>'internalJob')::boolean,false) then
    select * into car from public.vehicles where id=(payload->>'vehicleId')::uuid for update;
    if car.id is null or not car.in_rental_fleet or car.status<>'Disponible' then raise exception 'INTERNAL_FLEET_VEHICLE_REQUIRED';end if;
    insert into public.work_orders(vehicle_id,customer_id,internal_job,area,service,due,created_by)
    values(car.id,null,true,payload->>'area',btrim(payload->>'service'),
      coalesce((payload->>'due')::date,(now() at time zone 'America/El_Salvador')::date),auth.uid()) returning id into entity;
    update public.vehicles set status='En taller',version=version+1 where id=car.id;
    result:=jsonb_build_object('id',entity,'command',command,'createdAt',now());
  else
    result:=private.business_command_before_cases(command,payload,idempotency_key);
    if command='create_vehicle' then
      update public.vehicles set in_rental_fleet=coalesce((payload->>'inRentalFleet')::boolean,ownership='Propio'),
        registered_holder=coalesce(btrim(payload->>'registeredHolder'),''),commercial_line=coalesce(btrim(payload->>'commercialLine'),'')
        where id=(result->>'id')::uuid;
    end if;
    return result;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;
revoke all on function public.execute_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_command(text,jsonb,uuid) to authenticated;

create function public.execute_case_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','case.'||command,'payload',payload);
  car public.vehicles;job public.work_orders;cost public.workshop_costs;quote public.estimate_versions;parent public.estimate_versions;
  row jsonb;lines jsonb:='[]';result jsonb;total numeric:=0;known_cost numeric:=0;complete boolean:=true;
  amount numeric;quantity numeric;unit_price numeric;unit_cost numeric;existing numeric;idx integer:=0;reason text:=btrim(payload->>'reason');
begin
  if not public.has_permission(case when command in ('fleet','intake') then 'orders.write' else 'expenses.write' end)
    then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if command is null or command not in ('fleet','intake','quote','allocate_cost','bill_scope','collect') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_CASE_COMMAND';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='fleet' then
    if not public.has_permission('vehicles.write') or nullif(reason,'') is null or payload->>'included' is null then raise exception 'FLEET_REASON_REQUIRED';end if;
    select * into car from public.vehicles where id=(payload->>'vehicleId')::uuid for update;
    if car.id is null then raise exception 'VEHICLE_NOT_FOUND';end if;
    if car.version is distinct from (payload->>'expectedVersion')::integer then raise exception 'VERSION_CONFLICT';end if;
    if not (payload->>'included')::boolean and exists(select 1 from public.reservations
      where vehicle_id=car.id and status='Confirmada' and rental_state in ('Preparado','Entregado')) then raise exception 'ACTIVE_FLEET_COMMITMENTS';end if;
    update public.vehicles set in_rental_fleet=(payload->>'included')::boolean,registered_holder=btrim(coalesce(payload->>'registeredHolder','')),
      commercial_line=btrim(coalesce(payload->>'commercialLine','')),version=version+1 where id=car.id returning to_jsonb(vehicles.*) into result;
    insert into public.audit_events(actor,entity,entity_id,action,after_data) values(auth.uid(),'vehicles',car.id::text,'FLEET_MEMBERSHIP',jsonb_build_object('reason',reason,'included',payload->'included'));
  else
    if command='allocate_cost' then
      select * into cost from public.workshop_costs where id=(payload->>'costId')::uuid for update;
      if cost.id is null then raise exception 'COST_NOT_FOUND';end if;
      if cost.version is distinct from (payload->>'expectedVersion')::integer then raise exception 'VERSION_CONFLICT';end if;
    end if;
    select * into job from public.work_orders where id=coalesce(cost.order_id,payload->>'orderId') for update;
    if job.id is null then raise exception 'ORDER_NOT_FOUND';end if;
    if command not in ('bill_scope','collect') and job.status='Entregado' then raise exception 'ORDER_NOT_OPEN';end if;
    if command='intake' then
      select * into car from public.vehicles where id=job.vehicle_id for update;
      if (payload->>'km')::integer<car.km then raise exception 'ODOMETER_CANNOT_DECREASE';end if;
      insert into public.workshop_inspections(order_id,km,fuel,condition,accessories,created_by)
      values(job.id,(payload->>'km')::integer,(payload->>'fuel')::numeric,btrim(payload->>'condition'),coalesce(payload->>'accessories',''),auth.uid())
        returning to_jsonb(workshop_inspections.*) into result;
      update public.vehicles set km=(payload->>'km')::integer,version=version+1 where id=car.id;
      update public.work_orders set pending_fields=array_remove(array_remove(array_remove(pending_fields,'kilometraje'),'condición'),'accesorios'),version=version+1 where id=job.id;
    elsif command='quote' then
      if nullif(reason,'') is null or jsonb_typeof(payload->'lines') is distinct from 'array'
        or jsonb_array_length(payload->'lines') not between 1 and 200 then raise exception 'INVALID_ESTIMATE_LINES';end if;
      select * into parent from public.estimate_versions where order_id=job.id order by revision desc limit 1;
      if parent.id is distinct from (payload->>'parentId')::uuid then raise exception 'PARENT_VERSION_CONFLICT';end if;
      for row in select value from jsonb_array_elements(payload->'lines') loop
        quantity:=(row->>'quantity')::numeric;unit_price:=(row->>'unitPrice')::numeric;unit_cost:=(row->>'unitCost')::numeric;
        if quantity is null or quantity<=0 or quantity<>round(quantity,4) or quantity>1000000
          or unit_price is null or unit_price<0 or unit_price<>round(unit_price,4) or unit_price>99999999
          or (unit_cost is not null and (unit_cost<0 or unit_cost>99999999 or unit_cost<>round(unit_cost,4)))
          or row->>'kind' not in ('Material','Trabajo','Tercero','Indirecto')
          or length(btrim(row->>'description')) not between 1 and 2000 then raise exception 'INVALID_ESTIMATE_LINE';end if;
        total:=total+round(quantity*unit_price,2);known_cost:=known_cost+coalesce(round(quantity*unit_cost,2),0);
        complete:=complete and unit_cost is not null;
        lines:=lines||jsonb_build_array(jsonb_build_object('tariffId',null,'code','Libre','tariffRevision',0,
          'description',btrim(row->>'description'),'kind',coalesce(row->>'kind','Material'),'quantity',quantity,
          'unitPrice',unit_price,'unitCost',unit_cost,'cost',round(quantity*unit_cost,2),'price',round(quantity*unit_price,2),
          'source',row->'source'));
      end loop;
      amount:=coalesce((payload->>'discount')::numeric,0);
      if amount<0 or amount<>round(amount,2) or amount>=total or total-amount>999999999999.99 then raise exception 'INVALID_DISCOUNT';end if;
      insert into public.estimate_versions(order_id,revision,parent_id,snapshot,customer_snapshot,vehicle_snapshot,reason,created_by)
      values(job.id,coalesce(parent.revision,0)+1,parent.id,jsonb_build_object('policy','manual-before-tax-v1','currency','USD',
        'rounding','half-up-per-line-2-decimals','method','commercial','ratio',null,'lines',lines,'cost',known_cost,'costComplete',complete,
        'commercial',total,'subtotal',total,'discount',amount,'total',total-amount,'margin',case when complete then total-amount-known_cost else null end,
        'marginPct',case when complete then round((total-amount-known_cost)/(total-amount)*100,2) else null end),
        coalesce((select to_jsonb(c)-'phone_key'-'document_key' from public.customers c where c.id=job.customer_id),
          jsonb_build_object('name','AJ · Mantenimiento interno','type','Interno')),
        (select to_jsonb(v) from public.vehicles v where v.id=job.vehicle_id),reason,auth.uid()) returning to_jsonb(estimate_versions.*) into result;
    elsif command='allocate_cost' then
      if nullif(reason,'') is null or jsonb_typeof(payload->'lines') is distinct from 'array' or jsonb_array_length(payload->'lines')>100 then raise exception 'ALLOCATION_REASON_REQUIRED';end if;
      for row in select value from jsonb_array_elements(payload->'lines') loop
        amount:=(row->>'amount')::numeric;
        if amount is null or amount<=0 or amount<>round(amount,2) or amount>cost.amount then raise exception 'INVALID_ALLOCATION_AMOUNT';end if;
        total:=total+amount;
        if row->>'estimateId' is not null then
          select * into quote from public.estimate_versions where id=(row->>'estimateId')::uuid and order_id=job.id;
          if quote.id is null or (row->>'lineIndex')::integer is null or (row->>'lineIndex')::integer not between 0 and jsonb_array_length(quote.snapshot->'lines')-1 then raise exception 'ESTIMATE_LINE_MISMATCH';end if;
        elsif row->>'lineIndex' is not null then raise exception 'ESTIMATE_LINE_MISMATCH';end if;
      end loop;
      if jsonb_array_length(payload->'lines')>0 and total<>cost.amount then raise exception 'ALLOCATION_TOTAL_MISMATCH';end if;
      update public.cost_allocations set active=false where cost_id=cost.id and active;
      for row in select value from jsonb_array_elements(payload->'lines') loop
        insert into public.cost_allocations(cost_id,estimate_id,line_index,description,amount,reason,created_by)
        values(cost.id,(row->>'estimateId')::uuid,(row->>'lineIndex')::integer,btrim(row->>'description'),(row->>'amount')::numeric,reason,auth.uid());
      end loop;
      update public.workshop_costs set version=version+1 where id=cost.id returning to_jsonb(workshop_costs.*) into result;
    elsif command='collect' then
      if job.internal_job or job.customer_id is null or not exists(select 1 from public.billing_documents d
        where d.id=(payload->>'documentId')::uuid and d.order_id=job.id) then raise exception 'CASE_DOCUMENT_REQUIRED';end if;
      if payload->>'paymentId' is null then
        row:=public.execute_billing_command('pay',payload||jsonb_build_object('customerId',job.customer_id),gen_random_uuid());
      else row:=jsonb_build_object('id',payload->>'paymentId');end if;
      result:=public.execute_billing_command('apply',payload||jsonb_build_object('paymentId',row->>'id'),gen_random_uuid());
    else
      if (payload->>'date')::date is null or not isfinite((payload->>'date')::date)
        or (payload->>'date')::date>(now() at time zone 'America/El_Salvador')::date then raise exception 'INVALID_DATE';end if;
      if job.internal_job or job.customer_id is null or (select ownership from public.vehicles where id=job.vehicle_id)='Propio' then raise exception 'INTERNAL_VEHICLE_NOT_A_SALE';end if;
      select * into quote from public.estimate_versions where id=job.active_estimate_id and status='Aprobado';
      if quote.id is null then raise exception 'APPROVED_SCOPE_REQUIRED';end if;
      select coalesce(sum(d.amount),0) into existing from public.billing_documents d where d.order_id=job.id;
      amount:=(quote.snapshot->>'total')::numeric-existing;
      if amount<=0 then raise exception 'SCOPE_ALREADY_BILLED_OR_CREDIT_REQUIRED';end if;
      insert into public.billing_documents(customer_id,order_id,description,amount,issued_on,due_on,source_key,customer_snapshot,created_by,estimate_id)
      values(job.customer_id,job.id,'Alcance aprobado '||job.id||' V'||quote.revision,amount,(payload->>'date')::date,(payload->>'dueOn')::date,
        'estimate:'||quote.id,quote.customer_snapshot,auth.uid(),quote.id) returning to_jsonb(billing_documents.*) into result;
    end if;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;
revoke all on function public.execute_case_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_case_command(text,jsonb,uuid) to authenticated;

create function private.check_cost_allocation_net() returns trigger language plpgsql set search_path='' as $$
begin
  if new.amount<old.amount and (select coalesce(sum(amount),0) from public.cost_allocations where cost_id=new.id and active)>new.amount then
    raise exception 'CLEAR_ALLOCATIONS_BEFORE_COST_RETURN';end if;return new;
end $$;
create trigger allocated_cost_net before update on public.workshop_costs for each row execute function private.check_cost_allocation_net();

create function public.save_vehicle_file(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare bytes bytea;prior private.command_results;file public.vehicle_files;car uuid:=(payload->>'vehicleId')::uuid;
  request jsonb:=jsonb_build_object('command','vehicle.file','payload',payload);mime text:=payload->>'mime';financial boolean:=coalesce((payload->>'financial')::boolean,false);
begin
  if not public.has_permission('orders.write') or (financial and not public.has_permission('expenses.write')) then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or length(payload->>'base64')>2800000 then raise exception 'DOCUMENT_TOO_LARGE';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  bytes:=decode(payload->>'base64','base64');
  if bytes is null or octet_length(bytes) not between 1 and 2097152 or not (
    (mime='image/png' and substring(bytes from 1 for 8)=decode('89504e470d0a1a0a','hex')) or
    (mime='image/jpeg' and substring(bytes from 1 for 3)=decode('ffd8ff','hex')) or
    (mime='image/webp' and substring(bytes from 1 for 4)=convert_to('RIFF','UTF8') and substring(bytes from 9 for 4)=convert_to('WEBP','UTF8')) or
    (mime='application/pdf' and payload->>'purpose'='Soporte' and substring(bytes from 1 for 5)=convert_to('%PDF-','UTF8')))
    then raise exception 'INVALID_VEHICLE_FILE';end if;
  if num_nonnulls(payload->>'orderId',payload->>'reservationId')>1
    or (payload->>'orderId' is not null and not exists(select 1 from public.work_orders where id=payload->>'orderId' and vehicle_id=car))
    or (payload->>'reservationId' is not null and not exists(select 1 from public.reservations where id=(payload->>'reservationId')::uuid and vehicle_id=car)) then raise exception 'FILE_DESTINATION_MISMATCH';end if;
  insert into public.vehicle_files(vehicle_id,order_id,reservation_id,name,mime,purpose,financial,file_hash,size,created_by)
  values(car,payload->>'orderId',(payload->>'reservationId')::uuid,btrim(payload->>'name'),mime,payload->>'purpose',financial,encode(sha256(bytes),'hex'),octet_length(bytes),auth.uid()) returning * into file;
  insert into private.vehicle_file_bytes values(file.id,bytes);
  if file.order_id is not null and mime like 'image/%' and file.purpose='Ingreso' then
    update public.work_orders set pending_fields=array_remove(pending_fields,'fotos'),version=version+1 where id=file.order_id and status<>'Entregado';end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,to_jsonb(file));return to_jsonb(file);
end $$;
create function public.vehicle_file_content(file_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare file public.vehicle_files;begin
  select * into file from public.vehicle_files where id=file_id;
  if file.id is null or not public.has_permission('vehicles.read') or (file.financial and not public.has_permission('expenses.read')) then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return jsonb_build_object('mime',file.mime,'name',file.name,'base64',(select encode(content,'base64') from private.vehicle_file_bytes where vehicle_file_bytes.file_id=file.id));
end $$;
revoke all on function public.save_vehicle_file(jsonb,uuid),public.vehicle_file_content(uuid) from public,anon;
grant execute on function public.save_vehicle_file(jsonb,uuid),public.vehicle_file_content(uuid) to authenticated;

create function private.vehicle_document_sources(vehicle_id uuid,order_id text default null)
returns table(document_id uuid,scope_amount numeric) language sql stable set search_path='' as $$
  select d.id,d.amount from public.billing_documents d left join public.work_orders o on o.id=d.order_id
    left join public.reservations r on r.id=d.reservation_id where coalesce(o.vehicle_id,r.vehicle_id)=vehicle_document_sources.vehicle_id
    and (vehicle_document_sources.order_id is null or d.order_id=vehicle_document_sources.order_id);
$$;
create function private.vehicle_application_sources(vehicle_id uuid,order_id text default null)
returns table(application_id uuid,document_id uuid,scope_amount numeric,kind text) language sql stable set search_path='' as $$
  select a.id,a.document_id,a.amount,a.kind from public.payment_applications a
  join private.vehicle_document_sources(vehicle_id,order_id) s on s.document_id=a.document_id;
$$;
create function private.vehicle_credit_sources(vehicle_id uuid,order_id text default null)
returns table(credit_id uuid,document_id uuid,scope_amount numeric) language sql stable set search_path='' as $$
  select c.id,c.document_id,c.amount from public.billing_credits c
  join private.vehicle_document_sources(vehicle_id,order_id) s on s.document_id=c.document_id;
$$;
create function public.vehicle_case_file(vehicle_id uuid,order_id text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare car public.vehicles;finance boolean:=public.has_permission('expenses.read');result jsonb;
begin
  if not public.has_permission('vehicles.read') or not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  select * into car from public.vehicles v where v.id=vehicle_case_file.vehicle_id;
  if car.id is null then raise exception 'VEHICLE_NOT_FOUND';end if;
  if order_id is not null and not exists(select 1 from public.work_orders o where o.id=vehicle_case_file.order_id and o.vehicle_id=car.id) then raise exception 'ORDER_NOT_FOUND';end if;
  result:=jsonb_build_object('vehicle',to_jsonb(car),'financialAccess',finance,
    'orders',coalesce((select jsonb_agg(to_jsonb(o) order by o.occurred_at desc) from public.work_orders o where o.vehicle_id=car.id and (vehicle_case_file.order_id is null or o.id=vehicle_case_file.order_id)),'[]'),
    'reservations',coalesce((select jsonb_agg(to_jsonb(r) order by r.starts_at desc) from public.reservations r where r.vehicle_id=car.id and order_id is null),'[]'),
    'commitments',coalesce((select jsonb_agg(to_jsonb(c) order by c.starts_at desc) from public.vehicle_commitments c where c.vehicle_id=car.id),'[]'),
    'inspections',coalesce((select jsonb_agg(to_jsonb(i)) from public.workshop_inspections i join public.work_orders o on o.id=i.order_id where o.vehicle_id=car.id and (vehicle_case_file.order_id is null or o.id=vehicle_case_file.order_id)),'[]'),
    'files',coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at desc) from public.vehicle_files f where f.vehicle_id=car.id and (vehicle_case_file.order_id is null or f.order_id=vehicle_case_file.order_id) and (not f.financial or finance)),'[]'));
  if finance then result:=result||jsonb_build_object(
    'quotes',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from public.estimate_versions q join public.work_orders o on o.id=q.order_id where o.vehicle_id=car.id and (vehicle_case_file.order_id is null or o.id=vehicle_case_file.order_id)),'[]'),
    'costs',coalesce((select jsonb_agg(to_jsonb(c)) from public.workshop_costs c join public.work_orders o on o.id=c.order_id where o.vehicle_id=car.id and (vehicle_case_file.order_id is null or o.id=vehicle_case_file.order_id)),'[]'),
    'allocations',coalesce((select jsonb_agg(to_jsonb(a)) from public.cost_allocations a join public.workshop_costs c on c.id=a.cost_id join public.work_orders o on o.id=c.order_id where o.vehicle_id=car.id and a.active and (vehicle_case_file.order_id is null or o.id=vehicle_case_file.order_id)),'[]'),
    'expenses',coalesce((select jsonb_agg(to_jsonb(e) order by e.date desc) from public.expenses e left join public.work_orders o on o.id=e.operation_id left join public.reservations r on r.id=e.reservation_id
      where coalesce(e.vehicle_id,o.vehicle_id,r.vehicle_id)=car.id and (vehicle_case_file.order_id is null or e.operation_id=vehicle_case_file.order_id)),'[]'),
    'documents',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('scope_amount',s.scope_amount,'scope_balance',s.scope_amount
      -coalesce((select sum(case a.kind when 'Aplicacion' then a.scope_amount else -a.scope_amount end) from private.vehicle_application_sources(car.id,vehicle_case_file.order_id) a where a.document_id=d.id),0)
      -coalesce((select sum(c.scope_amount) from private.vehicle_credit_sources(car.id,vehicle_case_file.order_id) c where c.document_id=d.id),0)))
      from private.vehicle_document_sources(car.id,vehicle_case_file.order_id) s join public.billing_documents d on d.id=s.document_id),'[]'),
    'applications',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('scope_amount',s.scope_amount)) from private.vehicle_application_sources(car.id,vehicle_case_file.order_id) s join public.payment_applications a on a.id=s.application_id),'[]'),
    'payments',coalesce((select jsonb_agg(to_jsonb(p)) from public.customer_payments p where exists(select 1 from private.vehicle_application_sources(car.id,vehicle_case_file.order_id) s join public.payment_applications a on a.id=s.application_id where a.payment_id=p.id)),'[]'));
  end if;
  return result;
end $$;
revoke all on function public.vehicle_case_file(uuid,text) from public,anon;
grant execute on function public.vehicle_case_file(uuid,text) to authenticated;

-- An internal job is a cost, not a sale to a fictitious customer. Pending external
-- scope must still be billed after an approved additional version.
alter function private.delivery_checklist(text) rename to delivery_checklist_before_cases;
create function private.delivery_checklist(order_id text) returns jsonb language plpgsql stable set search_path='' as $$
declare checklist jsonb;job public.work_orders;charged numeric;unbilled boolean;
begin
  checklist:=private.delivery_checklist_before_cases(order_id);
  select * into job from public.work_orders o where o.id=delivery_checklist.order_id;
  select coalesce(sum(d.amount),0) into charged from public.billing_documents d where d.order_id=job.id;
  unbilled:=not job.internal_job and job.customer_id is not null and
    (select ownership from public.vehicles where id=job.vehicle_id)='Cliente' and job.estimate>charged;
  return checklist||jsonb_build_object('estimatedUnpaid',case when job.internal_job then 0 else (checklist->>'estimatedUnpaid')::numeric end,
    'unbilledEstimate',unbilled,'pendingEstimate',case when unbilled then 'Cargo del alcance aprobado pendiente de emitir' else checklist->>'pendingEstimate' end);
end $$;
