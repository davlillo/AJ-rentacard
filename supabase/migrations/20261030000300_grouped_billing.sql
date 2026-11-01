-- One external document can cover several operations. Every credit/payment has
-- explicit line allocations; never infer a vehicle share from a header amount.
create table private.grouped_billing_functions(signature text primary key,definition text not null);
insert into private.grouped_billing_functions select s,pg_get_functiondef(s::regprocedure) from unnest(array[
  'public.execute_billing_command(text,jsonb,uuid)','private.vehicle_document_sources(uuid,text)',
  'private.vehicle_application_sources(uuid,text)','private.vehicle_credit_sources(uuid,text)',
  'private.delivery_checklist(text)','public.execute_case_command(text,jsonb,uuid)',
  'public.reservation_payment_status(uuid)','public.rental_paid_through(uuid)']) s;
create table private.grouped_billing_constraints(table_name text,name text,definition text);
insert into private.grouped_billing_constraints select 'billing_documents',conname,pg_get_constraintdef(oid)
  from pg_constraint where conrelid='public.billing_documents'::regclass and contype='c' and pg_get_constraintdef(oid) like '%num_nonnulls%';
insert into private.grouped_billing_constraints select 'rental_periods',conname,pg_get_constraintdef(oid)
  from pg_constraint where conrelid='public.rental_periods'::regclass and contype='u' and pg_get_constraintdef(oid) like '%document_id%';
do $$ declare c record;begin
  for c in select * from private.grouped_billing_constraints loop execute format('alter table public.%I drop constraint %I',c.table_name,c.name);end loop;
end $$;
alter table public.billing_documents add column grouped boolean not null default false,add column external_reference text not null default '';
alter table public.billing_documents add constraint document_scope_fit check((grouped and num_nonnulls(order_id,reservation_id)=0)
  or (not grouped and num_nonnulls(order_id,reservation_id)=1));
