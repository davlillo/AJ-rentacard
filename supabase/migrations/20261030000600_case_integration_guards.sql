-- Integrate new source/scopes with the preserved report and commission paths.
create table private.case_integration_functions(signature text primary key,definition text not null);
insert into private.case_integration_functions select s,pg_get_functiondef(s::regprocedure) from unnest(array[
  'public.execute_case_command(text,jsonb,uuid)','public.execute_cost_command(text,jsonb,uuid)',
  'public.execute_delivery_cost_adjustment(text,jsonb,uuid)','private.billing_command_before_grouped(text,jsonb,uuid)',
  'public.deliver_workshop_order(jsonb,uuid)','public.execute_commission_command(text,jsonb,uuid)',
  'public.vehicle_contribution(uuid,date,date)']) s;
do $$ declare definition text;s text;anchor text;begin
  definition:=pg_get_functiondef('public.execute_case_command(text,jsonb,uuid)'::regprocedure);
  anchor:='or length(btrim(row->>''description'')) not between 1 and 2000';
  if position(anchor in definition)=0 then raise exception 'CASE_INTEGRATION_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,'or nullif(btrim(row->>''description''),'''') is null or length(row->>''description'')>2000');
  foreach s in array array['public.execute_cost_command(text,jsonb,uuid)','public.execute_delivery_cost_adjustment(text,jsonb,uuid)'] loop
    definition:=pg_get_functiondef(s::regprocedure);
    anchor:='if exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership=''Propio'')';
    if position(anchor in definition)=0 then raise exception 'CASE_INTEGRATION_SOURCE_MISMATCH';end if;
    execute replace(definition,anchor,'if service_order.internal_job or exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership=''Propio'')');
  end loop;
  definition:=pg_get_functiondef('private.billing_command_before_grouped(text,jsonb,uuid)'::regprocedure);
  anchor:='if exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership=''Propio'')';
  if position(anchor in definition)=0 then raise exception 'CASE_INTEGRATION_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,'if service_order.internal_job or exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership=''Propio'')');
  definition:=pg_get_functiondef('public.deliver_workshop_order(jsonb,uuid)'::regprocedure);
  anchor:='case when ownership=''Cliente'' then ''Disponible'' else ''En taller'' end';
  if position(anchor in definition)=0 then raise exception 'CASE_INTEGRATION_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,'case when not in_rental_fleet then ''Disponible'' else ''En taller'' end');
end $$;
create function private.reservation_payment_sources(reservation_id uuid)
returns table(id uuid,document_id uuid,payment_id uuid,kind text,amount numeric,effective_on date,created_at timestamptz)
language sql stable set search_path='' as $$
  select a.id,a.document_id,a.payment_id,a.kind,a.amount,a.effective_on,a.created_at from public.payment_applications a
    join public.billing_documents d on d.id=a.document_id where d.reservation_id=reservation_payment_sources.reservation_id
  union all select a.id,a.document_id,a.payment_id,a.kind,sum(s.amount),a.effective_on,a.created_at
    from public.billing_application_lines s join public.payment_applications a on a.id=s.application_id
    join public.billing_document_lines l on l.id=s.line_id where l.reservation_id=reservation_payment_sources.reservation_id group by a.id;
$$;
do $$ declare definition text;anchor text;begin
  definition:=pg_get_functiondef('public.execute_commission_command(text,jsonb,uuid)'::regprocedure);
  anchor:='from public.payment_applications a join public.billing_documents d on d.id=a.document_id';
  if position(anchor in definition)=0 then raise exception 'CASE_INTEGRATION_SOURCE_MISMATCH';end if;
  definition:=replace(definition,anchor,'from private.reservation_payment_sources(booking.id) a join public.billing_documents d on d.id=a.document_id');
  definition:=replace(definition,'where d.reservation_id=booking.id','where (d.reservation_id=booking.id or exists(select 1 from public.billing_document_lines line where line.document_id=d.id and line.reservation_id=booking.id))');
  execute definition;
end $$;
create or replace function public.vehicle_contribution(vehicle_id uuid,from_date date,cutoff date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare income jsonb;costs jsonb;income_total numeric;cost_total numeric;car public.vehicles;boundary timestamptz;
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if from_date is null or cutoff is null or not isfinite(from_date) or not isfinite(cutoff) or cutoff<from_date then raise exception 'INVALID_REPORT_RANGE';end if;
  select * into car from public.vehicles v where v.id=vehicle_contribution.vehicle_id;
  if car.id is null then raise exception 'VEHICLE_NOT_FOUND';end if;
  boundary:=(cutoff+1)::timestamp at time zone 'America/El_Salvador';
  select coalesce(jsonb_agg(to_jsonb(rows)),'[]'),coalesce(sum(rows.amount),0) into income,income_total from (
    select d.id::text,'Cargo'::text kind,d.description,s.scope_amount amount,d.issued_on date
      from private.vehicle_document_sources(car.id,null) s join public.billing_documents d on d.id=s.document_id
      where d.issued_on between from_date and cutoff and d.created_at<boundary
    union all select c.id::text,'Credito',c.reason,-s.scope_amount,c.credited_on
      from private.vehicle_credit_sources(car.id,null) s join public.billing_credits c on c.id=s.credit_id
      where c.credited_on between from_date and cutoff and c.created_at<boundary
  ) rows;
  select coalesce(jsonb_agg(to_jsonb(rows)),'[]'),coalesce(sum(rows.amount),0) into costs,cost_total from (
    select c.id::text,c.order_id,c.description,(history.data->>'amount')::numeric amount,c.occurred_at date from public.workshop_costs c
      join public.work_orders o on o.id=c.order_id cross join lateral(select a.after_data data from public.audit_events a
        where a.entity='workshop_costs' and a.entity_id=c.id::text and a.created_at<boundary order by a.created_at desc,a.id desc limit 1) history
      where o.vehicle_id=car.id and c.occurred_at between from_date and cutoff
    union all select e.id,null,e.concept,e.amount,e.date from public.expenses e left join public.reservations r on r.id=e.reservation_id
      where coalesce(e.vehicle_id,r.vehicle_id)=car.id and e.operation_id is null and e.date between from_date and cutoff and e.created_at<boundary
  ) rows;
  return jsonb_build_object('policy','scoped-billed-direct-contribution-v2','vehicleId',car.id,'plate',car.plate,'from',from_date,'cutoff',cutoff,
    'income',income,'costs',costs,'billedIncome',income_total,'actualDirectCost',cost_total,'contribution',income_total-cost_total,
    'limitations','Not net profit. Grouped amounts use explicit allocations. Direct rental/vehicle expenses are included; purchase payments never duplicate acquisition cost. Labor and overhead require approved valuation policies.');
end $$;
