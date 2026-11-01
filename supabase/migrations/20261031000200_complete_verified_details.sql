-- Confirm missing source facts explicitly, with optimistic locking and an audit trail.
create function public.save_registry_details(kind text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','registry.'||kind,'payload',payload);
  car public.vehicles;customer public.customers;result jsonb;field text;unknown text[];state text;
begin
  if kind not in ('customer','vehicle') or kind is null then raise exception 'INVALID_REGISTRY_KIND';end if;
  if not public.has_permission(case kind when 'customer' then 'customers.write' else 'vehicles.write' end)
    then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' or nullif(btrim(payload->>'reason'),'') is null
    then raise exception 'DETAILS_REASON_REQUIRED';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if kind='customer' then
    select * into customer from public.customers where id=(payload->>'id')::uuid and merged_into is null for update;
    if customer.id is null then raise exception 'INVALID_CUSTOMER';end if;
    if customer.version is distinct from (payload->>'expectedVersion')::integer then raise exception 'VERSION_CONFLICT';end if;
    if exists(select 1 from public.customers c where c.id<>customer.id and c.merged_into is null and (
      (nullif(regexp_replace(payload->>'phone','[^0-9]','','g'),'') is not null and c.phone_key=regexp_replace(payload->>'phone','[^0-9]','','g')) or
      (nullif(upper(regexp_replace(payload->>'document','[^a-zA-Z0-9]','','g')),'') is not null and c.document_key=upper(regexp_replace(payload->>'document','[^a-zA-Z0-9]','','g')))))
      then raise exception 'CUSTOMER_MATCH_EXISTS';end if;
    update public.customers set name=btrim(payload->>'name'),phone=btrim(coalesce(payload->>'phone','')),
      email=btrim(coalesce(payload->>'email','')),document=btrim(coalesce(payload->>'document','')),version=version+1
      where id=customer.id returning to_jsonb(customers.*)-'phone_key'-'document_key' into result;
  else
    select * into car from public.vehicles where id=(payload->>'id')::uuid for update;
    if car.id is null then raise exception 'VEHICLE_NOT_FOUND';end if;
    if car.version is distinct from (payload->>'expectedVersion')::integer then raise exception 'VERSION_CONFLICT';end if;
    state:=coalesce(payload->>'status',car.status);
    if state<>car.status then
      if state not in ('Disponible','Por confirmar') or car.status in ('Alquilado','En taller')
        or exists(select 1 from public.vehicle_commitments c where c.vehicle_id=car.id and c.active and c.starts_at<=now() and c.ends_at>now())
        then raise exception 'PHYSICAL_STATUS_REQUIRES_WORKFLOW';end if;
      if state='Disponible' and nullif(payload->>'km','') is null and 'km'=any(car.unverified_fields)
        then raise exception 'CONFIRMED_ODOMETER_REQUIRED';end if;
    end if;
    if nullif(payload->>'km','') is not null and (payload->>'km')::integer<car.km then raise exception 'ODOMETER_CANNOT_DECREASE';end if;
    unknown:=car.unverified_fields;
    foreach field in array array['plate','color','km','daily'] loop
      if nullif(btrim(payload->>field),'') is not null then unknown:=array_remove(unknown,field);end if;
    end loop;
    if state<>'Por confirmar' then unknown:=array_remove(unknown,'status');end if;
    update public.vehicles set plate=coalesce(nullif(btrim(payload->>'plate'),''),plate),
      color=coalesce(nullif(btrim(payload->>'color'),''),color),km=coalesce(nullif(payload->>'km','')::integer,km),
      daily=coalesce(nullif(payload->>'daily','')::numeric,daily),status=state,unverified_fields=unknown,version=version+1
      where id=car.id returning to_jsonb(vehicles.*) into result;
  end if;
  insert into public.audit_events(actor,entity,entity_id,action,after_data) values(auth.uid(),
    case kind when 'customer' then 'customers' else 'vehicles' end,payload->>'id','CONFIRM_DETAILS',jsonb_build_object('reason',btrim(payload->>'reason')));
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;
revoke all on function public.save_registry_details(text,jsonb,uuid) from public,anon;
grant execute on function public.save_registry_details(text,jsonb,uuid) to authenticated;