create unique index billing_external_reference on public.billing_documents(customer_id,external_reference) where external_reference<>'';
create table public.billing_document_lines(
  id uuid primary key default gen_random_uuid(),document_id uuid not null references public.billing_documents,
  order_id text references public.work_orders,reservation_id uuid references public.reservations,
  description text not null check(length(btrim(description))>0),gross numeric(14,2) not null check(gross>0),
  discount numeric(14,2) not null default 0 check(discount>=0 and discount<gross),
  amount numeric(14,2) generated always as (gross-discount) stored,
  discount_reason text not null,starts_on date,ends_on date,created_by uuid not null references auth.users,created_at timestamptz not null default now(),
  check(num_nonnulls(order_id,reservation_id)=1),check(discount=0 or length(btrim(discount_reason))>0),
  check(gross::text not in ('NaN','Infinity') and discount::text not in ('NaN','Infinity')),
  check((starts_on is null and ends_on is null) or (starts_on is not null and ends_on is not null and isfinite(starts_on) and isfinite(ends_on) and ends_on>=starts_on))
);
create table public.billing_application_lines(
  id uuid primary key default gen_random_uuid(),application_id uuid not null references public.payment_applications,
  line_id uuid not null references public.billing_document_lines,amount numeric(14,2) not null check(amount>0 and amount::text not in ('NaN','Infinity')),
  unique(application_id,line_id)
);
create table public.billing_credit_lines(
  id uuid primary key default gen_random_uuid(),credit_id uuid not null references public.billing_credits,
  line_id uuid not null references public.billing_document_lines,amount numeric(14,2) not null check(amount>0 and amount::text not in ('NaN','Infinity')),
  unique(credit_id,line_id)
);
do $$ declare tbl text;begin
  foreach tbl in array array['billing_document_lines','billing_application_lines','billing_credit_lines'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from anon,authenticated',tbl);
    execute format('grant select on public.%I to authenticated',tbl);
    execute format('create policy grouped_read on public.%I for select to authenticated using(public.has_permission(''expenses.read''))',tbl);
    execute format('create trigger grouped_immutable before update or delete on public.%I for each row execute function private.immutable_quote_record()',tbl);
    execute format('create trigger grouped_audit after insert on public.%I for each row execute function private.audit_change()',tbl);
  end loop;
end $$;
alter table public.rental_periods add column document_line_id uuid unique references public.billing_document_lines;
create unique index legacy_period_document on public.rental_periods(document_id) where document_line_id is null;
create function private.document_line_balance(line_id uuid) returns numeric language sql stable set search_path='' as $$
  select l.amount-coalesce((select sum(s.amount) from public.billing_credit_lines s where s.line_id=l.id),0)
    -coalesce((select sum(case a.kind when 'Aplicacion' then s.amount else -s.amount end)
      from public.billing_application_lines s join public.payment_applications a on a.id=s.application_id where s.line_id=l.id),0)
  from public.billing_document_lines l where l.id=document_line_balance.line_id;
$$;
create function private.allocate_document_event() returns trigger language plpgsql security definer set search_path='' as $$
declare allocations jsonb;part jsonb;line public.billing_document_lines;allocated numeric:=0;value numeric;available numeric;
begin
  if not (select grouped from public.billing_documents where id=new.document_id) then return new;end if;
  allocations:=nullif(current_setting('aj.billing_allocations',true),'')::jsonb;
  if jsonb_typeof(allocations) is distinct from 'array' or jsonb_array_length(allocations) not between 1 and 200
    then raise exception 'EXPLICIT_DOCUMENT_ALLOCATIONS_REQUIRED';end if;
  for part in select v from jsonb_array_elements(allocations) v loop
    select * into line from public.billing_document_lines l where l.id=(part->>'lineId')::uuid and l.document_id=new.document_id;
    value:=(part->>'amount')::numeric;
    if line.id is null or value is null or value<=0 or value<>round(value,2) or value::text in ('NaN','Infinity') then raise exception 'INVALID_DOCUMENT_ALLOCATION';end if;
    available:=private.document_line_balance(line.id);
    if TG_TABLE_NAME='payment_applications' then
      if new.kind='Reverso' then
        select coalesce(sum(case a.kind when 'Aplicacion' then s.amount else -s.amount end),0) into available
          from public.billing_application_lines s join public.payment_applications a on a.id=s.application_id
          where s.line_id=line.id and a.payment_id=new.payment_id;
      end if;
    end if;
    if value>available then raise exception 'DOCUMENT_LINE_BALANCE_EXCEEDED';end if;
    allocated:=allocated+value;
    if TG_TABLE_NAME='payment_applications' then insert into public.billing_application_lines(application_id,line_id,amount) values(new.id,line.id,value);
    else insert into public.billing_credit_lines(credit_id,line_id,amount) values(new.id,line.id,value);end if;
  end loop;
  if allocated<>new.amount then raise exception 'DOCUMENT_ALLOCATION_TOTAL_MISMATCH';end if;
  return new;
end $$;
create trigger allocate_application after insert on public.payment_applications for each row execute function private.allocate_document_event();
create trigger allocate_credit after insert on public.billing_credits for each row execute function private.allocate_document_event();
alter function public.execute_billing_command(text,jsonb,uuid) set schema private;
alter function private.execute_billing_command(text,jsonb,uuid) rename to billing_command_before_grouped;
revoke all on function private.billing_command_before_grouped(text,jsonb,uuid) from public,anon,authenticated;
create function public.execute_billing_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text;begin
  previous:=current_setting('aj.billing_allocations',true);
  perform set_config('aj.billing_allocations',coalesce((payload->'allocations')::text,''),true);
  result:=private.billing_command_before_grouped(command,payload,idempotency_key);
  perform set_config('aj.billing_allocations',coalesce(previous,''),true);return result;
end $$;
revoke all on function public.execute_billing_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_billing_command(text,jsonb,uuid) to authenticated;
create function public.issue_grouped_document(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','billing.grouped','payload',payload);
  customer public.customers;job public.work_orders;booking public.reservations;document public.billing_documents;
  row jsonb;line public.billing_document_lines;value numeric;deduction numeric;total numeric:=0;result jsonb;party uuid;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' or jsonb_typeof(payload->'lines') is distinct from 'array'
    or jsonb_array_length(payload->'lines') not between 1 and 200 or nullif(btrim(payload->>'externalReference'),'') is null then raise exception 'INVALID_GROUPED_DOCUMENT';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  select * into customer from public.customers where id=private.canonical_customer((payload->>'customerId')::uuid);
  if customer.id is null then raise exception 'INVALID_CUSTOMER';end if;
  if (payload->>'date')::date is null or not isfinite((payload->>'date')::date)
    or (payload->>'date')::date>(now() at time zone 'America/El_Salvador')::date then raise exception 'INVALID_DATE';end if;
  for row in select v from jsonb_array_elements(payload->'lines') v loop
    if num_nonnulls(row->>'orderId',row->>'reservationId')<>1 then raise exception 'EXACTLY_ONE_BILLING_OPERATION';end if;
    if row->>'orderId' is not null then
      select * into job from public.work_orders where id=row->>'orderId';
      if job.id is null or job.internal_job or (select ownership from public.vehicles where id=job.vehicle_id)='Propio' then raise exception 'EXTERNAL_ORDER_REQUIRED';end if;
      party:=job.customer_id;
    else
      select * into booking from public.reservations where id=(row->>'reservationId')::uuid;
      if booking.id is null then raise exception 'RESERVATION_NOT_FOUND';end if;party:=booking.customer_id;
      if row->>'startsOn' is not null and ((row->>'startsOn')::date<(booking.starts_at at time zone 'America/El_Salvador')::date
        or (row->>'endsOn')::date>(booking.ends_at at time zone 'America/El_Salvador')::date) then raise exception 'INVALID_RENTAL_PERIOD';end if;
    end if;
    if private.canonical_customer(party) is distinct from customer.id then raise exception 'DOCUMENT_CUSTOMER_MISMATCH';end if;
    value:=(row->>'gross')::numeric;deduction:=coalesce((row->>'discount')::numeric,0);
    if value is null or value<=0 or value<>round(value,2) or value::text in ('NaN','Infinity')
      or deduction<0 or deduction>=value or deduction<>round(deduction,2) or deduction::text in ('NaN','Infinity') then raise exception 'INVALID_BILLING_AMOUNT_DATE';end if;
    if deduction>0 and not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception 'DISCOUNT_REQUIRES_MANAGEMENT';end if;
    total:=total+value-deduction;
  end loop;
  insert into public.billing_documents(customer_id,description,amount,issued_on,due_on,source_key,customer_snapshot,created_by,grouped,external_reference)
  values(customer.id,btrim(payload->>'description'),total,(payload->>'date')::date,(payload->>'dueOn')::date,
    nullif(payload->>'sourceKey',''),to_jsonb(customer)-'phone_key'-'document_key',auth.uid(),true,btrim(payload->>'externalReference')) returning * into document;
  for row in select v from jsonb_array_elements(payload->'lines') v loop
    insert into public.billing_document_lines(document_id,order_id,reservation_id,description,gross,discount,discount_reason,starts_on,ends_on,created_by)
    values(document.id,row->>'orderId',(row->>'reservationId')::uuid,btrim(row->>'description'),(row->>'gross')::numeric,
      coalesce((row->>'discount')::numeric,0),coalesce(btrim(row->>'discountReason'),''),(row->>'startsOn')::date,(row->>'endsOn')::date,auth.uid()) returning * into line;
    if line.reservation_id is not null and line.starts_on is not null then
      insert into public.rental_periods(reservation_id,starts_on,ends_on,document_id,document_line_id,reason,created_by)
      values(line.reservation_id,line.starts_on,line.ends_on,document.id,line.id,'Período de documento '||document.external_reference,auth.uid());
    end if;
  end loop;
  result:=to_jsonb(document);insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;
revoke all on function public.issue_grouped_document(jsonb,uuid) from public,anon;
grant execute on function public.issue_grouped_document(jsonb,uuid) to authenticated;
create function public.billing_line_positions(document_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('balance',private.document_line_balance(l.id)))
    from public.billing_document_lines l where l.document_id=billing_line_positions.document_id),'[]');
