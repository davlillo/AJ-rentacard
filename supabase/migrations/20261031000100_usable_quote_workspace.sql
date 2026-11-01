-- Missing source facts stay explicitly unknown. A quote is not a physical intake.
create table private.usability_function_backups(signature text primary key,definition text not null);
insert into private.usability_function_backups select s,pg_get_functiondef(s::regprocedure) from unnest(array[
  'private.workshop_commitment()','private.delivery_checklist(text)','public.deliver_workshop_order(jsonb,uuid)']) s;

alter table public.customers drop constraint customers_phone_check;
alter table public.customers add constraint customers_phone_check
  check(phone='' or length(regexp_replace(phone,'[^0-9]','','g')) between 7 and 15);
alter table public.vehicles drop constraint vehicles_ownership_check;
alter table public.vehicles drop constraint vehicles_check;
alter table public.vehicles add constraint vehicles_ownership_check check(ownership in ('Propio','Cliente','Por confirmar'));
alter table public.vehicles add constraint vehicles_check check(
  (ownership in ('Propio','Por confirmar') and owner_customer_id is null) or (ownership='Cliente' and owner_customer_id is not null));
alter table public.vehicles drop constraint vehicles_plate_key_key;
alter table public.vehicles drop constraint vehicles_plate_key_check;
create unique index vehicles_known_plate_key on public.vehicles(plate_key) where plate_key<>'';
alter table public.vehicles drop constraint vehicles_status_check;
alter table public.vehicles add constraint vehicles_status_check check(status in ('Disponible','Alquilado','En taller','Por confirmar'));
alter table public.vehicles add column unverified_fields text[] not null default '{}';
alter table public.vehicles add column source_workbook_id uuid references public.source_workbooks;
alter table public.vehicles add column source_ref text;
create unique index vehicles_source_reference on public.vehicles(source_workbook_id,source_ref) where source_workbook_id is not null;
alter table public.customers add column source_reference text not null default '';
alter table public.estimate_versions add column folio_number bigint generated always as identity unique;
alter table public.estimate_versions add column source_reference text not null default '';
alter table public.estimate_versions add column source_totals jsonb;
alter table public.reservations add column folio_number bigint generated always as identity unique;
alter table public.billing_documents add column folio_number bigint generated always as identity unique;
alter table public.customer_payments add column folio_number bigint generated always as identity unique;

create or replace function private.workshop_commitment() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(6192,1);
  if new.status='Presupuesto' then return new;end if;
  if TG_OP='INSERT' or (TG_OP='UPDATE' and old.status='Presupuesto' and new.status<>'Entregado') then
    insert into public.vehicle_commitments(vehicle_id,order_id,kind,starts_at,ends_at,reason,created_by)
    values(new.vehicle_id,new.id,'Taller',new.occurred_at,'infinity','Ingreso de taller',new.created_by);
  elsif new.status='Entregado' and old.status<>'Entregado' then
    update public.vehicle_commitments set ends_at=greatest(clock_timestamp(),starts_at+interval '1 microsecond'),
      reason='Entrega de taller registrada' where order_id=new.id;
  end if;
  return new;
end $$;

create function public.save_workshop_quote(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','workshop.quote','payload',payload);
  job public.work_orders;car public.vehicles;result jsonb;internal boolean:=coalesce((payload->>'internalJob')::boolean,false);
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if nullif(payload->>'orderId','') is not null then
    select * into job from public.work_orders where id=payload->>'orderId' for update;
    if job.id is null or job.status='Entregado' then raise exception 'ORDER_NOT_OPEN';end if;
  else
    if not public.has_permission('orders.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
    select * into car from public.vehicles where id=(payload->>'vehicleId')::uuid for update;
    if car.id is null then raise exception 'VEHICLE_NOT_FOUND';end if;
    if internal and not car.in_rental_fleet then raise exception 'INTERNAL_FLEET_VEHICLE_REQUIRED';end if;
    if not internal and not exists(select 1 from public.customers where id=(payload->>'customerId')::uuid and merged_into is null)
      then raise exception 'INVALID_CUSTOMER';end if;
    select * into job from public.work_orders where vehicle_id=car.id and status<>'Entregado' for update;
    if job.id is not null then
      if job.internal_job is distinct from internal or (not internal and job.customer_id is distinct from (payload->>'customerId')::uuid)
        then raise exception 'VEHICLE_HAS_OTHER_CUSTOMER_WORK';end if;
    else
      insert into public.work_orders(vehicle_id,customer_id,internal_job,area,service,status,due,created_by)
      values(car.id,case when internal then null else (payload->>'customerId')::uuid end,internal,
        coalesce(payload->>'area','Mecánica'),btrim(payload->>'service'),'Presupuesto',
        (now() at time zone 'America/El_Salvador')::date,auth.uid()) returning * into job;
    end if;
  end if;
  result:=public.execute_case_command('quote',(payload-'vehicleId'-'customerId'-'service'-'area'-'internalJob')||
    jsonb_build_object('orderId',job.id),gen_random_uuid());
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end $$;
revoke all on function public.save_workshop_quote(jsonb,uuid) from public,anon;
grant execute on function public.save_workshop_quote(jsonb,uuid) to authenticated;

create function private.receive_estimated_work() returns trigger language plpgsql security definer set search_path='' as $$
declare job public.work_orders;
begin
  select * into job from public.work_orders where id=new.order_id for update;
  if job.status='Presupuesto' then
    update public.work_orders set status='Diagnóstico',occurred_at=new.created_at,version=version+1 where id=job.id;
    update public.vehicles set status='En taller',version=version+1,
      unverified_fields=array_remove(array_remove(unverified_fields,'km'),'status') where id=job.vehicle_id;
  end if;
  return new;
end $$;
revoke all on function private.receive_estimated_work() from public,anon,authenticated;
create trigger estimate_intake after insert on public.workshop_inspections for each row execute function private.receive_estimated_work();

-- Existing customer-work guards must not treat unknown title as an internal sale.
do $$declare definition text;anchor text;begin
  definition:=pg_get_functiondef('private.delivery_checklist(text)'::regprocedure);
  definition:=replace(definition,$before$(select ownership from public.vehicles where id=job.vehicle_id)='Cliente'$before$,
    $after$(select ownership from public.vehicles where id=job.vehicle_id)<>'Propio'$after$);
  execute definition;
  definition:=pg_get_functiondef('public.deliver_workshop_order(jsonb,uuid)'::regprocedure);
  anchor:='if not public.has_permission(''expenses.write'') then raise exception using errcode=''42501'',message=''PERMISSION_DENIED''; end if;';
  if position(anchor in definition)=0 then raise exception 'USABILITY_DELIVERY_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,anchor||E'\n if exists(select 1 from public.work_orders where id=payload->>''orderId'' and status=''Presupuesto'') then raise exception ''ESTIMATE_NOT_RECEIVED'';end if;');
end $$;
