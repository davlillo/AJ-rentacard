-- Capture from any workspace; cash events retain their identity when linked or split.
create table private.connected_money_functions(signature text primary key,definition text not null);
insert into private.connected_money_functions select s,pg_get_functiondef(s::regprocedure) from unnest(array[
  'public.vehicle_case_file(uuid,text)','public.rental_case_file(uuid)','public.cash_diary(date,date,text)']) s;
do $$declare item record;definition text;old_name text;new_name text;begin
  for item in select * from private.connected_money_functions loop
    old_name:=split_part(split_part(item.signature,'(',1),'.',2);
    new_name:=old_name||'_before_connected_money';
    definition:=replace(item.definition,'FUNCTION public.'||old_name||'(','FUNCTION private.'||new_name||'(');
    definition:=replace(definition,old_name||'.',new_name||'.');
    execute definition;
  end loop;
end $$;

alter table public.workshop_costs add column linked_expense_id text references public.expenses;
alter table public.workshop_costs drop constraint cost_kind;
alter table public.workshop_costs add constraint cost_kind check(kind in ('Gasto','Compra directa','Consumo','Gasto vinculado')),
  add constraint linked_cash_cost_source check((kind='Gasto vinculado')=(linked_expense_id is not null));
create unique index linked_expense_order on public.workshop_costs(linked_expense_id,order_id) where linked_expense_id is not null;

create table public.receipt_operation_contexts(
  id uuid primary key default gen_random_uuid(),payment_id uuid not null unique references public.customer_payments,
  order_id text references public.work_orders,reservation_id uuid references public.reservations,
  created_by uuid not null references auth.users,created_at timestamptz not null default now(),
  check(num_nonnulls(order_id,reservation_id)=1)
);
alter table public.receipt_operation_contexts enable row level security;
revoke all on public.receipt_operation_contexts from public,anon,authenticated;
grant select on public.receipt_operation_contexts to authenticated;
create policy receipt_context_read on public.receipt_operation_contexts for select to authenticated using(public.has_permission('expenses.read'));
create trigger receipt_context_audit after insert on public.receipt_operation_contexts for each row execute function private.audit_change();
create trigger receipt_context_immutable before update or delete on public.receipt_operation_contexts for each row execute function private.immutable_quote_record();

create function private.link_workshop_expense(source_expense_id text,allocations jsonb,reason text) returns jsonb
language plpgsql set search_path='' as $$
declare expense public.expenses;job public.work_orders;line jsonb;value numeric;total numeric:=0;result jsonb:='[]';cost public.workshop_costs;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if jsonb_typeof(allocations) is distinct from 'array' or jsonb_array_length(allocations) not between 1 and 50
    or nullif(btrim(reason),'') is null or length(reason)>2000 then raise exception 'EXPENSE_LINK_DETAILS_REQUIRED';end if;
  select * into expense from public.expenses where id=source_expense_id for update;
  if expense.id is null or expense.cost_center_id is distinct from 'workshop' or expense.operation_id is not null
    or expense.vehicle_id is not null or expense.reservation_id is not null or expense.direct_purchase_cost_id is not null
    then raise exception 'EXPENSE_NOT_AVAILABLE_TO_LINK';end if;
  if exists(select 1 from public.workshop_costs where linked_expense_id=expense.id or expense_id=expense.id)
    then raise exception 'EXPENSE_ALREADY_LINKED';end if;
  if (select count(distinct item->>'orderId') from jsonb_array_elements(allocations) item)<>jsonb_array_length(allocations)
    then raise exception 'DUPLICATE_EXPENSE_DESTINATION';end if;
  for line in select item.value from jsonb_array_elements(allocations) item loop
    value:=(line->>'amount')::numeric;
    if value is null or value<=0 or value<>round(value,2) or value::text in ('NaN','Infinity','-Infinity')
      then raise exception 'INVALID_AMOUNT';end if;
    select * into job from public.work_orders where id=line->>'orderId' for update;
    if job.id is null then raise exception 'ORDER_NOT_FOUND';end if;
    if job.status='Entregado' and not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner')
      then raise exception 'DELIVERY_ADJUSTMENT_REQUIRES_MANAGEMENT';end if;
    total:=total+value;
  end loop;
  if total<>expense.amount then raise exception 'EXPENSE_ALLOCATION_TOTAL_MISMATCH';end if;
  for line in select item.value from jsonb_array_elements(allocations) item loop
    insert into public.workshop_costs(order_id,kind,description,quantity,unit_cost,amount,linked_expense_id,occurred_at,reason,created_by)
    values(line->>'orderId','Gasto vinculado',expense.concept,1,(line->>'amount')::numeric,(line->>'amount')::numeric,
      expense.id,expense.date,btrim(reason),auth.uid()) returning * into cost;
    result:=result||jsonb_build_array(to_jsonb(cost));
  end loop;
  return jsonb_build_object('id',expense.id,'costs',result);