end $$;
revoke all on function public.billing_line_positions(uuid) from public,anon;
grant execute on function public.billing_line_positions(uuid) to authenticated;

create or replace function private.vehicle_document_sources(vehicle_id uuid,order_id text default null)
returns table(document_id uuid,scope_amount numeric) language sql stable set search_path='' as $$
  select d.id,d.amount from public.billing_documents d left join public.work_orders o on o.id=d.order_id
    left join public.reservations r on r.id=d.reservation_id where not d.grouped and coalesce(o.vehicle_id,r.vehicle_id)=vehicle_document_sources.vehicle_id
    and (vehicle_document_sources.order_id is null or d.order_id=vehicle_document_sources.order_id)
  union all select l.document_id,sum(l.amount) from public.billing_document_lines l left join public.work_orders o on o.id=l.order_id
    left join public.reservations r on r.id=l.reservation_id where coalesce(o.vehicle_id,r.vehicle_id)=vehicle_document_sources.vehicle_id
    and (vehicle_document_sources.order_id is null or l.order_id=vehicle_document_sources.order_id) group by l.document_id;
$$;
create or replace function private.vehicle_application_sources(vehicle_id uuid,order_id text default null)
returns table(application_id uuid,document_id uuid,scope_amount numeric,kind text) language sql stable set search_path='' as $$
  select a.id,a.document_id,a.amount,a.kind from public.payment_applications a join public.billing_documents d on d.id=a.document_id
    join private.vehicle_document_sources(vehicle_application_sources.vehicle_id,vehicle_application_sources.order_id) s on s.document_id=a.document_id where not d.grouped
  union all select a.id,a.document_id,sum(s.amount),a.kind from public.billing_application_lines s
    join public.payment_applications a on a.id=s.application_id join public.billing_document_lines l on l.id=s.line_id
    left join public.work_orders o on o.id=l.order_id left join public.reservations r on r.id=l.reservation_id
    where coalesce(o.vehicle_id,r.vehicle_id)=vehicle_application_sources.vehicle_id
    and (vehicle_application_sources.order_id is null or l.order_id=vehicle_application_sources.order_id) group by a.id;
