-- Additive usability fixes. Existing inspections, cases and cash events are not rewritten.
create table private.polish_function_backups(signature text primary key,definition text not null);
insert into private.polish_function_backups select s,pg_get_functiondef(s::regprocedure) from unnest(array[
  'public.execute_case_command(text,jsonb,uuid)','public.execute_rental_command(text,jsonb,uuid)',
  'private.receive_estimated_work()','public.save_registry_details(text,jsonb,uuid)',
  'public.vehicle_case_file(uuid,text)','public.rental_case_file(uuid)','public.cash_diary(date,date,text)']) s;

-- A free-text review may not contain a numeric reading. Unknown is not zero.
alter table public.workshop_inspections alter column km drop not null,alter column fuel drop not null;
alter table public.rental_inspections alter column km drop not null,alter column fuel drop not null;
do $$declare definition text;anchor text;begin
  definition:=pg_get_functiondef('public.execute_case_command(text,jsonb,uuid)'::regprocedure);
  anchor:='set km=(payload->>''km'')::integer,version=version+1';
  if position(anchor in definition)=0 then raise exception 'POLISH_INTAKE_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,'set km=coalesce((payload->>''km'')::integer,km),version=version+1');
  definition:=pg_get_functiondef('public.execute_rental_command(text,jsonb,uuid)'::regprocedure);
  if position('km=outgoing.km' in definition)=0 or position('km=incoming.km' in definition)=0
    then raise exception 'POLISH_RENTAL_SOURCE_MISMATCH';end if;
  definition:=replace(replace(definition,'km=outgoing.km','km=coalesce(outgoing.km,km)'),
    'km=incoming.km','km=coalesce(incoming.km,km)');
  -- Compare a new reading with the last known odometer, even after a text-only departure.
  definition:=replace(definition,'(payload->>''km'')::integer<outgoing.km',
    '(payload->>''km'')::integer<greatest(outgoing.km,car.km)');
  execute definition;
  definition:=pg_get_functiondef('private.receive_estimated_work()'::regprocedure);
  anchor:='unverified_fields=array_remove(array_remove(unverified_fields,''km''),''status'')';
  if position(anchor in definition)=0 then raise exception 'POLISH_RECEIPT_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,'unverified_fields=array_remove(case when new.km is not null then array_remove(unverified_fields,''km'') else unverified_fields end,''status'')');
  definition:=pg_get_functiondef('public.save_registry_details(text,jsonb,uuid)'::regprocedure);
  anchor:='email=btrim(coalesce(payload->>''email'','''')),document=';
  if position(anchor in definition)=0 then raise exception 'POLISH_CUSTOMER_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,'type=coalesce(payload->>''type'',type),email=btrim(coalesce(payload->>''email'','''')),document=');
end $$;

create function public.receive_workshop_vehicle(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','workshop.receive','payload',payload);
  customer public.customers;car public.vehicles;created jsonb;result jsonb;details jsonb:=payload->'newVehicle';entity text;
begin
  if not public.has_permission('orders.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  select * into customer from public.customers where id=(payload->>'customerId')::uuid and merged_into is null;
  if customer.id is null then raise exception 'INVALID_CUSTOMER';end if;
  if jsonb_typeof(details)='object' then
    if nullif(payload->>'vehicleId','') is not null then raise exception 'INVALID_REQUEST';end if;
    if not public.has_permission('vehicles.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
    created:=public.execute_command('create_vehicle',jsonb_build_object('plate',coalesce(details->>'plate',''),
      'brand',details->>'brand','model',details->>'model','year',details->>'year',
      'category',coalesce(details->>'category','Sedán'),'color',coalesce(details->>'color',''),
      'km',0,'daily',0,'ownership','Cliente','ownerCustomerId',customer.id,'inRentalFleet',false,
      'initialStatus','Por confirmar','unverifiedFields',jsonb_build_array('km','daily','status')||
        case when nullif(btrim(details->>'plate'),'') is null then '["plate"]'::jsonb else '[]'::jsonb end||
        case when nullif(btrim(details->>'color'),'') is null then '["color"]'::jsonb else '[]'::jsonb end),gen_random_uuid());
    select * into car from public.vehicles where id=(created->>'id')::uuid for update;
  else
    select * into car from public.vehicles where id=(payload->>'vehicleId')::uuid for update;
    if car.version is distinct from (payload->>'expectedVersion')::integer then raise exception 'VERSION_CONFLICT';end if;
  end if;
  if car.id is null or car.in_rental_fleet or car.ownership='Propio' then raise exception 'CUSTOMER_WORKSHOP_VEHICLE_REQUIRED';end if;
  if exists(select 1 from public.work_orders where vehicle_id=car.id and status<>'Entregado') then raise exception 'VEHICLE_HAS_OPEN_WORK';end if;
  if car.status not in ('Disponible','Por confirmar') then raise exception 'VEHICLE_UNAVAILABLE';end if;
  insert into public.work_orders(vehicle_id,customer_id,internal_job,area,service,due,created_by)
  values(car.id,customer.id,false,payload->>'area',btrim(payload->>'service'),
    coalesce((payload->>'due')::date,(now() at time zone 'America/El_Salvador')::date),auth.uid()) returning id into entity;
  update public.vehicles set status='En taller',unverified_fields=array_remove(unverified_fields,'status'),version=version+1 where id=car.id;
  result:=jsonb_build_object('id',entity,'vehicleId',car.id,'command','receive_workshop_vehicle','createdAt',now());
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;
revoke all on function public.receive_workshop_vehicle(jsonb,uuid) from public,anon;
grant execute on function public.receive_workshop_vehicle(jsonb,uuid) to authenticated;

create function private.rental_actual_dates(records jsonb) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(r.value||jsonb_build_object(
    'actual_departure_at',(select occurred_at from public.rental_inspections where reservation_id=(r.value->>'id')::uuid and kind='Salida'),
    'actual_return_at',(select occurred_at from public.rental_inspections where reservation_id=(r.value->>'id')::uuid and kind='Retorno')) order by r.ordinality),'[]')
  from jsonb_array_elements(records) with ordinality r;
$$;
do $$declare signature text;definition text;begin
  foreach signature in array array['public.vehicle_case_file(uuid,text)','public.rental_case_file(uuid)'] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    if position('return result;' in definition)=0 then raise exception 'POLISH_CASE_SOURCE_MISMATCH';end if;
    execute replace(definition,'return result;',
      'return jsonb_set(result,''{reservations}'',private.rental_actual_dates(result->''reservations''));');
  end loop;
  definition:=pg_get_functiondef('public.cash_diary(date,date,text)'::regprocedure);
  if position('''links'',coalesce' in definition)=0 then raise exception 'POLISH_DIARY_SOURCE_MISMATCH';end if;
  execute replace(definition,'''links'',coalesce',$replacement$'created_at',case item->>'source_type'
    when 'expense' then (select created_at from public.expenses where id=split_part(item->>'id',':',2))
    when 'receipt' then (select created_at from public.customer_payments where id=split_part(item->>'id',':',2)::uuid)
    when 'refund' then (select created_at from public.payment_refunds where id=split_part(item->>'id',':',2)::uuid)
    when 'cash' then (select created_at from public.cash_entries where id=split_part(item->>'id',':',2)::uuid) end,
    'links',coalesce$replacement$);
end $$;