end $$;

create function public.link_workshop_expense(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','money.link_expense','payload',payload);result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  result:=private.link_workshop_expense(payload->>'expenseId',payload->'allocations',payload->>'reason');
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;

create function public.record_linked_expense(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','money.expense','payload',payload);
  result jsonb;body jsonb;allocations jsonb:=coalesce(payload->'allocations','[]');
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' or jsonb_typeof(allocations) is distinct from 'array'
    then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  body:=payload-'allocations'-'reason';
  if jsonb_array_length(allocations)>0 then
    if num_nonnulls(nullif(payload->>'operationId',''),nullif(payload->>'vehicleId',''),nullif(payload->>'reservationId',''))>0
      then raise exception 'EXPENSE_LINK_DETAILS_REQUIRED';end if;
    body:=body||jsonb_build_object('costCenterId','workshop');
  end if;
  result:=public.execute_command('record_expense',body,gen_random_uuid());
  if jsonb_array_length(allocations)>0 then
    result:=result||private.link_workshop_expense(result->>'id',allocations,payload->>'reason');
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;

create function public.workshop_expense_inbox() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return coalesce((select jsonb_agg(to_jsonb(e) order by e.date desc,e.id) from public.expenses e
    where e.cost_center_id='workshop' and e.operation_id is null and e.vehicle_id is null and e.reservation_id is null
    and e.direct_purchase_cost_id is null
    and not exists(select 1 from public.workshop_costs c where c.linked_expense_id=e.id or c.expense_id=e.id)),'[]');
end $$;

create function public.record_linked_receipt(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','money.receipt','payload',payload);
  customer uuid;operation_customer uuid;document public.billing_documents;receipt jsonb;application jsonb;result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object'
    or num_nonnulls(nullif(payload->>'orderId',''),nullif(payload->>'reservationId',''))>1 then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  customer:=private.canonical_customer((payload->>'customerId')::uuid);
  if not exists(select 1 from public.customers where id=customer and merged_into is null) then raise exception 'INVALID_CUSTOMER';end if;
  if nullif(payload->>'orderId','') is not null then
    select customer_id into operation_customer from public.work_orders where id=payload->>'orderId' and not internal_job;
    if operation_customer is null then raise exception 'INTERNAL_VEHICLE_NOT_A_SALE';end if;
  elsif nullif(payload->>'reservationId','') is not null then
    select customer_id into operation_customer from public.reservations where id=(payload->>'reservationId')::uuid;
    if operation_customer is null then raise exception 'RESERVATION_NOT_FOUND';end if;
  end if;
  if operation_customer is not null and private.canonical_customer(operation_customer)<>customer then raise exception 'PAYMENT_CUSTOMER_MISMATCH';end if;
  if nullif(payload->>'documentId','') is not null then
    select * into document from public.billing_documents where id=(payload->>'documentId')::uuid;
    if document.id is null then raise exception 'DOCUMENT_NOT_FOUND';end if;
    if private.canonical_customer(document.customer_id)<>customer then raise exception 'PAYMENT_CUSTOMER_MISMATCH';end if;
    if (nullif(payload->>'orderId','') is not null and document.order_id is distinct from payload->>'orderId')
      or (nullif(payload->>'reservationId','') is not null and document.reservation_id is distinct from (payload->>'reservationId')::uuid)
      then raise exception 'CASE_DOCUMENT_REQUIRED';end if;
  elsif nullif(payload->>'paymentId','') is not null then raise exception 'CASE_DOCUMENT_REQUIRED';
  end if;
  if nullif(payload->>'paymentId','') is null then
    receipt:=public.execute_billing_command('pay',payload||jsonb_build_object('customerId',customer),gen_random_uuid());
    if operation_customer is not null then
      insert into public.receipt_operation_contexts(payment_id,order_id,reservation_id,created_by)
      values((receipt->>'id')::uuid,nullif(payload->>'orderId',''),nullif(payload->>'reservationId','')::uuid,auth.uid());
    end if;
  else receipt:=jsonb_build_object('id',payload->>'paymentId');end if;
  if document.id is not null then
    application:=public.execute_billing_command('apply',payload||jsonb_build_object('paymentId',receipt->>'id'),gen_random_uuid());
  end if;
  result:=jsonb_build_object('receipt',receipt,'application',application);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;

create function public.record_connected_quote(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','money.quote','payload',payload);
  result jsonb;line jsonb;cost public.workshop_costs;line_index integer:=0;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  result:=public.save_workshop_quote(payload,gen_random_uuid());
  if (select count(*)<>count(distinct item->>'sourceCostId') from jsonb_array_elements(payload->'lines') item
    where nullif(item->>'sourceCostId','') is not null) then raise exception 'DUPLICATE_COST_ORIGIN';end if;
  for line in select item.value from jsonb_array_elements(payload->'lines') item loop
    if nullif(line->>'sourceCostId','') is not null then
      select * into cost from public.workshop_costs where id=(line->>'sourceCostId')::uuid for update;
      if cost.id is null or cost.order_id is distinct from result->>'order_id' then raise exception 'ESTIMATE_LINE_MISMATCH';end if;
      if cost.version is distinct from (line->>'sourceCostVersion')::integer then raise exception 'VERSION_CONFLICT';end if;
      perform public.execute_case_command('allocate_cost',jsonb_build_object('costId',cost.id,'expectedVersion',cost.version,
        'reason','Vínculo al incorporar el costo en una nueva versión del presupuesto.','lines',jsonb_build_array(jsonb_build_object(
          'estimateId',result->>'id','lineIndex',line_index,'amount',cost.amount,'description',line->>'description'))),gen_random_uuid());
    end if;
    line_index:=line_index+1;
  end loop;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;

create function private.receipt_available(payment_id uuid) returns numeric language sql stable set search_path='' as $$
  select p.amount-coalesce((select sum(case a.kind when 'Aplicacion' then a.amount else -a.amount end)
    from public.payment_applications a where a.payment_id=p.id),0)
    -coalesce((select sum(r.amount) from public.payment_refunds r where r.payment_id=p.id),0)
  from public.customer_payments p where p.id=receipt_available.payment_id;
$$;
create function private.cash_operation_links() returns table(source_type text,source_id text,order_id text,reservation_id uuid,amount numeric,kind text)
language sql stable set search_path='' as $$
  select 'expense',e.id,e.operation_id,e.reservation_id,e.amount,'Gasto' from public.expenses e
    where e.operation_id is not null or e.reservation_id is not null
  union all select 'expense',c.linked_expense_id,c.order_id,null,sum(c.amount),'Gasto repartido'
    from public.workshop_costs c where c.linked_expense_id is not null group by c.linked_expense_id,c.order_id
  union all select 'receipt',a.payment_id::text,d.order_id,d.reservation_id,
    sum(case a.kind when 'Aplicacion' then a.amount else -a.amount end),'Abono aplicado'
    from public.payment_applications a join public.billing_documents d on d.id=a.document_id where not d.grouped
    group by a.payment_id,d.order_id,d.reservation_id having sum(case a.kind when 'Aplicacion' then a.amount else -a.amount end)>0
  union all select 'receipt',a.payment_id::text,l.order_id,l.reservation_id,
    sum(case a.kind when 'Aplicacion' then s.amount else -s.amount end),'Abono aplicado'
    from public.billing_application_lines s join public.payment_applications a on a.id=s.application_id
    join public.billing_document_lines l on l.id=s.line_id group by a.payment_id,l.order_id,l.reservation_id
    having sum(case a.kind when 'Aplicacion' then s.amount else -s.amount end)>0
  union all select 'receipt',c.payment_id::text,c.order_id,c.reservation_id,private.receipt_available(c.payment_id),'Anticipo sin aplicar'
    from public.receipt_operation_contexts c where private.receipt_available(c.payment_id)>0;
$$;

create or replace function public.vehicle_case_file(vehicle_id uuid,order_id text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;begin
  result:=private.vehicle_case_file_before_connected_money(vehicle_id,order_id);
  if not public.has_permission('expenses.read') then return result;end if;
  result:=result||jsonb_build_object('expenses',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object(
    'scope_amount',coalesce(s.amount,e.amount),'shared',coalesce(s.amount,e.amount)<>e.amount) order by e.date desc,e.id)
    from public.expenses e left join (
      select c.linked_expense_id,sum(c.amount) amount from public.workshop_costs c join public.work_orders o on o.id=c.order_id
      where o.vehicle_id=vehicle_case_file.vehicle_id and (vehicle_case_file.order_id is null or o.id=vehicle_case_file.order_id)
      group by c.linked_expense_id) s on s.linked_expense_id=e.id
    where s.amount is not null or exists(select 1 from jsonb_array_elements(result->'expenses') item where item->>'id'=e.id)),'[]'),
    'advances',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('available_amount',private.receipt_available(p.id)))
      from public.receipt_operation_contexts c join public.customer_payments p on p.id=c.payment_id
      left join public.work_orders o on o.id=c.order_id left join public.reservations r on r.id=c.reservation_id
      where coalesce(o.vehicle_id,r.vehicle_id)=vehicle_case_file.vehicle_id
      and (vehicle_case_file.order_id is null or c.order_id=vehicle_case_file.order_id) and private.receipt_available(p.id)>0),'[]'));
  return result;