$$;
create or replace function private.vehicle_credit_sources(vehicle_id uuid,order_id text default null)
returns table(credit_id uuid,document_id uuid,scope_amount numeric) language sql stable set search_path='' as $$
  select c.id,c.document_id,c.amount from public.billing_credits c join public.billing_documents d on d.id=c.document_id
    join private.vehicle_document_sources(vehicle_credit_sources.vehicle_id,vehicle_credit_sources.order_id) s on s.document_id=c.document_id where not d.grouped
  union all select c.id,c.document_id,sum(s.amount) from public.billing_credit_lines s join public.billing_credits c on c.id=s.credit_id
    join public.billing_document_lines l on l.id=s.line_id left join public.work_orders o on o.id=l.order_id
    left join public.reservations r on r.id=l.reservation_id where coalesce(o.vehicle_id,r.vehicle_id)=vehicle_credit_sources.vehicle_id
    and (vehicle_credit_sources.order_id is null or l.order_id=vehicle_credit_sources.order_id) group by c.id;
$$;
create or replace function private.delivery_checklist(order_id text) returns jsonb language plpgsql stable set search_path='' as $$
declare checklist jsonb;job public.work_orders;charged numeric;balance numeric;unbilled boolean;begin
  checklist:=private.delivery_checklist_before_cases(order_id);
  select * into job from public.work_orders o where o.id=delivery_checklist.order_id;
  select coalesce(sum(s.scope_amount),0) into charged from private.vehicle_document_sources(job.vehicle_id,job.id) s;
  select charged-coalesce((select sum(case a.kind when 'Aplicacion' then a.scope_amount else -a.scope_amount end)
    from private.vehicle_application_sources(job.vehicle_id,job.id) a),0)-coalesce((select sum(c.scope_amount)
    from private.vehicle_credit_sources(job.vehicle_id,job.id) c),0) into balance;
  unbilled:=not job.internal_job and job.customer_id is not null and (select ownership from public.vehicles where id=job.vehicle_id)='Cliente' and job.estimate>charged;
  return checklist||jsonb_build_object('estimatedUnpaid',case when job.internal_job then 0 else balance end,'unbilledEstimate',unbilled,
    'pendingEstimate',case when unbilled then 'Cargo del alcance aprobado pendiente de emitir' else checklist->>'pendingEstimate' end);
end $$;
do $$ declare definition text;anchor text:='select coalesce(sum(d.amount),0) into existing from public.billing_documents d where d.order_id=job.id;';begin
  definition:=pg_get_functiondef('public.execute_case_command(text,jsonb,uuid)'::regprocedure);
  if position(anchor in definition)=0 then raise exception 'GROUPED_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,'select coalesce(sum(s.scope_amount),0) into existing from private.vehicle_document_sources(job.vehicle_id,job.id) s;');
end $$;
create or replace function public.reservation_payment_status(reservation_id uuid) returns text language plpgsql stable security definer set search_path='' as $$
declare total numeric;balance numeric;begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  select sum(s.amount),sum(s.balance) into total,balance from (
    select d.amount,private.document_balance(d.id,'infinity'::date) balance from public.billing_documents d where d.reservation_id=reservation_payment_status.reservation_id
    union all select l.amount,private.document_line_balance(l.id) from public.billing_document_lines l where l.reservation_id=reservation_payment_status.reservation_id
  ) s;
  return case when total is null then 'Sin cargos' when balance<=0 then 'Pagado' when balance<total then 'Parcial' else 'Pendiente' end;
end $$;
create or replace function public.rental_paid_through(reservation_id uuid) returns date language plpgsql stable security definer set search_path='' as $$
declare period record;covered date;begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  select (r.starts_at at time zone 'America/El_Salvador')::date-1 into covered from public.reservations r where r.id=reservation_id;
  for period in select p.*,case when p.document_line_id is null then private.document_balance(p.document_id,'infinity'::date)
    else private.document_line_balance(p.document_line_id) end balance from public.rental_periods p
    where p.reservation_id=rental_paid_through.reservation_id order by p.starts_on loop
    exit when period.starts_on>covered+1 or period.balance>0;covered:=greatest(covered,period.ends_on);
  end loop;
  if not exists(select 1 from public.rental_periods p where p.reservation_id=rental_paid_through.reservation_id and p.ends_on=covered) then return null;end if;return covered;
end $$;
