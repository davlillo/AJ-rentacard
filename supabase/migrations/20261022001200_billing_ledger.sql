-- HU18/HU19: documents, cash receipts and applications are distinct immutable ledger events.
create table public.billing_documents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers,
  order_id text references public.work_orders,
  reservation_id uuid references public.reservations,
  description text not null check(length(btrim(description))>0),
  amount numeric(14,2) not null check(amount>0 and amount::text not in ('NaN','Infinity')),
  issued_on date not null,
  due_on date not null,
  source_key text unique,
  customer_snapshot jsonb not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  check(num_nonnulls(order_id,reservation_id)=1),
  check(due_on>=issued_on)
);
create table public.customer_payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers,
  amount numeric(14,2) not null check(amount>0 and amount::text not in ('NaN','Infinity')),
  paid_on date not null,
  method text not null check(method in ('Efectivo','Transferencia','Tarjeta')),
  account text not null check(length(btrim(account))>0),
  reference text not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
create table public.payment_applications (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.customer_payments,
  document_id uuid not null references public.billing_documents,
  amount numeric(14,2) not null check(amount>0 and amount::text not in ('NaN','Infinity')),
  kind text not null default 'Aplicacion' check(kind in ('Aplicacion','Reverso')),
  effective_on date not null,
  reason text not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.customer_payments,
  document_id uuid references public.billing_documents,
  amount numeric(14,2) not null check(amount>0 and amount::text not in ('NaN','Infinity')),
  refunded_on date not null,
  reason text not null check(length(btrim(reason))>0),
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
create table public.billing_credits (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.billing_documents,
  amount numeric(14,2) not null check(amount>0 and amount::text not in ('NaN','Infinity')),
  credited_on date not null,
  reason text not null check(length(btrim(reason))>0),
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
do $$ declare tbl text; begin
  foreach tbl in array array['billing_documents','customer_payments','payment_applications','payment_refunds','billing_credits'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from anon,authenticated',tbl);
    execute format('grant select on public.%I to authenticated',tbl);
    execute format('create policy billing_read on public.%I for select to authenticated using(public.has_permission(''expenses.read''))',tbl);
    execute format('create trigger billing_audit after insert on public.%I for each row execute function private.audit_change()',tbl);
    execute format('create trigger billing_immutable before update or delete on public.%I for each row execute function private.immutable_quote_record()',tbl);
  end loop;
end $$;

-- Monetary facts/snapshots stay frozen; current customer identity is resolved through merge aliases.
create function private.canonical_customer(id uuid) returns uuid language sql stable set search_path='' as $$
  with recursive chain as (
    select c.id,c.merged_into from public.customers c where c.id=canonical_customer.id
    union all select c.id,c.merged_into from public.customers c join chain on c.id=chain.merged_into
  ) select chain.id from chain where merged_into is null limit 1;
$$;
create function private.document_balance(document_id uuid,cutoff date) returns numeric language sql stable set search_path='' as $$
  select d.amount-coalesce((select sum(c.amount) from public.billing_credits c where c.document_id=d.id
    and c.credited_on<=cutoff and c.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'),0)
    -coalesce((select sum(case a.kind when 'Aplicacion' then a.amount else -a.amount end) from public.payment_applications a where a.document_id=d.id
    and a.effective_on<=cutoff and a.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'),0)
  from public.billing_documents d where d.id=document_balance.document_id;
$$;
create function public.receivables_at(cutoff date) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if cutoff is null or not isfinite(cutoff) then raise exception 'CUTOFF_REQUIRED'; end if;
  return coalesce((select jsonb_agg(to_jsonb(row)) from (
    select d.*,private.canonical_customer(d.customer_id) as current_customer_id,
      private.document_balance(d.id,cutoff) as balance,greatest(cutoff-d.due_on,0) as days_overdue,
      case when d.due_on>=cutoff then 'Por vencer' when cutoff-d.due_on<=30 then '1-30'
      when cutoff-d.due_on<=60 then '31-60' when cutoff-d.due_on<=90 then '61-90' else '90+' end as aging_bucket
    from public.billing_documents d where d.issued_on<=cutoff and d.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'
  ) row),'[]');
end;
$$;
create function public.reservation_payment_status(reservation_id uuid) returns text language plpgsql stable security definer set search_path='' as $$
declare total numeric;balance numeric;
begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  select sum(d.amount),sum(private.document_balance(d.id,'infinity'::date)) into total,balance
    from public.billing_documents d where d.reservation_id=reservation_payment_status.reservation_id;
  return case when total is null then 'Sin cargos' when balance<=0 then 'Pagado' when balance<total then 'Parcial' else 'Pendiente' end;
end;
$$;

create function public.execute_billing_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','billing.'||command,'payload',payload);
  document public.billing_documents;
  payment public.customer_payments;
  customer public.customers;
  booking public.reservations;
  service_order public.work_orders;
  applied numeric;
  available numeric;
  value numeric;
  result jsonb;
  event_date date;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if command is null or command not in ('issue','pay','apply','refund','credit') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_BILLING_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  value:=(payload->>'amount')::numeric;event_date:=(payload->>'date')::date;
  if value is null or value<=0 or value<>round(value,2) or value::text in ('NaN','Infinity') or event_date is null
    or not isfinite(event_date) or event_date>(now() at time zone 'America/El_Salvador')::date then raise exception 'INVALID_BILLING_AMOUNT_DATE'; end if;
  if command='issue' then
    if num_nonnulls(payload->>'orderId',payload->>'reservationId')<>1 then raise exception 'EXACTLY_ONE_BILLING_OPERATION'; end if;
    if payload->>'reservationId' is not null then
      select * into booking from public.reservations where id=(payload->>'reservationId')::uuid;
      if booking.id is null then raise exception 'RESERVATION_NOT_FOUND'; end if;
      select * into customer from public.customers where id=private.canonical_customer(booking.customer_id);
    else
      select * into service_order from public.work_orders where id=payload->>'orderId';
      if service_order.id is null then raise exception 'ORDER_NOT_FOUND'; end if;
      if exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership='Propio') then raise exception 'INTERNAL_VEHICLE_NOT_A_SALE'; end if;
      select * into customer from public.customers where id=private.canonical_customer(service_order.customer_id);
    end if;
    insert into public.billing_documents(customer_id,order_id,reservation_id,description,amount,issued_on,due_on,customer_snapshot,created_by)
    values(customer.id,service_order.id,booking.id,btrim(payload->>'description'),value,event_date,(payload->>'dueOn')::date,
      to_jsonb(customer)-'phone_key'-'document_key',auth.uid()) returning * into document;
    result:=to_jsonb(document);
  elsif command='pay' then
    select * into customer from public.customers where id=private.canonical_customer((payload->>'customerId')::uuid);
    if customer.id is null then raise exception 'INVALID_CUSTOMER'; end if;
    insert into public.customer_payments(customer_id,amount,paid_on,method,account,reference,created_by)
    values(customer.id,value,event_date,payload->>'method',btrim(payload->>'account'),coalesce(payload->>'reference',''),auth.uid()) returning * into payment;
    result:=to_jsonb(payment);
  else
    if command<>'credit' then
      select * into payment from public.customer_payments where id=(payload->>'paymentId')::uuid for update;
      if payment.id is null then raise exception 'PAYMENT_NOT_FOUND'; end if;
      select coalesce(sum(case kind when 'Aplicacion' then amount else -amount end),0) into applied from public.payment_applications where payment_id=payment.id;
      select payment.amount-applied-coalesce(sum(amount),0) into available from public.payment_refunds where payment_id=payment.id;
      if event_date<payment.paid_on then raise exception 'APPLICATION_PREDATES_PAYMENT'; end if;
      if event_date<(select max(d) from (select effective_on d from public.payment_applications where payment_id=payment.id
        union all select refunded_on from public.payment_refunds where payment_id=payment.id) dates) then raise exception 'BILLING_EVENT_OUT_OF_ORDER'; end if;
    end if;
    if command<>'refund' or payload->>'documentId' is not null then
      select * into document from public.billing_documents where id=(payload->>'documentId')::uuid for update;
      if document.id is null then raise exception 'DOCUMENT_NOT_FOUND'; end if;
      if event_date<document.issued_on then raise exception 'APPLICATION_PREDATES_DOCUMENT'; end if;
      if event_date<(select max(d) from (select effective_on d from public.payment_applications where document_id=document.id
        union all select credited_on from public.billing_credits where document_id=document.id) dates) then raise exception 'BILLING_EVENT_OUT_OF_ORDER'; end if;
    end if;
    if command='apply' then
      if private.canonical_customer(payment.customer_id)<>private.canonical_customer(document.customer_id) then raise exception 'PAYMENT_CUSTOMER_MISMATCH'; end if;
      if value>available or value>private.document_balance(document.id,'infinity'::date) then raise exception 'PAYMENT_EXCEEDS_AVAILABLE_BALANCE'; end if;
      insert into public.payment_applications(payment_id,document_id,amount,effective_on,reason,created_by)
      values(payment.id,document.id,value,event_date,'Aplicación confirmada',auth.uid()) returning to_jsonb(payment_applications.*) into result;
    elsif command='credit' then
      if nullif(btrim(payload->>'reason'),'') is null or value>private.document_balance(document.id,'infinity'::date) then raise exception 'INVALID_CREDIT'; end if;
      insert into public.billing_credits(document_id,amount,credited_on,reason,created_by)
      values(document.id,value,event_date,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(billing_credits.*) into result;
    else
      if nullif(btrim(payload->>'reason'),'') is null then raise exception 'REFUND_REASON_REQUIRED'; end if;
      if document.id is not null then
        select coalesce(sum(case kind when 'Aplicacion' then amount else -amount end),0) into applied
          from public.payment_applications where payment_id=payment.id and document_id=document.id;
        if value>applied then raise exception 'REFUND_EXCEEDS_APPLICATION'; end if;
        insert into public.payment_applications(payment_id,document_id,amount,kind,effective_on,reason,created_by)
        values(payment.id,document.id,value,'Reverso',event_date,btrim(payload->>'reason'),auth.uid());
      elsif value>available then raise exception 'REFUND_EXCEEDS_AVAILABLE_PAYMENT'; end if;
      insert into public.payment_refunds(payment_id,document_id,amount,refunded_on,reason,created_by)
      values(payment.id,document.id,value,event_date,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(payment_refunds.*) into result;
    end if;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;
revoke all on function public.receivables_at(date),public.reservation_payment_status(uuid),public.execute_billing_command(text,jsonb,uuid) from public,anon;
grant execute on function public.receivables_at(date),public.reservation_payment_status(uuid),public.execute_billing_command(text,jsonb,uuid) to authenticated;
create function public.reservation_payment_summary() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  return coalesce((select jsonb_object_agg(r.id,public.reservation_payment_status(r.id)) from public.reservations r),'{}');
end;
$$;
revoke all on function public.reservation_payment_summary() from public,anon;
grant execute on function public.reservation_payment_summary() to authenticated;