end $$;
create or replace function public.rental_case_file(reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;begin
  result:=private.rental_case_file_before_connected_money(reservation_id);
  if public.has_permission('expenses.read') then result:=result||jsonb_build_object('advances',coalesce((
    select jsonb_agg(to_jsonb(p)||jsonb_build_object('available_amount',private.receipt_available(p.id)))
    from public.receipt_operation_contexts c join public.customer_payments p on p.id=c.payment_id
    where c.reservation_id=rental_case_file.reservation_id and private.receipt_available(p.id)>0),'[]'));end if;
  return result;
end $$;
create or replace function public.cash_diary(from_date date,to_date date,account_filter text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;rows jsonb;begin
  result:=private.cash_diary_before_connected_money(from_date,to_date,account_filter);
  select coalesce(jsonb_agg(item||jsonb_build_object(
    'links',coalesce((select jsonb_agg(jsonb_build_object('orderId',l.order_id,'reservationId',l.reservation_id,'amount',l.amount,'kind',l.kind)
      order by l.order_id,l.reservation_id,l.kind) from private.cash_operation_links() l
      where l.source_type=item->>'source_type' and l.source_id=split_part(item->>'id',':',2)),'[]'),
    'linkable',item->>'source_type'='expense' and exists(select 1 from public.expenses e where e.id=split_part(item->>'id',':',2)
      and e.cost_center_id='workshop' and e.operation_id is null and e.vehicle_id is null and e.reservation_id is null
      and not exists(select 1 from public.workshop_costs c where c.linked_expense_id=e.id or c.expense_id=e.id)),
    'unapplied_amount',case when item->>'source_type'='receipt' then private.receipt_available(split_part(item->>'id',':',2)::uuid) else 0 end,
    'customer_id',case when item->>'source_type'='receipt' then (select p.customer_id from public.customer_payments p where p.id=split_part(item->>'id',':',2)::uuid) end,
    'folio_number',case when item->>'source_type'='receipt' then (select p.folio_number from public.customer_payments p where p.id=split_part(item->>'id',':',2)::uuid) end)
    order by item->>'date',item->>'id'),'[]') into rows from jsonb_array_elements(result->'rows') item;
  return result||jsonb_build_object('rows',rows);
end $$;

revoke all on function private.link_workshop_expense(text,jsonb,text),private.receipt_available(uuid),private.cash_operation_links(),
  private.vehicle_case_file_before_connected_money(uuid,text),private.rental_case_file_before_connected_money(uuid),
  private.cash_diary_before_connected_money(date,date,text) from public,anon,authenticated;
revoke all on function public.link_workshop_expense(jsonb,uuid),public.record_linked_expense(jsonb,uuid),
  public.workshop_expense_inbox(),public.record_linked_receipt(jsonb,uuid),public.record_connected_quote(jsonb,uuid) from public,anon;
grant execute on function public.link_workshop_expense(jsonb,uuid),public.record_linked_expense(jsonb,uuid),
  public.workshop_expense_inbox(),public.record_linked_receipt(jsonb,uuid),public.record_connected_quote(jsonb,uuid) to authenticated;
