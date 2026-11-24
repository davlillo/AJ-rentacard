--
-- AJ Rentacar - esquema completo para Supabase (hosted)
-- Generado con pg_dump 17.6 (schema-only, no-owner) desde la base local.
-- Schemas: public + private (sin tablas de respaldo/artefactos de migracion).
-- Extension: btree_gist (schema public).
-- Aplicar en el SQL Editor del proyecto Supabase con ON_ERROR_STOP.
--

CREATE SCHEMA IF NOT EXISTS auth;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: private; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS private;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: allocate_document_event(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.allocate_document_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: audit_change(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.audit_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  insert into public.audit_events(actor, entity, entity_id, action, before_data, after_data)
  values (auth.uid(), TG_TABLE_NAME, new.id::text, TG_OP,
    case when TG_OP = 'UPDATE' then to_jsonb(old) else null end, to_jsonb(new));
  return new;
end;
$$;


--
-- Name: billing_command_before_grouped(text, jsonb, uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.billing_command_before_grouped(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
      if service_order.internal_job or exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership='Propio') then raise exception 'INTERNAL_VEHICLE_NOT_A_SALE'; end if;
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


--
-- Name: business_command_before_cases(text, jsonb, uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.business_command_before_cases(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  required_permission text;
  prior private.command_results;
  source public.customers;
  target public.customers;
  car public.vehicles;
  entity_id text;
  result jsonb;
begin
  required_permission := case command
    when 'create_customer' then 'customers.write' when 'merge_customer' then 'customers.merge'
    when 'create_vehicle' then 'vehicles.write' when 'receive_vehicle' then 'orders.write'
    when 'record_expense' then 'expenses.write' end;
  if required_permission is null then raise exception using errcode = '22023', message = 'UNKNOWN_COMMAND'; end if;
  if not public.has_permission(required_permission) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'INVALID_REQUEST';
  end if;
  -- Pilot-wide mutation lock: serializes cross-entity merges and reception safely.
  -- Replace with ordered aggregate locks when measured throughput requires it.
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor = auth.uid() and key = idempotency_key;
  if found then
    if prior.request <> jsonb_build_object('command',command,'payload',payload) then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return prior.result;
  end if;

  if command = 'create_customer' then
    if exists (select 1 from public.customer_matches(coalesce(payload->>'phone',''),coalesce(payload->>'document',''))) then
      raise exception using errcode = '23505', message = 'CUSTOMER_MATCH_EXISTS';
    end if;
    insert into public.customers(name,phone,document,email,type)
    values (btrim(payload->>'name'),btrim(payload->>'phone'),coalesce(btrim(payload->>'document'),''),
      coalesce(btrim(payload->>'email'),''),payload->>'type') returning id::text into entity_id;

  elsif command = 'merge_customer' then
    select * into source from public.customers where id = (payload->>'sourceId')::uuid for update;
    select * into target from public.customers where id = (payload->>'targetId')::uuid for update;
    if source.id is null or target.id is null or source.id = target.id or source.merged_into is not null
      or target.merged_into is not null or nullif(btrim(payload->>'reason'),'') is null then
      raise exception using errcode = '22023', message = 'INVALID_MERGE';
    end if;
    if (payload->>'sourceVersion')::integer is distinct from source.version
      or (payload->>'targetVersion')::integer is distinct from target.version then
      raise exception using errcode = '23505', message = 'VERSION_CONFLICT';
    end if;
    insert into public.customer_aliases(source_id,customer_id,snapshot,phone_key,document_key)
    values (source.id,target.id,to_jsonb(source),source.phone_key,source.document_key);
    update public.customer_aliases set customer_id = target.id where customer_id = source.id;
    update public.vehicles set owner_customer_id = target.id, version = version + 1 where owner_customer_id = source.id;
    update public.work_orders set customer_id = target.id, version = version + 1 where customer_id = source.id;
    update public.customers set merged_into = target.id, version = version + 1 where id = source.id;
    update public.customers set version = version + 1 where id = target.id;
    insert into public.audit_events(actor,entity,entity_id,action,before_data,after_data)
    values (auth.uid(),'customers',target.id::text,'MERGE',to_jsonb(source),
      jsonb_build_object('targetId',target.id,'reason',btrim(payload->>'reason')));
    entity_id := target.id::text;

  elsif command = 'create_vehicle' then
    if payload->>'ownership' = 'Cliente' and not exists (
      select 1 from public.customers where id = (payload->>'ownerCustomerId')::uuid and merged_into is null
    ) then raise exception using errcode = '22023', message = 'INVALID_OWNER'; end if;
    insert into public.vehicles(plate,vin,brand,model,year,category,color,daily,km,ownership,owner_customer_id)
    values (btrim(payload->>'plate'),nullif(payload->>'vin',''),btrim(payload->>'brand'),btrim(payload->>'model'),
      (payload->>'year')::integer,payload->>'category',payload->>'color',(payload->>'daily')::numeric,
      (payload->>'km')::integer,payload->>'ownership',nullif(payload->>'ownerCustomerId','')::uuid)
    returning id::text into entity_id;

  elsif command = 'receive_vehicle' then
    if not exists (select 1 from public.customers where id = (payload->>'customerId')::uuid and merged_into is null) then
      raise exception using errcode = '22023', message = 'INVALID_CUSTOMER';
    end if;
    select * into car from public.vehicles where id = (payload->>'vehicleId')::uuid for update;
    if car.id is null or car.status <> 'Disponible' then
      raise exception using errcode = '23505', message = 'VEHICLE_UNAVAILABLE';
    end if;
    insert into public.work_orders(vehicle_id,customer_id,area,service,due,created_by)
    values (car.id,(payload->>'customerId')::uuid,payload->>'area',btrim(payload->>'service'),
      coalesce((payload->>'due')::date,(now() at time zone 'America/El_Salvador')::date),auth.uid())
    returning id into entity_id;
    update public.vehicles set status = 'En taller', version = version + 1 where id = car.id;

  elsif command = 'record_expense' then
    if payload->>'operationId' is not null and not exists (
      select 1 from public.work_orders where id = payload->>'operationId' and status <> 'Entregado'
    ) then raise exception using errcode = '22023', message = 'INVALID_OPERATION'; end if;
    insert into public.expenses(date,concept,category,amount,method,account,operation_id,cost_center_id,support,created_by)
    values ((payload->>'date')::date,btrim(payload->>'concept'),btrim(payload->>'category'),
      (payload->>'amount')::numeric,payload->>'method',btrim(payload->>'account'),payload->>'operationId',
      payload->>'costCenterId',coalesce(payload->>'support',''),auth.uid()) returning id into entity_id;
  end if;
  result := jsonb_build_object('id',entity_id,'command',command,'createdAt',now());
  insert into private.command_results values (auth.uid(),idempotency_key,
    jsonb_build_object('command',command,'payload',payload),result);
  return result;
end;
$$;


--
-- Name: calculate_estimate(jsonb, text, numeric, numeric); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.calculate_estimate(lines jsonb, method text, ratio numeric, discount numeric) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  input jsonb;
  tariff public.workshop_tariffs;
  quantity numeric;
  normalized jsonb := '[]';
  cost numeric := 0;
  commercial numeric := 0;
  subtotal numeric;
  total numeric;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) not between 1 and 200 then raise exception 'INVALID_ESTIMATE_LINES'; end if;
  if method not in ('commercial','margin','markup') or method is null then raise exception 'INVALID_PRICING_METHOD'; end if;
  if discount is null or discount < 0 or discount <> round(discount,2) or discount::text in ('NaN','Infinity') then raise exception 'INVALID_DISCOUNT'; end if;
  if (method = 'commercial' and ratio is not null) or (method <> 'commercial' and
    (ratio is null or ratio < 0 or ratio::text in ('NaN','Infinity') or (method = 'margin' and ratio >= 1))) then
    raise exception 'INVALID_PRICING_RATIO';
  end if;
  for input in select value from jsonb_array_elements(lines) loop
    select * into tariff from public.workshop_tariffs where id = (input->>'tariffId')::uuid;
    quantity := (input->>'quantity')::numeric;
    if tariff.id is null or quantity is null or quantity <= 0 or quantity > 1000000
      or quantity <> round(quantity,4) or quantity::text in ('NaN','Infinity') then raise exception 'INVALID_ESTIMATE_LINE'; end if;
    cost := cost + round(tariff.unit_cost * quantity,2);
    commercial := commercial + round(tariff.unit_price * quantity,2);
    normalized := normalized || jsonb_build_array(jsonb_build_object('tariffId',tariff.id,'code',tariff.code,
      'tariffRevision',tariff.revision,'description',tariff.description,'kind',tariff.kind,'quantity',quantity,
      'unitCost',tariff.unit_cost,'unitPrice',tariff.unit_price,
      'cost',round(tariff.unit_cost * quantity,2),'price',round(tariff.unit_price * quantity,2)));
  end loop;
  subtotal := case method when 'margin' then round(cost / (1-ratio),2)
    when 'markup' then round(cost * (1+ratio),2) else commercial end;
  total := subtotal - discount;
  if total <= 0 or total > 999999999999.99 then raise exception 'INVALID_ESTIMATE_TOTAL'; end if;
  return jsonb_build_object('policy','before-tax-v1','currency','USD','rounding','half-up-per-line-2-decimals',
    'method',method,'ratio',ratio,'lines',normalized,'cost',cost,'commercial',commercial,'subtotal',subtotal,
    'discount',discount,'total',total,'margin',total-cost,'marginPct',round((total-cost)/total*100,2));
end;
$$;


--
-- Name: canonical_customer(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.canonical_customer(id uuid) RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  with recursive chain as (
    select c.id,c.merged_into from public.customers c where c.id=canonical_customer.id
    union all select c.id,c.merged_into from public.customers c join chain on c.id=chain.merged_into
  ) select chain.id from chain where merged_into is null limit 1;
$$;


--
-- Name: capture_oct30_function(text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.capture_oct30_function(signature text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  insert into private.oct30_functions values(signature,pg_get_functiondef(signature::regprocedure)) on conflict do nothing;
end $$;


--
-- Name: capture_refund_account(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.capture_refund_account() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin new.refund_account:=coalesce(nullif(btrim(current_setting('aj.refund_account',true)),''),'');return new;end $$;


--
-- Name: cash_diary_before_connected_money(date, date, text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.cash_diary_before_connected_money(from_date date, to_date date, account_filter text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare rows jsonb;opening public.cash_entries;before_balance numeric;net numeric;income numeric;outgoing numeric;unassigned integer;
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if from_date is null or to_date is null or not isfinite(from_date) or not isfinite(to_date) or to_date<from_date then raise exception 'INVALID_DIARY_RANGE';end if;
  if (select count(*) from private.diary_sources() s where s.date between from_date and to_date)>10000 then raise exception 'NARROW_DIARY_RANGE';end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.date,r.id),'[]'),coalesce(sum(r.inflow),0),coalesce(sum(r.outflow),0),coalesce(sum(r.balance_effect),0)
    into rows,income,outgoing,net from (
    select s.*,case when s.kind='Ingreso' or s.kind='Ingreso no comercial' or (s.kind='Transferencia' and s.counter_account=account_filter) then s.amount else 0 end inflow,
      case when s.kind in ('Egreso','Salida no operativa') or (s.kind='Transferencia' and s.account=account_filter) then s.amount else 0 end outflow,
      case when s.kind='Apertura' then 0 when s.kind in ('Ingreso','Ingreso no comercial') then s.amount
        when s.kind in ('Egreso','Salida no operativa') then -s.amount when s.kind='Transferencia' and s.counter_account=account_filter then s.amount
        when s.kind='Transferencia' and s.account=account_filter then -s.amount else 0 end balance_effect
    from private.diary_sources() s where s.date between from_date and to_date
      and (account_filter is null or account_filter in (s.account,s.counter_account))
  ) r;
  select count(*) into unassigned from private.diary_sources() s where s.date<=to_date and s.account is null;
  if account_filter is not null then
    select * into opening from public.cash_entries c where c.kind='Apertura' and c.account=account_filter and c.date<=from_date;
    if opening.id is not null and unassigned=0 then
      select opening.amount+coalesce(sum(case when s.kind in ('Ingreso','Ingreso no comercial') then s.amount
        when s.kind in ('Egreso','Salida no operativa') then -s.amount when s.kind='Transferencia' and s.counter_account=account_filter then s.amount
        when s.kind='Transferencia' and s.account=account_filter then -s.amount else 0 end),0) into before_balance
      from private.diary_sources() s where s.date>=opening.date and s.date<from_date and account_filter in(s.account,s.counter_account);
    end if;
  end if;
  return jsonb_build_object('rows',rows,'income',income,'outgoing',outgoing,'netMovement',net,'balanceBefore',before_balance,
    'balanceAfter',case when before_balance is not null then before_balance+net else null end,
    'hasOpening',opening.id is not null,'unassignedRefunds',unassigned,'opening',to_jsonb(opening),
    'accounts',coalesce((select jsonb_agg(a.account order by a.account) from (select distinct s.account from private.diary_sources() s where s.account is not null
      union select distinct s.counter_account from private.diary_sources() s where s.counter_account is not null) a),'[]'),
    'policy','cash-events-once-v1; documents-and-applications-are-not-cash; unknown-refund-accounts-remain-unassigned');
end $$;


--
-- Name: cash_operation_links(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.cash_operation_links() RETURNS TABLE(source_type text, source_id text, order_id text, reservation_id uuid, amount numeric, kind text)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
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


--
-- Name: check_cost_allocation_net(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.check_cost_allocation_net() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.amount<old.amount and (select coalesce(sum(amount),0) from public.cost_allocations where cost_id=new.id and active)>new.amount then
    raise exception 'CLEAR_ALLOCATIONS_BEFORE_COST_RETURN';end if;return new;
end $$;


--
-- Name: contract_winansi_hex(text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.contract_winansi_hex(value text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare result text:='';idx integer;code integer;character text;extended integer;
begin
  for idx in 1..length(value) loop
    character:=substring(value from idx for 1);code:=ascii(character);
    if not(code between 32 and 126 or code between 160 and 255) then
      extended:=strpos('€?‚ƒ„…†‡ˆ‰Š‹Œ?Ž??‘’“”•–—˜™š›œ?žŸ',character);
      if extended=0 then raise exception 'CONTRACT_TEXT_ENCODING_UNSUPPORTED';end if;
      code:=127+extended;
    end if;
    result:=result||lpad(to_hex(code),2,'0');
  end loop;
  return result;
end;
$$;


--
-- Name: delivery_checklist(text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.delivery_checklist(order_id text) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare checklist jsonb;job public.work_orders;charged numeric;balance numeric;unbilled boolean;begin
  checklist:=private.delivery_checklist_before_cases(order_id);
  select * into job from public.work_orders o where o.id=delivery_checklist.order_id;
  select coalesce(sum(s.scope_amount),0) into charged from private.vehicle_document_sources(job.vehicle_id,job.id) s;
  select charged-coalesce((select sum(case a.kind when 'Aplicacion' then a.scope_amount else -a.scope_amount end)
    from private.vehicle_application_sources(job.vehicle_id,job.id) a),0)-coalesce((select sum(c.scope_amount)
    from private.vehicle_credit_sources(job.vehicle_id,job.id) c),0) into balance;
  unbilled:=not job.internal_job and job.customer_id is not null and (select ownership from public.vehicles where id=job.vehicle_id)<>'Propio' and job.estimate>charged;
  return checklist||jsonb_build_object('estimatedUnpaid',case when job.internal_job then 0 else balance end,'unbilledEstimate',unbilled,
    'pendingEstimate',case when unbilled then 'Cargo del alcance aprobado pendiente de emitir' else checklist->>'pendingEstimate' end);
end $$;


--
-- Name: delivery_checklist_before_billing(text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.delivery_checklist_before_billing(order_id text) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  service_order public.work_orders;
  quote public.estimate_versions;
  costs jsonb;
  tasks jsonb;
  timers jsonb;
  unpaid numeric;
begin
  select * into service_order from public.work_orders o where o.id=order_id;
  if service_order.id is null then raise exception 'ORDER_NOT_FOUND'; end if;
  select * into quote from public.estimate_versions where estimate_versions.order_id=service_order.id order by revision desc limit 1;
  select coalesce(jsonb_agg(to_jsonb(c)),'[]') into costs from public.workshop_costs c where c.order_id=service_order.id;
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into tasks from public.workshop_tasks t where t.order_id=service_order.id and status<>'Finalizada';
  select coalesce(jsonb_agg(to_jsonb(timer)),'[]') into timers from public.task_timers timer
    join public.workshop_tasks t on t.id=timer.task_id where t.order_id=service_order.id and timer.state<>'Finalizado';
  unpaid:=case when exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership='Propio')
    then 0 else greatest(service_order.estimate-service_order.paid,0) end;
  return jsonb_build_object('orderId',service_order.id,'version',service_order.version,'status',service_order.status,
    'pendingFields',service_order.pending_fields,'costs',costs,'pendingCosts',
    (select count(*) from public.workshop_costs where workshop_costs.order_id=service_order.id and disposition='Pendiente'),
    'openTasks',tasks,'openTimers',timers,'pendingEstimate',case when quote.status='Borrador' then quote.id else null end,
    'approvedEstimateId',service_order.active_estimate_id,'estimatedUnpaid',unpaid,
    'balancePolicy','quote-minus-recorded-paid-v1; replace with document ledger under RF15');
end;
$$;


--
-- Name: delivery_checklist_before_cases(text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.delivery_checklist_before_cases(order_id text) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare checklist jsonb;balance numeric;document_count integer;unbilled boolean;
begin
  checklist:=private.delivery_checklist_before_billing(order_id);
  select count(*),coalesce(sum(private.document_balance(d.id,'infinity'::date)),0) into document_count,balance
    from public.billing_documents d where d.order_id=$1;
  select o.estimate>0 and v.ownership='Cliente' and document_count=0 into unbilled from public.work_orders o
    join public.vehicles v on v.id=o.vehicle_id where o.id=order_id;
  return checklist||jsonb_build_object('estimatedUnpaid',balance,'balancePolicy','immutable-document-ledger-v1','unbilledEstimate',unbilled,
    'pendingEstimate',case when unbilled then coalesce(checklist->>'pendingEstimate','Cargo del alcance aprobado pendiente de emitir') else checklist->>'pendingEstimate' end);
end;
$_$;


--
-- Name: diary_sources(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.diary_sources() RETURNS TABLE(id text, date date, kind text, concept text, amount numeric, account text, counter_account text, area text, destination text, source_type text)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select 'expense:'||e.id,e.date,'Egreso',e.concept,e.amount,e.account,null,
    case when e.operation_id is not null or e.cost_center_id='workshop' then 'Taller'
      when e.vehicle_id is not null or e.reservation_id is not null or e.cost_center_id='rental' then 'Renta' else 'Administración' end,
    coalesce(e.operation_id,e.reservation_id::text,e.vehicle_id::text,e.cost_center_id),'expense'
  from public.expenses e
  union all select 'receipt:'||p.id,p.paid_on,'Ingreso','Recibo de cliente: '||p.reference,p.amount,p.account,null,'Por aplicación',p.customer_id::text,'receipt' from public.customer_payments p
  union all select 'refund:'||r.id,r.refunded_on,'Egreso','Reembolso: '||r.reason,r.amount,nullif(r.refund_account,''),null,'Por aplicación',r.payment_id::text,'refund' from public.payment_refunds r
  union all select 'cash:'||c.id,c.date,c.kind,c.concept,c.amount,c.account,c.counter_account,'Tesorería',c.reason,'cash' from public.cash_entries c;
$$;


--
-- Name: document_balance(uuid, date); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.document_balance(document_id uuid, cutoff date) RETURNS numeric
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select d.amount-coalesce((select sum(c.amount) from public.billing_credits c where c.document_id=d.id
    and c.credited_on<=cutoff and c.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'),0)
    -coalesce((select sum(case a.kind when 'Aplicacion' then a.amount else -a.amount end) from public.payment_applications a where a.document_id=d.id
    and a.effective_on<=cutoff and a.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'),0)
  from public.billing_documents d where d.id=document_balance.document_id;
$$;


--
-- Name: document_line_balance(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.document_line_balance(line_id uuid) RETURNS numeric
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select l.amount-coalesce((select sum(s.amount) from public.billing_credit_lines s where s.line_id=l.id),0)
    -coalesce((select sum(case a.kind when 'Aplicacion' then s.amount else -s.amount end)
      from public.billing_application_lines s join public.payment_applications a on a.id=s.application_id where s.line_id=l.id),0)
  from public.billing_document_lines l where l.id=document_line_balance.line_id;
$$;


--
-- Name: expense_import_summary(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.expense_import_summary(batch_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object('valid',count(*) filter(where status = 'valid'),
    'rejected',count(*) filter(where status = 'rejected'),'duplicate',count(*) filter(where status = 'duplicate'),
    'ambiguous',count(*) filter(where status = 'ambiguous'),'excluded',count(*) filter(where status = 'excluded'),
    'newTotal',coalesce(sum((payload->>'amount')::numeric) filter(where status = 'valid'),0),
    'duplicateTotal',coalesce(sum((payload->>'amount')::numeric) filter(where status = 'duplicate'),0))
  from public.expense_import_rows where import_id = batch_id;
$$;


--
-- Name: expense_to_workshop_cost(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.expense_to_workshop_cost() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare cost public.workshop_costs;paid numeric;
begin
  if new.direct_purchase_cost_id is not null then
    perform pg_advisory_xact_lock(6192,1);
    select * into cost from public.workshop_costs where id=new.direct_purchase_cost_id for update;
    if cost.id is null or cost.kind<>'Compra directa' or new.operation_id is distinct from cost.order_id
      or new.cost_center_id is not null then raise exception 'DIRECT_PURCHASE_DESTINATION_MISMATCH';end if;
    select coalesce(sum(amount),0) into paid from public.expenses where direct_purchase_cost_id=cost.id;
    if paid>cost.amount then raise exception 'DIRECT_PURCHASE_OVERPAYMENT';end if;
  elsif new.operation_id is not null then
    if exists(select 1 from public.workshop_costs where order_id=new.operation_id and kind='Compra directa'
      and lower(btrim(source_reference))=lower(btrim(new.support))) then
      raise exception 'DIRECT_PURCHASE_PAYMENT_REQUIRED';
    end if;
    insert into public.workshop_costs(order_id,kind,description,quantity,unit_cost,amount,expense_id,occurred_at,created_by)
    values(new.operation_id,'Gasto',new.concept,1,new.amount,new.amount,new.id,new.date,new.created_by);
  end if;
  return new;
end;
$$;


--
-- Name: immutable_quote_record(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.immutable_quote_record() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if TG_TABLE_NAME <> 'estimate_versions' or TG_OP = 'DELETE' then raise exception 'IMMUTABLE_RECORD'; end if;
  if old.status <> 'Borrador' or new.status not in ('Aprobado','Rechazado')
    or (to_jsonb(old)-'status') <> (to_jsonb(new)-'status') then raise exception 'IMMUTABLE_ESTIMATE_VERSION'; end if;
  return new;
end;
$$;


--
-- Name: import_fingerprint(jsonb); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.import_fingerprint(p jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object('date',p->>'date','concept',p->>'concept','category',p->>'category',
    'amount',(p->>'amount')::numeric,'method',p->>'method','account',p->>'account',
    'operationId',p->>'operationId','costCenterId',p->>'costCenterId');
$$;


--
-- Name: link_workshop_expense(text, jsonb, text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.link_workshop_expense(source_expense_id text, allocations jsonb, reason text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
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


--
-- Name: merge_reservation_identity(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.merge_reservation_identity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.merged_into is not null and old.merged_into is null then
    update public.reservations set customer_id=new.merged_into,version=version+1 where customer_id=new.id;
  end if;
  return new;
end;
$$;


--
-- Name: normalize_import_expense(jsonb, jsonb); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.normalize_import_expense(raw jsonb, mapping jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare
  cells jsonb := raw->'cells';
  p jsonb := '{}';
  field text;
  value text;
  amount numeric;
  effective_date date;
begin
  if coalesce((raw->>'hasFormula')::boolean,false) or exists (
    select 1 from jsonb_each_text(cells) as entries(key,cell_value) where entries.cell_value ~ '^\s*='
  ) then raise exception 'FORMULA_REQUIRES_REVIEW'; end if;
  foreach field in array array['date','concept','category','amount','method','account','operationId','costCenterId','support','sourceKey'] loop
    value := btrim(coalesce(cells->>(mapping->>field),''));
    p := p || jsonb_build_object(field,nullif(value,''));
  end loop;
  if coalesce(cells->>(mapping->>'type'),'Egreso') <> 'Egreso' then raise exception 'ONLY_EXPENSES_SUPPORTED'; end if;
  if coalesce(cells->>(mapping->>'currency'),'USD') <> 'USD' then raise exception 'ONLY_USD_SUPPORTED'; end if;
  foreach field in array array['date','concept','category','amount','method','account'] loop
    if p->>field is null then raise exception 'REQUIRED_FIELD_%',field; end if;
  end loop;
  value := p->>'date';
  if value ~ '^\d{4}-\d{2}-\d{2}$' then
    effective_date := make_date(substring(value,1,4)::int,substring(value,6,2)::int,substring(value,9,2)::int);
  elsif mapping->>'dateFormat' = 'DMY' and value ~ '^\d{2}/\d{2}/\d{4}$' then
    effective_date := make_date(substring(value,7,4)::int,substring(value,4,2)::int,substring(value,1,2)::int);
  else raise exception 'INVALID_DATE'; end if;
  value := p->>'amount';
  if jsonb_typeof(cells->(mapping->>'amount')) = 'number' then
    if value !~ '^\d+(\.\d{1,2})?$' then raise exception 'INVALID_AMOUNT'; end if;
  elsif mapping->>'decimalSeparator' = ',' then
    if value !~ '^(\d+|\d{1,3}(\.\d{3})+)(,\d{1,2})?$' then raise exception 'INVALID_AMOUNT'; end if;
    value := replace(replace(value,'.',''),',','.');
  else
    if value !~ '^(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$' then raise exception 'INVALID_AMOUNT'; end if;
    value := replace(value,',','');
  end if;
  amount := value::numeric;
  if amount <= 0 or amount > 999999999999.99 then raise exception 'INVALID_AMOUNT'; end if;
  if p->>'method' not in ('Efectivo','Transferencia','Tarjeta') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  if num_nonnulls(p->>'operationId',p->>'costCenterId') <> 1 then raise exception 'EXACTLY_ONE_DESTINATION_REQUIRED'; end if;
  if p->>'operationId' is not null and not exists (
    select 1 from public.work_orders where id = p->>'operationId' and status <> 'Entregado'
  ) then raise exception 'INVALID_OPERATION'; end if;
  if p->>'costCenterId' is not null and not exists (
    select 1 from public.cost_centers where id = p->>'costCenterId'
  ) then raise exception 'INVALID_COST_CENTER'; end if;
  return p || jsonb_build_object('date',effective_date::text,'amount',amount::text,'support',coalesce(p->>'support',''));
end;
$_$;


--
-- Name: normalize_import_payment(jsonb, jsonb); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.normalize_import_payment(raw jsonb, mapping jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare p jsonb:='{}';field text;value text;amount numeric;paid_on date;document public.billing_documents;
begin
  if coalesce((raw->>'hasFormula')::boolean,false) then raise exception 'FORMULA_REQUIRES_REVIEW';end if;
  foreach field in array array['customerId','documentId','date','amount','method','account','reference','sourceKey'] loop
    value:=btrim(coalesce(raw->'cells'->>(mapping->>field),''));
    if value~'^\s*=' then raise exception 'FORMULA_REQUIRES_REVIEW';end if;
    p:=p||jsonb_build_object(field,nullif(value,''));
  end loop;
  if p->>'customerId' is null or private.canonical_customer((p->>'customerId')::uuid) is null then raise exception 'INVALID_CUSTOMER';end if;
  p:=p||jsonb_build_object('customerId',private.canonical_customer((p->>'customerId')::uuid));
  if p->>'date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'INVALID_DATE';end if;
  paid_on:=(p->>'date')::date;
  if paid_on is null or not isfinite(paid_on) or paid_on>(now() at time zone 'America/El_Salvador')::date then raise exception 'INVALID_DATE';end if;
  value:=p->>'amount';
  if mapping->>'decimalSeparator'=',' then
    if value!~'^\d+(,\d{1,2})?$' then raise exception 'INVALID_AMOUNT';end if;value:=replace(value,',','.');
  elsif value!~'^\d+(\.\d{1,2})?$' then raise exception 'INVALID_AMOUNT';end if;
  amount:=value::numeric;
  if amount is null or amount<=0 or amount>999999999999.99 then raise exception 'INVALID_AMOUNT';end if;
  if p->>'method' not in ('Efectivo','Transferencia','Tarjeta') or p->>'method' is null or p->>'account' is null or p->>'reference' is null then raise exception 'PAYMENT_FIELDS_REQUIRED';end if;
  if p->>'documentId' is not null then
    select * into document from public.billing_documents where id=(p->>'documentId')::uuid;
    if document.id is null or private.canonical_customer(document.customer_id)<>(p->>'customerId')::uuid then raise exception 'PAYMENT_CUSTOMER_MISMATCH';end if;
  end if;
  return p||jsonb_build_object('amount',round(amount,2)::text,'date',paid_on::text);
end;
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: payment_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_name text NOT NULL,
    file_hash text NOT NULL,
    sheet text NOT NULL,
    rows jsonb NOT NULL,
    mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_system text DEFAULT ''::text NOT NULL,
    decisions jsonb DEFAULT '{}'::jsonb NOT NULL,
    preview jsonb DEFAULT '[]'::jsonb NOT NULL,
    new_total numeric(18,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'Preparado'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_imports_status_check CHECK ((status = ANY (ARRAY['Preparado'::text, 'Validado'::text, 'Publicado'::text])))
);


--
-- Name: payment_import_preview(public.payment_imports); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.payment_import_preview(batch public.payment_imports) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare raw jsonb;p jsonb;origin public.payment_import_origins;decision jsonb;status text;payment_id uuid;
  candidates jsonb;rows jsonb:='[]';error text;similar_rows jsonb;
begin
  for raw in select value from jsonb_array_elements(batch.rows) loop
    status:='Valida';p:=null;payment_id:=null;candidates:='[]';error:=null;similar_rows:='[]';
    decision:=batch.decisions->(raw->>'rowNumber');
    if decision->>'action'='exclude' and nullif(btrim(decision->>'reason'),'') is not null then status:='Excluida';
    else
      begin
        p:=private.normalize_import_payment(raw,batch.mapping);
        select * into origin from public.payment_import_origins where source_system=batch.source_system and source_key=p->>'sourceKey';
        if origin.id is not null then
          if (origin.fingerprint-'customerId')=(p-'customerId') and private.canonical_customer((origin.fingerprint->>'customerId')::uuid)=(p->>'customerId')::uuid then
            status:='Duplicada';payment_id:=origin.payment_id;
          else status:='Conflicto';error:='El origen ya existe con otros datos';end if;
        else
          select coalesce(jsonb_agg(existing.id),'[]') into candidates from public.customer_payments existing
            where private.canonical_customer(existing.customer_id)=(p->>'customerId')::uuid and existing.amount=(p->>'amount')::numeric
            and existing.paid_on=(p->>'date')::date and existing.method=p->>'method' and existing.account=p->>'account';
          select coalesce(jsonb_agg(previous->>'rowNumber'),'[]') into similar_rows from jsonb_array_elements(rows) previous
            where previous->>'status' not in ('Excluida','Rechazada','Conflicto')
            and previous->'payload'->>'customerId'=p->>'customerId' and previous->'payload'->>'amount'=p->>'amount'
            and previous->'payload'->>'date'=p->>'date' and previous->'payload'->>'method'=p->>'method'
            and previous->'payload'->>'account'=p->>'account';
          if jsonb_array_length(candidates)>0 or jsonb_array_length(similar_rows)>0 then
            status:='Ambigua';
            if decision->>'action'='link' and nullif(btrim(decision->>'reason'),'') is not null and candidates ? (decision->>'paymentId') then
              status:='Duplicada';payment_id:=(decision->>'paymentId')::uuid;
            elsif decision->>'action'='create' and nullif(btrim(decision->>'reason'),'') is not null then status:='Valida';end if;
          end if;
          if exists(select 1 from jsonb_array_elements(rows) previous where previous->>'status'<>'Excluida'
            and (previous->'payload'=p or (p->>'sourceKey' is not null and previous->'payload'->>'sourceKey'=p->>'sourceKey'))) then
            status:='Conflicto';error:='Origen o fila repetidos dentro del lote';end if;
        end if;
      exception when others then status:='Rechazada';error:=SQLERRM;
      end;
    end if;
    rows:=rows||jsonb_build_array(jsonb_build_object('rowNumber',raw->>'rowNumber','status',status,'payload',p,
      'paymentId',payment_id,'candidates',candidates,'similarRows',similar_rows,'error',error));
  end loop;
  return rows;
end;
$$;


--
-- Name: receipt_available(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.receipt_available(payment_id uuid) RETURNS numeric
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select p.amount-coalesce((select sum(case a.kind when 'Aplicacion' then a.amount else -a.amount end)
    from public.payment_applications a where a.payment_id=p.id),0)
    -coalesce((select sum(r.amount) from public.payment_refunds r where r.payment_id=p.id),0)
  from public.customer_payments p where p.id=receipt_available.payment_id;
$$;


--
-- Name: receive_estimated_work(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.receive_estimated_work() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare job public.work_orders;
begin
  select * into job from public.work_orders where id=new.order_id for update;
  if job.status='Presupuesto' then
    update public.work_orders set status='Diagnóstico',occurred_at=new.created_at,version=version+1 where id=job.id;
    update public.vehicles set status='En taller',version=version+1,
      unverified_fields=array_remove(case when new.km is not null then array_remove(unverified_fields,'km') else unverified_fields end,'status') where id=job.vehicle_id;
  end if;
  return new;
end $$;


--
-- Name: rental_contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rental_contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    revision integer NOT NULL,
    parent_id uuid,
    booking_snapshot jsonb NOT NULL,
    conditions text NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rental_contracts_conditions_check CHECK ((length(btrim(conditions)) > 0)),
    CONSTRAINT rental_contracts_reason_check CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: render_contract_pdf(public.rental_contracts); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.render_contract_pdf(contract public.rental_contracts) RETURNS bytea
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare lines text[]:='{}';line text;part text;body text;objects text[];offsets integer[]:='{}';
  document text:=E'%PDF-1.4\n';kids text:='';pages integer;page integer;idx integer;xref integer;result bytea;
begin
  body:='AJ Rentacar - Contrato de alquiler / V'||contract.revision||E'\n'||contract.id||E'\n'
    ||'Version UTC: '||(contract.created_at at time zone 'UTC')::text||E'Z\n\n'
    ||'Cliente: '||coalesce(contract.booking_snapshot->'customer_snapshot'->>'name','')||E'\n'
    ||'Documento: '||coalesce(contract.booking_snapshot->'customer_snapshot'->>'document','')||E'\n'
    ||'Telefono: '||coalesce(contract.booking_snapshot->'customer_snapshot'->>'phone','')||E'\n'
    ||'Vehiculo: '||coalesce(contract.booking_snapshot->'vehicle_snapshot'->>'plate','')||' / '
    ||coalesce(contract.booking_snapshot->'vehicle_snapshot'->>'brand','')||' '
    ||coalesce(contract.booking_snapshot->'vehicle_snapshot'->>'model','')||E'\n'
    ||'Desde: '||(contract.booking_snapshot->>'starts_at')||E'\nHasta: '||(case when coalesce((contract.booking_snapshot->>'open_ended')::boolean,false) then 'Sin fecha final acordada' else contract.booking_snapshot->>'ends_at' end)
    ||E'\n'||(case when coalesce((contract.booking_snapshot->>'open_ended')::boolean,false) then 'Precio final no definido. Tarifa diaria USD: '||(contract.booking_snapshot->>'daily_rate') else 'Precio previsto USD: '||(contract.booking_snapshot->>'total') end)||E'\n\nCondiciones de esta version:\n'||contract.conditions;
  if length(body)>200000 then raise exception 'DOCUMENT_TOO_LARGE';end if;
  foreach line in array string_to_array(replace(replace(body,E'\r\n',E'\n'),E'\r',E'\n'),E'\n') loop
    line:=replace(line,E'\t','    ');
    if line='' then lines:=array_append(lines,'');end if;
    while length(line)>0 loop
      lines:=array_append(lines,left(line,88));line:=substring(line from 89);
    end loop;
  end loop;
  pages:=greatest(1,ceil(cardinality(lines)/48.0)::integer);
  for page in 1..pages loop kids:=kids||(4+(page-1)*2)||' 0 R ';end loop;
  objects:=array['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count '||pages||' /Kids ['||kids||'] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'];
  for page in 1..pages loop
    body:=E'BT /F1 9 Tf 14 TL 48 790 Td\n';
    for idx in ((page-1)*48+1)..least(page*48,cardinality(lines)) loop
      -- Hex strings prevent text from becoming PDF operators; WinAnsi preserves Spanish accents.
      part:=private.contract_winansi_hex(lines[idx]);
      body:=body||'<'||part||E'> Tj T*\n';
    end loop;
    body:=body||E'ET\n';
    objects:=array_append(objects,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents '
      ||(5+(page-1)*2)||' 0 R >>');
    objects:=array_append(objects,'<< /Length '||octet_length(body)||E' >>\nstream\n'||body||'endstream');
  end loop;
  for idx in 1..cardinality(objects) loop
    offsets:=array_append(offsets,octet_length(document));
    document:=document||idx||E' 0 obj\n'||objects[idx]||E'\nendobj\n';
  end loop;
  xref:=octet_length(document);document:=document||E'xref\n0 '||(cardinality(objects)+1)||E'\n0000000000 65535 f \n';
  foreach idx in array offsets loop document:=document||lpad(idx::text,10,'0')||E' 00000 n \n';end loop;
  document:=document||E'trailer\n<< /Size '||(cardinality(objects)+1)||E' /Root 1 0 R >>\nstartxref\n'||xref||E'\n%%EOF\n';
  result:=convert_to(document,'UTF8');return result;
end;
$$;


--
-- Name: rental_actual_dates(jsonb); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.rental_actual_dates(records jsonb) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(r.value||jsonb_build_object(
    'actual_departure_at',(select occurred_at from public.rental_inspections where reservation_id=(r.value->>'id')::uuid and kind='Salida'),
    'actual_return_at',(select occurred_at from public.rental_inspections where reservation_id=(r.value->>'id')::uuid and kind='Retorno')) order by r.ordinality),'[]')
  from jsonb_array_elements(records) with ordinality r;
$$;


--
-- Name: rental_case_file_before_connected_money(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.rental_case_file_before_connected_money(reservation_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare booking public.reservations;result jsonb;begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  select * into booking from public.reservations r where r.id=rental_case_file_before_connected_money.reservation_id;
  if booking.id is null then raise exception 'RESERVATION_NOT_FOUND';end if;
  result:=public.vehicle_case_file(booking.vehicle_id,null)||jsonb_build_object('orders','[]'::jsonb,'inspections','[]'::jsonb,
    'reservations',jsonb_build_array(to_jsonb(booking)),
    'files',coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at desc) from public.vehicle_files f
      where f.reservation_id=booking.id and (not f.financial or public.has_permission('expenses.read'))),'[]'),
    'commitments',coalesce((select jsonb_agg(to_jsonb(c)) from public.vehicle_commitments c where c.reservation_id=booking.id),'[]'));
  if public.has_permission('expenses.read') then result:=result||jsonb_build_object('quotes','[]'::jsonb,'costs','[]'::jsonb,'allocations','[]'::jsonb,
    'expenses',coalesce((select jsonb_agg(to_jsonb(e)) from public.expenses e where e.reservation_id=booking.id),'[]'),
    'documents',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('scope_amount',s.scope_amount,'scope_balance',s.scope_amount
      -coalesce((select sum(case a.kind when 'Aplicacion' then a.amount else -a.amount end) from private.reservation_payment_sources(booking.id) a where a.document_id=d.id),0)
      -coalesce((select sum(c.scope_amount) from private.reservation_credit_sources(booking.id) c where c.document_id=d.id),0)))
      from private.reservation_document_sources(booking.id) s join public.billing_documents d on d.id=s.document_id),'[]'),
    'applications',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('scope_amount',s.amount)) from private.reservation_payment_sources(booking.id) s
      join public.payment_applications a on a.id=s.id),'[]'),
    'payments',coalesce((select jsonb_agg(to_jsonb(p)) from public.customer_payments p where exists(select 1 from private.reservation_payment_sources(booking.id) a where a.payment_id=p.id)),'[]'));
  end if;
  return result;
end $$;


--
-- Name: report_delivery_command_core(text, jsonb, uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.report_delivery_command_core(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','report-delivery.'||command,'payload',payload);
  schedule public.report_schedules;job public.report_outbox;run_date date;email text;result jsonb;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if command is null or command not in ('schedule','prepare','claim','sent','failed','uncertain') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REPORT_DELIVERY_COMMAND';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='schedule' then
    if not exists(select 1 from public.user_roles where user_id=(payload->>'recipientId')::uuid and role in ('owner','admin','accountant')) then raise exception 'UNAUTHORIZED_REPORT_RECIPIENT';end if;
    insert into public.report_schedules(recipient_id,vehicle_id,from_date,next_on,every_days,created_by)
    values((payload->>'recipientId')::uuid,(payload->>'vehicleId')::uuid,(payload->>'from')::date,(payload->>'nextOn')::date,(payload->>'everyDays')::integer,auth.uid()) returning * into schedule;
    result:=to_jsonb(schedule);
  elsif command='prepare' then
    run_date:=(payload->>'runDate')::date;
    if run_date is null or not isfinite(run_date) or run_date>(now() at time zone 'America/El_Salvador')::date then raise exception 'INVALID_REPORT_RUN_DATE';end if;
    result:='[]';
    for schedule in select * from public.report_schedules where active and next_on<=run_date order by next_on,id limit 50 for update loop
      select u.email into email from auth.users u where u.id=schedule.recipient_id and exists(
        select 1 from public.user_roles r where r.user_id=u.id and r.role in ('owner','admin','accountant'));
      if email is null or email !~ '^[^\r\n@]+@[^\r\n@]+$' then continue;end if;
      insert into public.report_outbox(schedule_id,cutoff,recipient_id,recipient_email,filters,snapshot,created_by)
      values(schedule.id,schedule.next_on,schedule.recipient_id,email,jsonb_build_object('vehicleId',schedule.vehicle_id,'from',schedule.from_date,'cutoff',schedule.next_on),
        public.vehicle_contribution(schedule.vehicle_id,schedule.from_date,schedule.next_on),auth.uid())
      on conflict(schedule_id,cutoff) do nothing returning * into job;
      if job.id is not null then result:=result||jsonb_build_array(to_jsonb(job));end if;
      update public.report_schedules set next_on=next_on+every_days where id=schedule.id;
    end loop;
  else
    select * into job from public.report_outbox where id=(payload->>'jobId')::uuid for update;
    if job.id is null then raise exception 'REPORT_JOB_NOT_FOUND';end if;
    if command='claim' then
      if job.state<>'Pendiente' then return null;end if;
      if not exists(select 1 from public.user_roles where user_id=job.recipient_id and role in ('owner','admin','accountant')) then raise exception 'UNAUTHORIZED_REPORT_RECIPIENT';end if;
      update public.report_outbox set state='Enviando',message_id=id::text||'@aj.local' where id=job.id returning * into job;
    else
      if job.state<>'Enviando' then raise exception 'REPORT_JOB_NOT_CLAIMED';end if;
      update public.report_outbox set state=case command when 'sent' then 'Enviado' when 'failed' then 'Error' else 'Incierto' end,
        delivery_detail=left(coalesce(payload->>'detail',''),1000) where id=job.id returning * into job;
    end if;
    result:=to_jsonb(job);
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$_$;


--
-- Name: require_import_permission(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.require_import_permission() RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if not (public.has_permission('expenses.write') and public.has_permission('expenses.read')) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
end;
$$;


--
-- Name: reservation_command_before_cleaning_review(text, jsonb, uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.reservation_command_before_cleaning_review(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','reservation.'||command,'payload',payload);
  booking public.reservations;car public.vehicles;customer public.customers;result jsonb;end_time timestamptz;
  doc jsonb;start_day date;end_day date;price numeric;
begin
  if not public.has_permission('orders.write') or (command='period' and not public.has_permission('expenses.write'))
    then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='create' and coalesce((payload->>'openEnded')::boolean,false) then
    select * into car from public.vehicles where id=(payload->>'vehicleId')::uuid for update;
    select * into customer from public.customers where id=(payload->>'customerId')::uuid and merged_into is null;
    if car.id is null or not car.in_rental_fleet or customer.id is null then raise exception 'INVALID_RENTAL_PARTIES';end if;
    price:=(payload->>'dailyRate')::numeric;
    if price is null or price<0 or price<>round(price,2) or price::text in ('NaN','Infinity') then raise exception 'INVALID_RATE_PRECISION';end if;
    insert into public.reservations(customer_id,vehicle_id,starts_at,ends_at,open_ended,daily_rate,total,cleaning_minutes,
      seller_id,customer_snapshot,vehicle_snapshot,created_by)
    values(customer.id,car.id,(payload->>'startsAt')::timestamptz,'infinity',true,price,0,coalesce((payload->>'cleaningMinutes')::integer,0),
      auth.uid(),to_jsonb(customer)-'phone_key'-'document_key',to_jsonb(car),auth.uid()) returning * into booking;
    result:=to_jsonb(booking);
  elsif command in ('confirm','set_end','period') then
    select * into booking from public.reservations where id=(payload->>'reservationId')::uuid for update;
    if booking.id is null then raise exception 'RESERVATION_NOT_FOUND';end if;
    if command<>'period' and booking.version is distinct from (payload->>'expectedVersion')::integer then raise exception 'VERSION_CONFLICT';end if;
    if command='period' then
      if booking.status<>'Confirmada' then raise exception 'CONFIRMED_RESERVATION_REQUIRED';end if;
      start_day:=(payload->>'startsOn')::date;end_day:=(payload->>'endsOn')::date;
      if start_day is null or end_day is null or not isfinite(start_day) or not isfinite(end_day) or end_day<start_day
        or start_day<(booking.starts_at at time zone 'America/El_Salvador')::date
        or (isfinite(booking.ends_at) and end_day>(booking.ends_at at time zone 'America/El_Salvador')::date)
        or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_RENTAL_PERIOD';end if;
      doc:=public.execute_billing_command('issue',payload||jsonb_build_object('reservationId',booking.id,
        'description','Alquiler '||start_day||' al '||end_day||' · '||(booking.vehicle_snapshot->>'plate')),gen_random_uuid());
      insert into public.rental_periods(reservation_id,starts_on,ends_on,document_id,reason,created_by)
      values(booking.id,start_day,end_day,(doc->>'id')::uuid,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(rental_periods.*) into result;
    elsif command='confirm' and booking.open_ended then
      if booking.status<>'Borrador' then raise exception 'RESERVATION_NOT_DRAFT';end if;
      if not exists(select 1 from public.rental_alternatives(booking.starts_at,'infinity') where id=booking.vehicle_id) then raise exception using errcode='23P01',message='RENTAL_CONFLICT';end if;
      insert into public.vehicle_commitments(vehicle_id,reservation_id,kind,starts_at,ends_at,reason,created_by)
      values(booking.vehicle_id,booking.id,'Reserva',booking.starts_at,'infinity','Alquiler sin fecha final acordada',auth.uid());
      update public.reservations set status='Confirmada',version=version+1 where id=booking.id returning to_jsonb(reservations.*) into result;
    elsif command='set_end' then
      end_time:=(payload->>'endsAt')::timestamptz;
      if not booking.open_ended or booking.status<>'Confirmada' or booking.rental_state not in ('Preparado','Entregado')
        or end_time is null or not isfinite(end_time) or end_time<=greatest(booking.starts_at,now())
        or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_OPEN_RENTAL_END';end if;
      if exists(select 1 from public.rental_periods p where p.reservation_id=booking.id and p.ends_on>(end_time at time zone 'America/El_Salvador')::date) then raise exception 'END_PREDATES_BILLED_PERIOD';end if;
      update public.vehicle_commitments set active=false where reservation_id=booking.id;
      update public.vehicle_commitments set ends_at=end_time,active=true,reason=btrim(payload->>'reason') where reservation_id=booking.id and kind='Reserva';
      if booking.cleaning_minutes>0 then
        insert into public.vehicle_commitments(vehicle_id,reservation_id,kind,starts_at,ends_at,reason,created_by)
        values(booking.vehicle_id,booking.id,'Limpieza',end_time,end_time+make_interval(mins=>booking.cleaning_minutes),'Limpieza prevista',auth.uid());
      end if;
      update public.reservations set ends_at=end_time,open_ended=false,
        total=daily_rate*greatest(1,ceil(extract(epoch from(end_time-starts_at))/86400)),version=version+1 where id=booking.id returning to_jsonb(reservations.*) into result;
    else return private.reservation_command_before_fit(command,payload,idempotency_key);end if;
  elsif command='block' and payload->>'kind' in ('Uso interno','Préstamo') then
    if nullif(btrim(payload->>'reason'),'') is null or not exists(select 1 from public.vehicles where id=(payload->>'vehicleId')::uuid and in_rental_fleet) then raise exception 'INVALID_VEHICLE_BLOCK';end if;
    insert into public.vehicle_commitments(vehicle_id,kind,starts_at,ends_at,reason,created_by)
    values((payload->>'vehicleId')::uuid,payload->>'kind',(payload->>'startsAt')::timestamptz,(payload->>'endsAt')::timestamptz,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(vehicle_commitments.*) into result;
  elsif command='finish_block' and exists(select 1 from public.vehicle_commitments where id=(payload->>'blockId')::uuid and kind in ('Uso interno','Préstamo')) then
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'BLOCK_REASON_REQUIRED';end if;
    update public.vehicle_commitments set ends_at=clock_timestamp(),active=false,reason=btrim(payload->>'reason')
      where id=(payload->>'blockId')::uuid and active and starts_at<clock_timestamp() returning to_jsonb(vehicle_commitments.*) into result;
    if result is null then raise exception 'BLOCK_CANNOT_BE_FINISHED';end if;
  else return private.reservation_command_before_fit(command,payload,idempotency_key);end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;


--
-- Name: reservation_command_before_fit(text, jsonb, uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.reservation_command_before_fit(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare block public.vehicle_commitments;car public.vehicles;prior private.command_results;returned_id uuid;
begin
  if not public.has_permission('orders.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  -- Let the original implementation check request equality and replay completed commands.
  if not found and command='finish_block' then
    select * into block from public.vehicle_commitments where id=(payload->>'blockId')::uuid for update;
    if block.id is null or not block.active then raise exception 'BLOCK_CANNOT_BE_FINISHED';end if;
    select * into car from public.vehicles where id=block.vehicle_id for update;
    if car.readiness_hold then
      select i.reservation_id into returned_id from public.rental_inspections i join public.reservations r on r.id=i.reservation_id
        where r.vehicle_id=car.id and r.rental_state='Devuelto' and i.kind='Retorno' order by i.occurred_at desc,i.id desc limit 1;
      if block.kind<>'Limpieza' or returned_id is null or block.reservation_id is distinct from returned_id then
        raise exception 'RETURN_CLEANING_REQUIRED';end if;
    end if;
  end if;
  return private.reservation_command_before_review(command,payload,idempotency_key);
end;
$$;


--
-- Name: reservation_command_before_review(text, jsonb, uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.reservation_command_before_review(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','reservation.'||command,'payload',payload);
  booking public.reservations;
  car public.vehicles;
  customer public.customers;
  start_time timestamptz;
  end_time timestamptz;
  result jsonb;
  seller uuid;
begin
  if not public.has_permission('orders.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if command is null or command not in ('create','confirm','cancel','extend','evidence','block','finish_block','plan_workshop')
    or idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_RESERVATION_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if command='create' then
    select * into car from public.vehicles where id=(payload->>'vehicleId')::uuid for update;
    select * into customer from public.customers where id=(payload->>'customerId')::uuid and merged_into is null;
    if car.id is null or not car.in_rental_fleet or customer.id is null then raise exception 'INVALID_RENTAL_PARTIES'; end if;
    start_time:=(payload->>'startsAt')::timestamptz;end_time:=(payload->>'endsAt')::timestamptz;
    if (payload->>'dailyRate')::numeric<>round((payload->>'dailyRate')::numeric,2) then raise exception 'INVALID_RATE_PRECISION'; end if;
    seller:=coalesce((payload->>'sellerId')::uuid,auth.uid());
    if not exists(select 1 from public.user_roles where user_id=seller and role in ('owner','admin','reception')) then raise exception 'INVALID_SELLER'; end if;
    insert into public.reservations(customer_id,vehicle_id,starts_at,ends_at,daily_rate,total,cleaning_minutes,
      seller_id,customer_snapshot,vehicle_snapshot,created_by)
    values(customer.id,car.id,start_time,end_time,(payload->>'dailyRate')::numeric,
      (payload->>'dailyRate')::numeric*greatest(1,ceil(extract(epoch from(end_time-start_time))/86400)),
      coalesce((payload->>'cleaningMinutes')::integer,0),seller,to_jsonb(customer)-'phone_key'-'document_key',to_jsonb(car),auth.uid()) returning * into booking;
    result:=to_jsonb(booking);
  elsif command in ('confirm','cancel','extend','evidence') then
    select * into booking from public.reservations where id=(payload->>'reservationId')::uuid for update;
    if booking.id is null then raise exception 'RESERVATION_NOT_FOUND'; end if;
    if command<>'evidence' and (payload->>'expectedVersion')::integer is distinct from booking.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    if command='evidence' then
      insert into public.reservation_evidence(reservation_id,channel,body,occurred_at,created_by)
      values(booking.id,'WhatsApp',btrim(payload->>'body'),coalesce((payload->>'occurredAt')::timestamptz,now()),auth.uid()) returning to_jsonb(reservation_evidence.*) into result;
    elsif command='confirm' then
      if booking.status<>'Borrador' then raise exception 'RESERVATION_NOT_DRAFT'; end if;
      if not exists(select 1 from public.rental_alternatives(booking.starts_at,booking.ends_at+make_interval(mins=>booking.cleaning_minutes)) where id=booking.vehicle_id)
        then raise exception using errcode='23P01',message='RENTAL_CONFLICT'; end if;
      insert into public.vehicle_commitments(vehicle_id,reservation_id,kind,starts_at,ends_at,reason,created_by)
      values(booking.vehicle_id,booking.id,'Reserva',booking.starts_at,booking.ends_at,'Reserva confirmada',auth.uid());
      if booking.cleaning_minutes>0 then
        insert into public.vehicle_commitments(vehicle_id,reservation_id,kind,starts_at,ends_at,reason,created_by)
        values(booking.vehicle_id,booking.id,'Limpieza',booking.ends_at,booking.ends_at+make_interval(mins=>booking.cleaning_minutes),'Limpieza prevista',auth.uid());
      end if;
      update public.reservations set status='Confirmada',version=version+1 where id=booking.id returning * into booking;
      result:=to_jsonb(booking);
    elsif command='cancel' then
      if booking.status='Cancelada' or booking.rental_state<>'Preparado' or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_CANCELLATION'; end if;
      update public.vehicle_commitments set active=false,reason=btrim(payload->>'reason') where reservation_id=booking.id;
      update public.reservations set status='Cancelada',version=version+1 where id=booking.id returning * into booking;
      result:=to_jsonb(booking); -- Never delete future charges, payments or evidence on cancellation.
    else
      if booking.status<>'Confirmada' or booking.rental_state not in ('Preparado','Entregado') then raise exception 'RESERVATION_NOT_EXTENDABLE'; end if;
      end_time:=(payload->>'endsAt')::timestamptz;
      if end_time is null or not isfinite(end_time) or end_time<=booking.ends_at or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_EXTENSION'; end if;
      if not exists(select 1 from public.rental_alternatives(booking.starts_at,end_time+make_interval(mins=>booking.cleaning_minutes),booking.id) where id=booking.vehicle_id)
        then raise exception using errcode='23P01',message='RENTAL_CONFLICT'; end if;
      update public.vehicle_commitments set active=false where reservation_id=booking.id;
      update public.vehicle_commitments set ends_at=end_time,reason=btrim(payload->>'reason'),active=true where reservation_id=booking.id and kind='Reserva';
      update public.vehicle_commitments set starts_at=end_time,ends_at=end_time+make_interval(mins=>booking.cleaning_minutes),active=true,
        reason=btrim(payload->>'reason') where reservation_id=booking.id and kind='Limpieza';
      update public.reservations set ends_at=end_time,total=daily_rate*greatest(1,ceil(extract(epoch from(end_time-starts_at))/86400)),
        version=version+1 where id=booking.id returning * into booking;
      result:=to_jsonb(booking);
    end if;
  elsif command='block' then
    if payload->>'kind' not in ('Taller','Limpieza') or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_VEHICLE_BLOCK'; end if;
    insert into public.vehicle_commitments(vehicle_id,kind,starts_at,ends_at,reason,created_by)
    values((payload->>'vehicleId')::uuid,payload->>'kind',(payload->>'startsAt')::timestamptz,
      (payload->>'endsAt')::timestamptz,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(vehicle_commitments.*) into result;
  elsif command='plan_workshop' then
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'BLOCK_REASON_REQUIRED'; end if;
    update public.vehicle_commitments set ends_at=(payload->>'endsAt')::timestamptz,reason=btrim(payload->>'reason')
      where order_id=payload->>'orderId' and kind='Taller' and exists(select 1 from public.work_orders where id=payload->>'orderId' and status<>'Entregado')
      returning to_jsonb(vehicle_commitments.*) into result;
    if result is null then raise exception 'OPEN_WORKSHOP_BLOCK_REQUIRED'; end if;
  else
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'BLOCK_REASON_REQUIRED'; end if;
    select * into car from public.vehicles where id=(select vehicle_id from public.vehicle_commitments where id=(payload->>'blockId')::uuid) for update;
    update public.vehicle_commitments set ends_at=clock_timestamp(),active=false,reason=btrim(payload->>'reason') where id=(payload->>'blockId')::uuid
      and order_id is null and kind in ('Limpieza','Taller') and starts_at<clock_timestamp() returning to_jsonb(vehicle_commitments.*) into result;
    if result is null then raise exception 'BLOCK_CANNOT_BE_FINISHED'; end if;
    if not exists(select 1 from public.work_orders where vehicle_id=car.id and status<>'Entregado')
      and not exists(select 1 from public.reservations where vehicle_id=car.id and rental_state='Entregado')
      and not exists(select 1 from public.vehicle_commitments where vehicle_id=car.id and active and kind<>'Reserva' and starts_at<=now() and ends_at>now()) then
      update public.vehicles set status='Disponible',readiness_hold=false,version=version+1 where id=car.id;
    end if;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;


--
-- Name: reservation_credit_sources(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.reservation_credit_sources(reservation_id uuid) RETURNS TABLE(credit_id uuid, document_id uuid, scope_amount numeric)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select c.id,c.document_id,c.amount from public.billing_credits c join public.billing_documents d on d.id=c.document_id
    where d.reservation_id=reservation_credit_sources.reservation_id
  union all select c.id,c.document_id,sum(s.amount) from public.billing_credit_lines s
    join public.billing_credits c on c.id=s.credit_id join public.billing_document_lines l on l.id=s.line_id
    where l.reservation_id=reservation_credit_sources.reservation_id group by c.id;
$$;


--
-- Name: reservation_document_sources(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.reservation_document_sources(reservation_id uuid) RETURNS TABLE(document_id uuid, scope_amount numeric)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select d.id,d.amount from public.billing_documents d where d.reservation_id=reservation_document_sources.reservation_id
  union all select l.document_id,sum(l.amount) from public.billing_document_lines l
    where l.reservation_id=reservation_document_sources.reservation_id group by l.document_id;
$$;


--
-- Name: reservation_payment_sources(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.reservation_payment_sources(reservation_id uuid) RETURNS TABLE(id uuid, document_id uuid, payment_id uuid, kind text, amount numeric, effective_on date, created_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select a.id,a.document_id,a.payment_id,a.kind,a.amount,a.effective_on,a.created_at from public.payment_applications a
    join public.billing_documents d on d.id=a.document_id where d.reservation_id=reservation_payment_sources.reservation_id
  union all select a.id,a.document_id,a.payment_id,a.kind,sum(s.amount),a.effective_on,a.created_at
    from public.billing_application_lines s join public.payment_applications a on a.id=s.application_id
    join public.billing_document_lines l on l.id=s.line_id where l.reservation_id=reservation_payment_sources.reservation_id group by a.id;
$$;


--
-- Name: task_timer_guard(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.task_timer_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if (new.assigned_to<>old.assigned_to or new.status='Finalizada') and exists(
    select 1 from public.task_timers where task_id=new.id and state<>'Finalizado'
  ) then raise exception 'TASK_HAS_OPEN_TIMER'; end if;
  return new;
end;
$$;


--
-- Name: expense_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_name text NOT NULL,
    file_hash text NOT NULL,
    sheet_name text NOT NULL,
    source_system text DEFAULT 'daily-ledger'::text NOT NULL,
    columns jsonb NOT NULL,
    mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    decisions jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'staged'::text NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    CONSTRAINT expense_imports_status_check CHECK ((status = ANY (ARRAY['staged'::text, 'validated'::text, 'committed'::text])))
);


--
-- Name: validate_expense_import_rows(public.expense_imports); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.validate_expense_import_rows(batch public.expense_imports) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  r public.expense_import_rows;
  p jsonb;
  fp jsonb;
  decision jsonb;
  origin public.expense_import_origins;
  matches text[];
  row_status text;
  row_issue text;
  linked text;
  source text;
begin
  for r in select * from public.expense_import_rows where import_id = batch.id order by row_number loop
    decision := coalesce(batch.decisions->(r.row_number::text),'{}');
    p := null; fp := null; source := null; linked := null; matches := '{}'; row_status := 'valid'; row_issue := '';
    begin
      if decision->>'action' = 'exclude' then
        if nullif(btrim(decision->>'reason'),'') is null then raise exception 'DECISION_REASON_REQUIRED'; end if;
        row_status := 'excluded'; row_issue := 'EXCLUDED_BY_USER';
      else
        p := private.normalize_import_expense(r.raw_data,batch.mapping);
        fp := private.import_fingerprint(p);
        source := coalesce(p->>'sourceKey',batch.file_hash || ':' || batch.sheet_name || ':' || r.row_number);
        select * into origin from public.expense_import_origins
          where source_system = batch.source_system and source_key = source;
        if found then
          if origin.fingerprint <> fp then raise exception 'SOURCE_KEY_CONFLICT'; end if;
          row_status := 'duplicate'; linked := origin.expense_id;
        else
          select coalesce(array_agg(id),'{}') into matches from (
            select e.id from public.expenses e where private.import_fingerprint(jsonb_build_object(
              'date',e.date::text,'concept',e.concept,'category',e.category,'amount',e.amount,
              'method',e.method,'account',e.account,'operationId',e.operation_id,'costCenterId',e.cost_center_id
            )) = fp order by e.id limit 20
          ) candidates;
          if decision->>'action' in ('new','link') and nullif(btrim(decision->>'reason'),'') is null then
            raise exception 'DECISION_REASON_REQUIRED';
          end if;
          if decision->>'action' = 'link' then
            if not coalesce((decision->>'expenseId') = any(matches),false) then raise exception 'INVALID_DUPLICATE_LINK'; end if;
            row_status := 'duplicate'; linked := decision->>'expenseId';
          elsif cardinality(matches) > 0 and coalesce(decision->>'action','') <> 'new' then
            row_status := 'ambiguous'; row_issue := 'SIMILAR_EXPENSE_REQUIRES_DECISION';
          elsif coalesce(decision->>'action','') not in ('','new') then raise exception 'INVALID_DECISION'; end if;
        end if;
      end if;
    exception when others then
      row_status := 'rejected'; linked := null;
      row_issue := case when sqlstate = 'P0001' then sqlerrm else 'INVALID_DATE_OR_AMOUNT' end;
    end;
    update public.expense_import_rows set payload = p, fingerprint = fp, source_key = source,
      status = row_status, issue = row_issue, candidates = matches, expense_id = linked where id = r.id;
  end loop;
  -- Repeated identifiers inside one sheet are never silently collapsed.
  update public.expense_import_rows candidate_row set status = 'rejected',issue = 'REPEATED_SOURCE_KEY'
  where candidate_row.import_id = batch.id and candidate_row.status not in ('excluded','rejected') and exists (
    select 1 from public.expense_import_rows other where other.import_id = candidate_row.import_id and other.id <> candidate_row.id
      and other.source_key = candidate_row.source_key and other.status <> 'excluded'
  );
  update public.expense_import_rows candidate_row set status = 'ambiguous',issue = 'SIMILAR_ROWS_IN_BATCH'
  where candidate_row.import_id = batch.id and candidate_row.status = 'valid'
    and coalesce(batch.decisions->(candidate_row.row_number::text)->>'action','') <> 'new' and exists (
      select 1 from public.expense_import_rows other where other.import_id = candidate_row.import_id and other.id <> candidate_row.id
        and other.fingerprint = candidate_row.fingerprint and other.status not in ('excluded','rejected')
    );
end;
$$;


--
-- Name: vehicle_application_sources(uuid, text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.vehicle_application_sources(vehicle_id uuid, order_id text DEFAULT NULL::text) RETURNS TABLE(application_id uuid, document_id uuid, scope_amount numeric, kind text)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select a.id,a.document_id,a.amount,a.kind from public.payment_applications a join public.billing_documents d on d.id=a.document_id
    join private.vehicle_document_sources(vehicle_application_sources.vehicle_id,vehicle_application_sources.order_id) s on s.document_id=a.document_id where not d.grouped
  union all select a.id,a.document_id,sum(s.amount),a.kind from public.billing_application_lines s
    join public.payment_applications a on a.id=s.application_id join public.billing_document_lines l on l.id=s.line_id
    left join public.work_orders o on o.id=l.order_id left join public.reservations r on r.id=l.reservation_id
    where coalesce(o.vehicle_id,r.vehicle_id)=vehicle_application_sources.vehicle_id
    and (vehicle_application_sources.order_id is null or l.order_id=vehicle_application_sources.order_id) group by a.id;
$$;


--
-- Name: vehicle_case_file_before_connected_money(uuid, text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.vehicle_case_file_before_connected_money(vehicle_id uuid, order_id text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare car public.vehicles;finance boolean:=public.has_permission('expenses.read');result jsonb;
begin
  if not public.has_permission('vehicles.read') or not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  select * into car from public.vehicles v where v.id=vehicle_case_file_before_connected_money.vehicle_id;
  if car.id is null then raise exception 'VEHICLE_NOT_FOUND';end if;
  if order_id is not null and not exists(select 1 from public.work_orders o where o.id=vehicle_case_file_before_connected_money.order_id and o.vehicle_id=car.id) then raise exception 'ORDER_NOT_FOUND';end if;
  result:=jsonb_build_object('vehicle',to_jsonb(car),'financialAccess',finance,
    'orders',coalesce((select jsonb_agg(to_jsonb(o) order by o.occurred_at desc) from public.work_orders o where o.vehicle_id=car.id and (vehicle_case_file_before_connected_money.order_id is null or o.id=vehicle_case_file_before_connected_money.order_id)),'[]'),
    'reservations',coalesce((select jsonb_agg(to_jsonb(r) order by r.starts_at desc) from public.reservations r where r.vehicle_id=car.id and order_id is null),'[]'),
    'commitments',coalesce((select jsonb_agg(to_jsonb(c) order by c.starts_at desc) from public.vehicle_commitments c where c.vehicle_id=car.id),'[]'),
    'inspections',coalesce((select jsonb_agg(to_jsonb(i)) from public.workshop_inspections i join public.work_orders o on o.id=i.order_id where o.vehicle_id=car.id and (vehicle_case_file_before_connected_money.order_id is null or o.id=vehicle_case_file_before_connected_money.order_id)),'[]'),
    'files',coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at desc) from public.vehicle_files f where f.vehicle_id=car.id and (vehicle_case_file_before_connected_money.order_id is null or f.order_id=vehicle_case_file_before_connected_money.order_id) and (not f.financial or finance)),'[]'));
  if finance then result:=result||jsonb_build_object(
    'quotes',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from public.estimate_versions q join public.work_orders o on o.id=q.order_id where o.vehicle_id=car.id and (vehicle_case_file_before_connected_money.order_id is null or o.id=vehicle_case_file_before_connected_money.order_id)),'[]'),
    'costs',coalesce((select jsonb_agg(to_jsonb(c)) from public.workshop_costs c join public.work_orders o on o.id=c.order_id where o.vehicle_id=car.id and (vehicle_case_file_before_connected_money.order_id is null or o.id=vehicle_case_file_before_connected_money.order_id)),'[]'),
    'allocations',coalesce((select jsonb_agg(to_jsonb(a)) from public.cost_allocations a join public.workshop_costs c on c.id=a.cost_id join public.work_orders o on o.id=c.order_id where o.vehicle_id=car.id and a.active and (vehicle_case_file_before_connected_money.order_id is null or o.id=vehicle_case_file_before_connected_money.order_id)),'[]'),
    'expenses',coalesce((select jsonb_agg(to_jsonb(e) order by e.date desc) from public.expenses e left join public.work_orders o on o.id=e.operation_id left join public.reservations r on r.id=e.reservation_id
      where coalesce(e.vehicle_id,o.vehicle_id,r.vehicle_id)=car.id and (vehicle_case_file_before_connected_money.order_id is null or e.operation_id=vehicle_case_file_before_connected_money.order_id)),'[]'),
    'documents',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('scope_amount',s.scope_amount,'scope_balance',s.scope_amount
      -coalesce((select sum(case a.kind when 'Aplicacion' then a.scope_amount else -a.scope_amount end) from private.vehicle_application_sources(car.id,vehicle_case_file_before_connected_money.order_id) a where a.document_id=d.id),0)
      -coalesce((select sum(c.scope_amount) from private.vehicle_credit_sources(car.id,vehicle_case_file_before_connected_money.order_id) c where c.document_id=d.id),0)))
      from private.vehicle_document_sources(car.id,vehicle_case_file_before_connected_money.order_id) s join public.billing_documents d on d.id=s.document_id),'[]'),
    'applications',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('scope_amount',s.scope_amount)) from private.vehicle_application_sources(car.id,vehicle_case_file_before_connected_money.order_id) s join public.payment_applications a on a.id=s.application_id),'[]'),
    'payments',coalesce((select jsonb_agg(to_jsonb(p)) from public.customer_payments p where exists(select 1 from private.vehicle_application_sources(car.id,vehicle_case_file_before_connected_money.order_id) s join public.payment_applications a on a.id=s.application_id where a.payment_id=p.id)),'[]'));
  end if;
  return result;
end $$;


--
-- Name: vehicle_credit_sources(uuid, text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.vehicle_credit_sources(vehicle_id uuid, order_id text DEFAULT NULL::text) RETURNS TABLE(credit_id uuid, document_id uuid, scope_amount numeric)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select c.id,c.document_id,c.amount from public.billing_credits c join public.billing_documents d on d.id=c.document_id
    join private.vehicle_document_sources(vehicle_credit_sources.vehicle_id,vehicle_credit_sources.order_id) s on s.document_id=c.document_id where not d.grouped
  union all select c.id,c.document_id,sum(s.amount) from public.billing_credit_lines s join public.billing_credits c on c.id=s.credit_id
    join public.billing_document_lines l on l.id=s.line_id left join public.work_orders o on o.id=l.order_id
    left join public.reservations r on r.id=l.reservation_id where coalesce(o.vehicle_id,r.vehicle_id)=vehicle_credit_sources.vehicle_id
    and (vehicle_credit_sources.order_id is null or l.order_id=vehicle_credit_sources.order_id) group by c.id;
$$;


--
-- Name: vehicle_document_sources(uuid, text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.vehicle_document_sources(vehicle_id uuid, order_id text DEFAULT NULL::text) RETURNS TABLE(document_id uuid, scope_amount numeric)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select d.id,d.amount from public.billing_documents d left join public.work_orders o on o.id=d.order_id
    left join public.reservations r on r.id=d.reservation_id where not d.grouped and coalesce(o.vehicle_id,r.vehicle_id)=vehicle_document_sources.vehicle_id
    and (vehicle_document_sources.order_id is null or d.order_id=vehicle_document_sources.order_id)
  union all select l.document_id,sum(l.amount) from public.billing_document_lines l left join public.work_orders o on o.id=l.order_id
    left join public.reservations r on r.id=l.reservation_id where coalesce(o.vehicle_id,r.vehicle_id)=vehicle_document_sources.vehicle_id
    and (vehicle_document_sources.order_id is null or l.order_id=vehicle_document_sources.order_id) group by l.document_id;
$$;


--
-- Name: workshop_commitment(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.workshop_commitment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: administration_users(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.administration_users() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'email',u.email,'roles',
    coalesce((select jsonb_agg(r.role) from public.user_roles r where r.user_id=u.id),'[]'))) from auth.users u),'[]');
end;
$$;


--
-- Name: agent_vehicle_cost(text, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_vehicle_cost(vehicle_ref text, order_ref text, cutoff date) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare car public.vehicles;orders jsonb;sources jsonb;total numeric;selected_order_id text;
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if cutoff is null or not isfinite(cutoff) then raise exception 'CUTOFF_REQUIRED';end if;
  select * into car from public.vehicles where id::text=vehicle_ref or plate_key=upper(regexp_replace(vehicle_ref,'[^a-zA-Z0-9]','','g'));
  if car.id is null then raise exception 'VEHICLE_NOT_FOUND';end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'service',o.service)),'[]') into orders from public.work_orders o where o.vehicle_id=car.id;
  if nullif(order_ref,'') is null and jsonb_array_length(orders)>1 then
    return jsonb_build_object('requiresSelection',true,'vehicleId',car.id,'plate',car.plate,'operations',orders,'cutoff',cutoff);
  end if;
  selected_order_id:=coalesce(nullif(order_ref,''),orders->0->>'id');
  if selected_order_id is not null and not exists(select 1 from public.work_orders o where o.id=selected_order_id and o.vehicle_id=car.id) then raise exception 'OPERATION_VEHICLE_MISMATCH';end if;
  select coalesce(jsonb_agg(to_jsonb(rows)),'[]'),coalesce(sum(rows.amount),0) into sources,total from (
    select c.id,c.order_id,c.expense_id,c.description,(history.data->>'amount')::numeric amount,c.occurred_at
    from public.workshop_costs c cross join lateral(select a.after_data data from public.audit_events a
      where a.entity='workshop_costs' and a.entity_id=c.id::text and a.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'
      order by a.created_at desc,a.id desc limit 1) history where c.order_id=selected_order_id and c.occurred_at<=cutoff
  ) rows;
  return jsonb_build_object('policy','actual-direct-cost-sources-v1','requiresSelection',false,'vehicleId',car.id,'plate',car.plate,
    'operationId',selected_order_id,'cutoff',cutoff,'total',total,'sources',sources,'limitation','Excludes unvalued labor and unallocated overhead; not total lifetime ownership cost.');
end;
$$;


--
-- Name: billing_line_positions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_line_positions(document_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('balance',private.document_line_balance(l.id)))
    from public.billing_document_lines l where l.document_id=billing_line_positions.document_id),'[]');
end $$;


--
-- Name: budget_position(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.budget_position(budget_id uuid, cutoff date) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare plan public.operating_budgets;committed numeric;executed numeric;detail jsonb;boundary timestamptz;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if cutoff is null or not isfinite(cutoff) then raise exception 'CUTOFF_REQUIRED';end if;
  boundary:=(cutoff+1)::timestamp at time zone 'America/El_Salvador';
  select * into plan from public.operating_budgets where id=budget_id;
  if plan.id is null then raise exception 'BUDGET_NOT_FOUND';end if;
  select coalesce(sum(greatest((history.data->>'quantity')::numeric-coalesce(receipts.quantity,0),0)
    *(history.data->>'unit_cost')::numeric),0) into committed
    from public.budget_purchase_links l join public.purchase_orders p on p.id=l.purchase_id
    cross join lateral(select a.after_data data from public.audit_events a where a.entity='purchase_orders'
      and a.entity_id=p.id::text and a.created_at<boundary order by a.created_at desc,a.id desc limit 1) history
    left join lateral(select sum(m.quantity) quantity from public.stock_movements m where m.purchase_id=p.id
      and m.kind='Entrada' and m.created_at<boundary) receipts on true
    where l.budget_id=plan.id and l.created_at<boundary and plan.created_at<boundary
      and history.data->>'status' in ('Autorizada','Recibida');
  select coalesce(jsonb_agg(to_jsonb(rows)),'[]'),coalesce(sum(rows.amount),0) into detail,executed from (
    select o.id::text id,'Recepcion'::text kind,o.amount from public.supplier_obligations o join public.budget_purchase_links l on l.purchase_id=o.purchase_id
      where l.budget_id=plan.id and o.created_at<boundary and l.created_at<boundary and plan.created_at<boundary
        and (o.created_at at time zone 'America/El_Salvador')::date between plan.starts_on and plan.ends_on
    union all select e.id,'Gasto independiente',e.amount from public.budget_expense_links l join public.expenses e on e.id=l.expense_id
      where l.budget_id=plan.id and l.purchase_id is null and e.date between plan.starts_on and least(plan.ends_on,cutoff)
      and e.created_at<boundary and l.created_at<boundary and plan.created_at<boundary
  ) rows;
  return jsonb_build_object('budget',to_jsonb(plan),'cutoff',cutoff,'authorized',case when plan.created_at<boundary then plan.authorized else 0 end,
    'committed',round(committed,2),'executed',executed,
    'available',case when plan.created_at<boundary then plan.authorized else 0 end-round(committed,2)-executed,
    'sources',detail,'policy','received-obligation-plus-independent-expense-v1');
end;
$$;


--
-- Name: calculate_estimate(jsonb, text, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_estimate(lines jsonb, method text DEFAULT 'commercial'::text, ratio numeric DEFAULT NULL::numeric, discount numeric DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  return private.calculate_estimate(lines,method,ratio,discount);
end;
$$;


--
-- Name: cash_diary(date, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_diary(from_date date, to_date date, account_filter text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare result jsonb;rows jsonb;begin
  result:=private.cash_diary_before_connected_money(from_date,to_date,account_filter);
  select coalesce(jsonb_agg(item||jsonb_build_object(
    'created_at',case item->>'source_type'
    when 'expense' then (select created_at from public.expenses where id=split_part(item->>'id',':',2))
    when 'receipt' then (select created_at from public.customer_payments where id=split_part(item->>'id',':',2)::uuid)
    when 'refund' then (select created_at from public.payment_refunds where id=split_part(item->>'id',':',2)::uuid)
    when 'cash' then (select created_at from public.cash_entries where id=split_part(item->>'id',':',2)::uuid) end,
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


--
-- Name: collect_document(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.collect_document(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','billing.collect_document','payload',payload);
  document public.billing_documents;receipt jsonb;application jsonb;result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  select * into document from public.billing_documents where id=(payload->>'documentId')::uuid for update;
  if document.id is null then raise exception 'DOCUMENT_NOT_FOUND';end if;
  if payload->>'paymentId' is null then
    receipt:=public.execute_billing_command('pay',payload||jsonb_build_object('customerId',document.customer_id),gen_random_uuid());
  else receipt:=jsonb_build_object('id',payload->>'paymentId');end if;
  application:=public.execute_billing_command('apply',payload||jsonb_build_object('paymentId',receipt->>'id'),gen_random_uuid());
  result:=jsonb_build_object('receipt',receipt,'application',application);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;


--
-- Name: commit_expense_import(uuid, integer, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.commit_expense_import(batch_id uuid, expected_version integer, expected_new_total numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  batch public.expense_imports;
  r public.expense_import_rows;
  result jsonb;
  before_rows jsonb;
  after_rows jsonb;
begin
  perform private.require_import_permission();
  perform pg_advisory_xact_lock(6192,1);
  select * into batch from public.expense_imports where id = batch_id for update;
  if batch.id is null then raise exception 'IMPORT_NOT_FOUND'; end if;
  if expected_new_total is distinct from (batch.summary->>'newTotal')::numeric then raise exception 'RECONCILIATION_MISMATCH'; end if;
  if batch.status = 'committed' then return to_jsonb(batch); end if;
  if batch.status <> 'validated' or expected_version is distinct from batch.version then raise exception 'VERSION_CONFLICT'; end if;
  select jsonb_agg(jsonb_build_array(status,payload,expense_id,source_key) order by row_number) into before_rows
    from public.expense_import_rows where import_id = batch.id;
  perform private.validate_expense_import_rows(batch);
  select jsonb_agg(jsonb_build_array(status,payload,expense_id,source_key) order by row_number) into after_rows
    from public.expense_import_rows where import_id = batch.id;
  if before_rows is distinct from after_rows then raise exception 'IMPORT_PREVIEW_CHANGED'; end if;
  if exists(select 1 from public.expense_import_rows where import_id = batch.id and status in ('pending','rejected','ambiguous')) then
    raise exception 'IMPORT_HAS_UNRESOLVED_ROWS';
  end if;
  for r in select * from public.expense_import_rows where import_id = batch.id order by row_number loop
    if r.status = 'valid' then
      result := public.execute_command('record_expense',r.payload - 'sourceKey',r.command_key);
      update public.expense_import_rows set expense_id = result->>'id',status = 'published' where id = r.id;
      r.expense_id := result->>'id';
    end if;
    if r.status in ('valid','duplicate') then
      insert into public.expense_import_origins(source_system,source_key,fingerprint,expense_id,import_id)
      values (batch.source_system,r.source_key,r.fingerprint,r.expense_id,batch.id) on conflict do nothing;
    end if;
  end loop;
  update public.expense_imports set status = 'committed',version = version + 1,committed_at = now()
    where id = batch.id returning * into batch;
  return to_jsonb(batch);
end;
$$;


--
-- Name: confirm_agent_expense(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_agent_expense(proposal_id uuid, expected_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare proposal public.agent_expense_proposals;confirmed_result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into proposal from public.agent_expense_proposals where id=proposal_id and actor=auth.uid() for update;
  if proposal.id is null or expected_hash is distinct from proposal.payload_hash then raise exception 'PROPOSAL_CONFIRMATION_MISMATCH';end if;
  if proposal.result is not null then return proposal.result;end if;
  if proposal.expires_at<clock_timestamp() then raise exception 'PROPOSAL_EXPIRED';end if;
  confirmed_result:=public.execute_command('record_expense',proposal.payload,proposal.id);
  update public.agent_expense_proposals set result=confirmed_result where id=proposal.id;
  return confirmed_result;
end;
$$;


--
-- Name: contract_pdf(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_pdf(contract_id uuid, pdf_base64 text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare file private.contract_files;contract public.rental_contracts;content bytea;
begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if pdf_base64 is not null then raise exception 'INVALID_PDF_UPLOAD';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into contract from public.rental_contracts where id=contract_id;
  if contract.id is null then raise exception 'CONTRACT_NOT_FOUND';end if;
  select * into file from private.contract_files where contract_files.contract_id=contract_pdf.contract_id;
  if file.contract_id is null then
    if not public.has_permission('orders.write') then return null;end if;
    content:=private.render_contract_pdf(contract);
    insert into private.contract_files values(contract.id,content,encode(sha256(content),'hex')) returning * into file;
  end if;
  return jsonb_build_object('hash',file.file_hash,'base64',encode(file.content,'base64'));
end;
$$;


--
-- Name: customer_document_content(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_document_content(file_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare file public.customer_documents;begin
  if not public.has_permission('customers.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  select * into file from public.customer_documents where id=file_id;
  if file.id is null then raise exception 'CUSTOMER_DOCUMENT_NOT_FOUND';end if;
  return jsonb_build_object('mime',file.mime,'name',file.name,'base64',
    (select encode(content,'base64') from private.customer_document_bytes where customer_document_bytes.file_id=file.id));
end $$;


--
-- Name: customer_document_list(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_document_list(customer_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('customers.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at desc,f.id) from public.customer_documents f
    where f.customer_id=customer_document_list.customer_id or exists(select 1 from public.customer_aliases a
      where a.source_id=f.customer_id and a.customer_id=customer_document_list.customer_id)),'[]');
end $$;


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    phone text NOT NULL,
    document text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    type text NOT NULL,
    phone_key text GENERATED ALWAYS AS (regexp_replace(phone, '[^0-9]'::text, ''::text, 'g'::text)) STORED,
    document_key text GENERATED ALWAYS AS (upper(regexp_replace(document, '[^a-zA-Z0-9]'::text, ''::text, 'g'::text))) STORED,
    merged_into uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_reference text DEFAULT ''::text NOT NULL,
    CONSTRAINT customers_check CHECK ((merged_into IS DISTINCT FROM id)),
    CONSTRAINT customers_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))),
    CONSTRAINT customers_phone_check CHECK (((phone = ''::text) OR ((length(regexp_replace(phone, '[^0-9]'::text, ''::text, 'g'::text)) >= 7) AND (length(regexp_replace(phone, '[^0-9]'::text, ''::text, 'g'::text)) <= 15)))),
    CONSTRAINT customers_type_check CHECK ((type = ANY (ARRAY['Personal'::text, 'Empresa'::text])))
);


--
-- Name: customer_matches(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_matches(phone text DEFAULT ''::text, document text DEFAULT ''::text) RETURNS SETOF public.customers
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select distinct c.* from public.customers c left join public.customer_aliases a on a.customer_id = c.id
  where c.merged_into is null and (
    (regexp_replace(customer_matches.phone, '[^0-9]', '', 'g') <> '' and
      regexp_replace(customer_matches.phone, '[^0-9]', '', 'g') in (c.phone_key,a.phone_key))
    or (upper(regexp_replace(customer_matches.document, '[^a-zA-Z0-9]', '', 'g')) <> '' and
      upper(regexp_replace(customer_matches.document, '[^a-zA-Z0-9]', '', 'g')) in (c.document_key,a.document_key))
  );
$$;


--
-- Name: deliver_workshop_order(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.deliver_workshop_order(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','workshop.deliver','payload',payload);
  service_order public.work_orders;
  checklist jsonb;
  is_exception boolean;
  delivery public.workshop_deliveries;
  result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
 if exists(select 1 from public.work_orders where id=payload->>'orderId' and status='Presupuesto') then raise exception 'ESTIMATE_NOT_RECEIVED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_DELIVERY_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  select * into service_order from public.work_orders where id=payload->>'orderId' for update;
  if service_order.id is null or service_order.status='Entregado' then raise exception 'ORDER_NOT_OPEN'; end if;
  if (payload->>'expectedVersion')::integer is distinct from service_order.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
  checklist:=private.delivery_checklist(service_order.id);
  is_exception:=coalesce((payload->>'exception')::boolean,false);
  if jsonb_array_length(checklist->'openTimers')>0 then raise exception 'DELIVERY_HAS_OPEN_TIMERS'; end if;
  if is_exception then
    if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then
      raise exception using errcode='42501',message='DELIVERY_EXCEPTION_REQUIRES_MANAGEMENT'; end if;
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'DELIVERY_EXCEPTION_REASON_REQUIRED'; end if;
  elsif (checklist->>'pendingCosts')::integer>0 or jsonb_array_length(checklist->'openTasks')>0
    or checklist->>'pendingEstimate' is not null then raise exception 'DELIVERY_HAS_PENDING_ITEMS';
  end if;
  if (checklist->>'estimatedUnpaid')::numeric>0 and (
    nullif(btrim(payload->>'creditReason'),'') is null or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner')
  ) then raise exception 'DELIVERY_REQUIRES_CREDIT_AUTHORIZATION'; end if;
  -- Partial reception fields remain visible in the act, never silently marked as completed.
  if jsonb_array_length(checklist->'pendingFields')>0 and coalesce((payload->>'acknowledgePendingReception')::boolean,false) is not true
    then raise exception 'ACKNOWLEDGE_PENDING_RECEPTION'; end if;
  insert into public.workshop_deliveries(order_id,recipient,evidence,exception,reason,credit_reason,checklist,responsible_id)
  values(service_order.id,btrim(payload->>'recipient'),btrim(payload->>'evidence'),is_exception,
    coalesce(btrim(payload->>'reason'),''),coalesce(btrim(payload->>'creditReason'),''),checklist,auth.uid()) returning * into delivery;
  update public.work_orders set status='Entregado',version=version+1 where id=service_order.id;
  -- A fleet vehicle still requires scheduling/cleaning release; delivery is not rental availability.
  update public.vehicles set status=case when not in_rental_fleet then 'Disponible' else 'En taller' end,
    version=version+1 where id=service_order.vehicle_id;
  result:=to_jsonb(delivery);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;


--
-- Name: estimate_pdf(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.estimate_pdf(estimate_id uuid, expected_status text, pdf_base64 text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  quote public.estimate_versions;
  document public.estimate_documents;
  content bytea;
begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into quote from public.estimate_versions where id=estimate_id;
  if quote.id is null then raise exception 'ESTIMATE_NOT_FOUND'; end if;
  select * into document from public.estimate_documents d where d.estimate_id=quote.id and d.status=expected_status;
  if document.id is not null then
    return jsonb_build_object('id',document.id,'hash',document.file_hash,'base64',
      (select encode(f.content,'base64') from private.estimate_document_files f where f.document_id=document.id));
  end if;
  if pdf_base64 is null then return null; end if;
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if expected_status is distinct from quote.status then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
  if length(pdf_base64)>7000000 then raise exception 'DOCUMENT_TOO_LARGE'; end if;
  content:=decode(pdf_base64,'base64');
  if octet_length(content) not between 8 and 5242880 or substring(content from 1 for 5)<>convert_to('%PDF-','UTF8') then raise exception 'INVALID_PDF'; end if;
  insert into public.estimate_documents(estimate_id,status,file_hash,created_by)
  values(quote.id,quote.status,encode(sha256(content),'hex'),auth.uid()) returning * into document;
  insert into private.estimate_document_files values(document.id,content);
  return jsonb_build_object('id',document.id,'hash',document.file_hash,'base64',encode(content,'base64'));
end;
$$;


--
-- Name: execute_administration_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_administration_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','administration.'||command,'payload',payload);result jsonb;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if command is null or command not in ('grant_role','revoke_role','cost_center') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_ADMINISTRATION_COMMAND';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='cost_center' then
    insert into public.cost_centers(id,name) values(btrim(payload->>'id'),btrim(payload->>'name'))
      on conflict(id) do update set name=excluded.name returning to_jsonb(cost_centers.*) into result;
  else
    if payload->>'role' not in ('owner','admin','reception','technician','accountant') then raise exception 'INVALID_ROLE';end if;
    if command='grant_role' then
      insert into public.user_roles values((payload->>'userId')::uuid,payload->>'role') on conflict do nothing;
    else
      if payload->>'role'='owner' and (select count(*) from public.user_roles where role='owner')<=1 then raise exception 'LAST_OWNER_CANNOT_BE_REMOVED';end if;
      delete from public.user_roles where user_id=(payload->>'userId')::uuid and role=payload->>'role';
    end if;
    result:=payload;
  end if;
  insert into public.audit_events(actor,entity,entity_id,action,after_data)
  values(auth.uid(),'administration',coalesce(payload->>'userId',payload->>'id'),command,payload);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;


--
-- Name: execute_billing_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_billing_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare result jsonb;previous text;previous_account text;begin
  previous:=current_setting('aj.billing_allocations',true);previous_account:=current_setting('aj.refund_account',true);
  perform set_config('aj.billing_allocations',coalesce((payload->'allocations')::text,''),true);
  perform set_config('aj.refund_account',coalesce(payload->>'refundAccount',''),true);
  result:=private.billing_command_before_grouped(command,payload,idempotency_key);
  perform set_config('aj.billing_allocations',coalesce(previous,''),true);
  perform set_config('aj.refund_account',coalesce(previous_account,''),true);return result;
end $$;


--
-- Name: execute_case_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_case_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
      update public.vehicles set km=coalesce((payload->>'km')::integer,km),version=version+1 where id=car.id;
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
          or nullif(btrim(row->>'description'),'') is null or length(row->>'description')>2000 then raise exception 'INVALID_ESTIMATE_LINE';end if;
        total:=total+round(quantity*unit_price,2);known_cost:=known_cost+coalesce(round(quantity*unit_cost,2),0);
        complete:=complete and unit_cost is not null;
        lines:=lines||jsonb_build_array(jsonb_build_object('tariffId',null,'code','Libre','tariffRevision',0,
          'description',btrim(row->>'description'),'kind',coalesce(row->>'kind','Material'),'quantity',quantity,
          'unitPrice',unit_price,'unitCost',unit_cost,'cost',round(quantity*unit_cost,2),'price',round(quantity*unit_price,2),
          'source',row->'source'));
      end loop;
      amount:=coalesce((payload->>'discount')::numeric,0);
      if amount<0 or amount<>round(amount,2) or amount>total or (amount=total and not job.internal_job) or total-amount>999999999999.99 then raise exception 'INVALID_DISCOUNT';end if;
      insert into public.estimate_versions(order_id,revision,parent_id,snapshot,customer_snapshot,vehicle_snapshot,reason,created_by)
      values(job.id,coalesce(parent.revision,0)+1,parent.id,jsonb_build_object('policy','manual-before-tax-v1','currency','USD',
        'rounding','half-up-per-line-2-decimals','method','commercial','ratio',null,'lines',lines,'cost',known_cost,'costComplete',complete,
        'commercial',total,'subtotal',total,'discount',amount,'total',total-amount,'margin',case when complete and not job.internal_job then total-amount-known_cost else null end,
        'marginPct',case when complete and not job.internal_job and total>amount then round((total-amount-known_cost)/(total-amount)*100,2) else null end),
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
      select coalesce(sum(s.scope_amount),0) into existing from private.vehicle_document_sources(job.vehicle_id,job.id) s;
      amount:=(quote.snapshot->>'total')::numeric-existing;
      if amount<=0 then raise exception 'SCOPE_ALREADY_BILLED_OR_CREDIT_REQUIRED';end if;
      insert into public.billing_documents(customer_id,order_id,description,amount,issued_on,due_on,source_key,customer_snapshot,created_by,estimate_id)
      values(job.customer_id,job.id,'Alcance aprobado '||job.id||' V'||quote.revision,amount,(payload->>'date')::date,(payload->>'dueOn')::date,
        'estimate:'||quote.id,quote.customer_snapshot,auth.uid(),quote.id) returning to_jsonb(billing_documents.*) into result;
    end if;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;


--
-- Name: execute_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;result jsonb;car public.vehicles;request jsonb:=jsonb_build_object('command',command,'payload',payload);
  entity text;booking public.reservations;
begin
  if command is null or command not in ('create_customer','merge_customer','create_vehicle','receive_vehicle','record_expense') then raise exception 'UNKNOWN_COMMAND';end if;
  if not public.has_permission(case command when 'create_customer' then 'customers.write' when 'merge_customer' then 'customers.merge'
    when 'record_expense' then 'expenses.write' when 'receive_vehicle' then 'orders.write' else 'vehicles.write' end)
    then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
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
      if payload ? 'unverifiedFields' and jsonb_typeof(payload->'unverifiedFields') is distinct from 'array'
        then raise exception 'INVALID_UNVERIFIED_FIELDS';end if;
      if exists(select 1 from jsonb_array_elements_text(coalesce(payload->'unverifiedFields','[]')) f
        where f not in ('plate','color','daily','km','ownership','status'))
        or (payload->>'initialStatus' is not null and payload->>'initialStatus' not in ('Disponible','Por confirmar'))
        then raise exception 'INVALID_UNVERIFIED_FIELDS';end if;
      if payload->>'initialStatus'='Disponible' and (payload->'unverifiedFields') ? 'km' and not coalesce((payload->>'inRentalFleet')::boolean,false)
        then raise exception 'CONFIRMED_ODOMETER_REQUIRED';end if;
      update public.vehicles set in_rental_fleet=coalesce((payload->>'inRentalFleet')::boolean,ownership='Propio'),
        registered_holder=coalesce(btrim(payload->>'registeredHolder'),''),commercial_line=coalesce(btrim(payload->>'commercialLine'),''),
        status=coalesce(payload->>'initialStatus',status),
        unverified_fields=array(select distinct field from jsonb_array_elements_text(coalesce(payload->'unverifiedFields','[]')) field)
        where id=(result->>'id')::uuid;
    end if;
    return result;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;


--
-- Name: execute_commission_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_commission_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','commission.'||command,'payload',payload);
  rule public.commission_rules;booking public.reservations;binding public.commission_bindings;entry public.commission_entries;
  next_revision integer;basis jsonb;v_basis_hash text;base numeric;previous numeric;cutoff_date date;result jsonb;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if command is null or command not in ('rule','calculate','eligibility') or idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_COMMISSION_COMMAND';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='rule' then
    select coalesce(max(revision),0)+1 into next_revision from public.commission_rules where code=upper(btrim(payload->>'code'));
    insert into public.commission_rules(code,revision,rate,valid_from,valid_until,created_by)
    values(upper(btrim(payload->>'code')),next_revision,(payload->>'rate')::numeric,(payload->>'validFrom')::date,(payload->>'validUntil')::date,auth.uid()) returning * into rule;
    result:=to_jsonb(rule);
  elsif command='eligibility' then
    insert into public.commission_eligibility(document_id,eligible,reason,created_by)
    values((payload->>'documentId')::uuid,(payload->>'eligible')::boolean,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(commission_eligibility.*) into result;
  else
    select * into booking from public.reservations where id=(payload->>'reservationId')::uuid;
    select * into rule from public.commission_rules where id=(payload->>'ruleId')::uuid;
    cutoff_date:=(payload->>'cutoff')::date;
    if booking.id is null or rule.id is null or cutoff_date is null or not isfinite(cutoff_date)
      or cutoff_date<(select max(cutoff) from public.commission_entries where reservation_id=booking.id)
      or (booking.starts_at at time zone 'America/El_Salvador')::date not between rule.valid_from and rule.valid_until then raise exception 'INVALID_COMMISSION_RULE';end if;
    select * into binding from public.commission_bindings where reservation_id=booking.id;
    if binding.id is not null and binding.rule_id<>rule.id then raise exception 'COMMISSION_RULE_ALREADY_FROZEN';end if;
    if binding.id is null then insert into public.commission_bindings(reservation_id,rule_id,created_by) values(booking.id,rule.id,auth.uid());end if;
    select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'),coalesce(sum(case a.kind when 'Aplicacion' then a.amount else -a.amount end),0)
      into basis,base from private.reservation_payment_sources(booking.id) a join public.billing_documents d on d.id=a.document_id
      where (d.reservation_id=booking.id or exists(select 1 from public.billing_document_lines line where line.document_id=d.id and line.reservation_id=booking.id)) and coalesce((select e.eligible from public.commission_eligibility e
        where e.document_id=d.id and e.created_at<(cutoff_date+1)::timestamp at time zone 'America/El_Salvador'
        order by e.created_at desc,e.id desc limit 1),d.commission_eligible) and a.effective_on<=cutoff_date
      and a.created_at<(cutoff_date+1)::timestamp at time zone 'America/El_Salvador';
    v_basis_hash:=encode(sha256(convert_to(basis::text||rule.id::text||coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at,e.id)::text
      from public.commission_eligibility e join public.billing_documents d on d.id=e.document_id where (d.reservation_id=booking.id or exists(select 1 from public.billing_document_lines line where line.document_id=d.id and line.reservation_id=booking.id))
      and e.created_at<(cutoff_date+1)::timestamp at time zone 'America/El_Salvador'),'[]'),'UTF8')),'hex');
    select * into entry from public.commission_entries where reservation_id=booking.id and commission_entries.basis_hash=v_basis_hash;
    if entry.id is null then
      select coalesce(sum(amount),0) into previous from public.commission_entries where reservation_id=booking.id;
      insert into public.commission_entries(reservation_id,seller_id,rule_id,cutoff,eligible_base,amount,rule_snapshot,basis_hash,created_by)
      values(booking.id,booking.seller_id,rule.id,cutoff_date,base,round(base*rule.rate,2)-previous,to_jsonb(rule),v_basis_hash,auth.uid()) returning * into entry;
    end if;
    result:=to_jsonb(entry);
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;


--
-- Name: execute_contract_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_contract_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','contract.'||command,'payload',payload);
  booking public.reservations;contract public.rental_contracts;parent public.rental_contracts;result jsonb;
begin
  if not public.has_permission('orders.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if command is null or command not in ('version','accept') or idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_CONTRACT_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT'; end if;return prior.result;end if;
  if command='version' then
    select * into booking from public.reservations where id=(payload->>'reservationId')::uuid;
    if booking.id is null or booking.status='Cancelada' then raise exception 'INVALID_CONTRACT_BOOKING'; end if;
    select * into parent from public.rental_contracts where reservation_id=booking.id order by revision desc limit 1;
    if (payload->>'parentId')::uuid is distinct from parent.id then raise exception 'PARENT_VERSION_CONFLICT'; end if;
    insert into public.rental_contracts(reservation_id,revision,parent_id,booking_snapshot,conditions,reason,created_by)
    values(booking.id,coalesce(parent.revision,0)+1,parent.id,to_jsonb(booking),btrim(payload->>'conditions'),btrim(payload->>'reason'),auth.uid()) returning * into contract;
    result:=to_jsonb(contract);
  else
    select * into contract from public.rental_contracts where id=(payload->>'contractId')::uuid;
    select * into booking from public.reservations where id=contract.reservation_id;
    if contract.id is null or booking.status='Cancelada' or contract.revision<>(select max(revision) from public.rental_contracts where reservation_id=booking.id)
      or (contract.booking_snapshot->>'ends_at')::timestamptz<>booking.ends_at or (contract.booking_snapshot->>'total')::numeric<>booking.total then raise exception 'CONTRACT_SCOPE_CHANGED'; end if;
    insert into public.contract_acceptances(contract_id,accepted_by,evidence,created_by)
    values(contract.id,btrim(payload->>'acceptedBy'),btrim(payload->>'evidence'),auth.uid()) returning to_jsonb(contract_acceptances.*) into result;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;


--
-- Name: execute_cost_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_cost_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','cost.'||command,'payload',payload);
  cost public.workshop_costs;
  service_order public.work_orders;
  quote public.estimate_versions;
  quantity numeric;
  unit_cost numeric;
  new_disposition text;
  result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if command is null or command not in ('purchase','classify') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_COST_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if command='purchase' then
    select * into service_order from public.work_orders where id=payload->>'orderId' for update;
    if service_order.id is null or service_order.status='Entregado' then raise exception 'ORDER_NOT_OPEN'; end if;
    quantity:=(payload->>'quantity')::numeric;unit_cost:=(payload->>'unitCost')::numeric;
    if quantity is null or unit_cost is null or quantity<>round(quantity,4) or unit_cost<>round(unit_cost,4) then raise exception 'INVALID_COST_PRECISION'; end if;
    insert into public.workshop_costs(order_id,kind,description,quantity,unit_cost,amount,supplier,source_reference,occurred_at,created_by)
    values(service_order.id,'Compra directa',btrim(payload->>'description'),quantity,unit_cost,round(quantity*unit_cost,2),
      btrim(payload->>'supplier'),btrim(payload->>'sourceReference'),(payload->>'date')::date,auth.uid()) returning * into cost;
  else
    select * into cost from public.workshop_costs where id=(payload->>'costId')::uuid for update;
    if cost.id is null then raise exception 'COST_NOT_FOUND'; end if;
    if (payload->>'expectedVersion')::integer is distinct from cost.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    select * into service_order from public.work_orders where id=cost.order_id for update;
    if service_order.status='Entregado' then raise exception 'ORDER_NOT_OPEN'; end if;
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'COST_REASON_REQUIRED'; end if;
    new_disposition:=payload->>'disposition';
    if new_disposition is null or new_disposition not in ('Incluido','Adicional autorizado','Interno','Absorbido') then raise exception 'INVALID_COST_DISPOSITION'; end if;
    if new_disposition in ('Incluido','Adicional autorizado') then
      select * into quote from public.estimate_versions where id=(payload->>'estimateId')::uuid;
      if quote.id is null or quote.order_id<>cost.order_id or quote.status<>'Aprobado' then raise exception 'APPROVED_SCOPE_REQUIRED'; end if;
      if service_order.internal_job or exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership='Propio') then raise exception 'INTERNAL_VEHICLE_NOT_A_SALE'; end if;
    end if;
    update public.workshop_costs set disposition=new_disposition,estimate_id=quote.id,
      reason=btrim(payload->>'reason'),version=version+1 where id=cost.id returning * into cost;
    if cost.expense_id is not null then update public.expenses set disposition=cost.disposition where id=cost.expense_id; end if;
  end if;
  result:=to_jsonb(cost);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;


--
-- Name: execute_delivery_cost_adjustment(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_delivery_cost_adjustment(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','delivery-cost.'||command,'payload',payload);
  cost public.workshop_costs;
  service_order public.work_orders;
  quote public.estimate_versions;
  new_disposition text;
  quantity numeric;
  unit_cost numeric;
  result jsonb;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then
    raise exception using errcode='42501',message='DELIVERY_ADJUSTMENT_REQUIRES_MANAGEMENT'; end if;
  if command is null or command not in ('purchase','classify') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_COST_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if nullif(btrim(payload->>'reason'),'') is null then raise exception 'COST_REASON_REQUIRED'; end if;
  if command='classify' then
    select * into cost from public.workshop_costs where id=(payload->>'costId')::uuid for update;
    if cost.id is null then raise exception 'COST_NOT_FOUND'; end if;
    if (payload->>'expectedVersion')::integer is distinct from cost.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
  end if;
  select * into service_order from public.work_orders where id=coalesce(cost.order_id,payload->>'orderId') for update;
  if service_order.id is null or service_order.status<>'Entregado' or not exists(
    select 1 from public.workshop_deliveries where order_id=service_order.id
  ) then raise exception 'DELIVERED_ORDER_REQUIRED'; end if;
  if command='purchase' then
    quantity:=(payload->>'quantity')::numeric;unit_cost:=(payload->>'unitCost')::numeric;
    if quantity is null or unit_cost is null or quantity<>round(quantity,4) or unit_cost<>round(unit_cost,4) then raise exception 'INVALID_COST_PRECISION'; end if;
    insert into public.workshop_costs(order_id,kind,description,quantity,unit_cost,amount,supplier,source_reference,occurred_at,created_by,reason)
    values(service_order.id,'Compra directa',btrim(payload->>'description'),quantity,unit_cost,round(quantity*unit_cost,2),
      btrim(payload->>'supplier'),btrim(payload->>'sourceReference'),(payload->>'date')::date,auth.uid(),
      'Ajuste posterior a entrega: '||btrim(payload->>'reason')) returning * into cost;
  else
    new_disposition:=payload->>'disposition';
    if new_disposition is null or new_disposition not in ('Incluido','Adicional autorizado','Interno','Absorbido') then raise exception 'INVALID_COST_DISPOSITION'; end if;
    if new_disposition in ('Incluido','Adicional autorizado') then
      select * into quote from public.estimate_versions where id=(payload->>'estimateId')::uuid;
      if quote.id is null or quote.order_id<>cost.order_id or quote.status<>'Aprobado' then raise exception 'APPROVED_SCOPE_REQUIRED'; end if;
      if service_order.internal_job or exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership='Propio') then raise exception 'INTERNAL_VEHICLE_NOT_A_SALE'; end if;
    end if;
    update public.workshop_costs set disposition=new_disposition,estimate_id=quote.id,version=version+1,
      reason='Ajuste posterior a entrega: '||btrim(payload->>'reason') where id=cost.id returning * into cost;
    if cost.expense_id is not null then update public.expenses set disposition=cost.disposition where id=cost.expense_id; end if;
  end if;
  result:=to_jsonb(cost);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;


--
-- Name: execute_estimate_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_estimate_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  prior private.command_results;
  request jsonb := jsonb_build_object('command','estimate.'||command,'payload',payload);
  tariff public.workshop_tariffs;
  quote public.estimate_versions;
  service_order public.work_orders;
  parent public.estimate_versions;
  result jsonb;
  calculation jsonb;
  next_revision integer;
  tariff_code text;
  decision text;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if command not in ('tariff','version','approve','reject') or command is null or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_ESTIMATE_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request <> request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if command = 'tariff' then
    tariff_code := upper(btrim(payload->>'code'));
    select coalesce(max(t.revision),0)+1 into next_revision from public.workshop_tariffs t where t.code=tariff_code;
    insert into public.workshop_tariffs(code,revision,description,kind,unit_cost,unit_price,created_by)
    values(tariff_code,next_revision,btrim(payload->>'description'),payload->>'kind',(payload->>'unitCost')::numeric,
      (payload->>'unitPrice')::numeric,auth.uid()) returning * into tariff;
    result := to_jsonb(tariff);
  elsif command = 'version' then
    select * into service_order from public.work_orders where id=payload->>'orderId' for update;
    if service_order.id is null or service_order.status='Entregado' then raise exception 'ORDER_NOT_OPEN'; end if;
    select * into parent from public.estimate_versions where order_id=service_order.id order by revision desc limit 1;
    if (payload->>'parentId')::uuid is distinct from parent.id then raise exception using errcode='23505',message='PARENT_VERSION_CONFLICT'; end if;
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'VERSION_REASON_REQUIRED'; end if;
    calculation := private.calculate_estimate(payload->'lines',coalesce(payload->>'method','commercial'),
      (payload->>'ratio')::numeric,coalesce((payload->>'discount')::numeric,0));
    insert into public.estimate_versions(order_id,revision,parent_id,snapshot,customer_snapshot,vehicle_snapshot,reason,created_by)
    values(service_order.id,coalesce(parent.revision,0)+1,parent.id,calculation,
      (select to_jsonb(c)-'phone_key'-'document_key' from public.customers c where c.id=service_order.customer_id),
      (select to_jsonb(v) from public.vehicles v where v.id=service_order.vehicle_id),btrim(payload->>'reason'),auth.uid()) returning * into quote;
    result := to_jsonb(quote);
  else
    select * into quote from public.estimate_versions where id=(payload->>'estimateId')::uuid for update;
    if quote.id is null or quote.status<>'Borrador' then raise exception 'ESTIMATE_NOT_PENDING'; end if;
    if quote.revision <> (select max(revision) from public.estimate_versions where order_id=quote.order_id) then raise exception 'SUPERSEDED_ESTIMATE'; end if;
    select * into service_order from public.work_orders where id=quote.order_id for update;
    if service_order.status='Entregado' then raise exception 'ORDER_NOT_OPEN'; end if;
    if command='approve' and (quote.snapshot->>'discount')::numeric>0 and not exists(
      select 1 from public.user_roles where user_id=auth.uid() and role='owner'
    ) then raise exception using errcode='42501',message='DISCOUNT_REQUIRES_MANAGEMENT'; end if;
    decision := case command when 'approve' then 'Aprobado' else 'Rechazado' end;
    insert into public.estimate_approvals(estimate_id,decision,approver_name,evidence,occurred_at,recorded_by)
    values(quote.id,decision,btrim(payload->>'approverName'),btrim(payload->>'evidence'),
      coalesce((payload->>'occurredAt')::timestamptz,now()),auth.uid());
    update public.estimate_versions set status=decision where id=quote.id returning * into quote;
    if command='approve' then
      update public.work_orders set active_estimate_id=quote.id,estimate=(quote.snapshot->>'total')::numeric,
        version=version+1 where id=quote.order_id;
    end if;
    result := to_jsonb(quote);
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;


--
-- Name: execute_inventory_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_inventory_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','inventory.'||command,'payload',payload);
  item public.stock_items;
  purchase public.purchase_orders;
  movement public.stock_movements;
  dispatch public.stock_movements;
  q numeric;
  rate numeric;
  value numeric;
  received numeric;
  returned_q numeric;
  returned_value numeric;
  result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if command is null or command not in ('item','opening','consume','return','request','authorize','receive') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_INVENTORY_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if command='item' then
    insert into public.stock_items(sku,name,unit,created_by) values(upper(btrim(payload->>'sku')),btrim(payload->>'name'),btrim(payload->>'unit'),auth.uid()) returning * into item;
    result:=to_jsonb(item);
  else
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVENTORY_REASON_REQUIRED'; end if;
    if command='return' then
      select * into dispatch from public.stock_movements where id=(payload->>'dispatchId')::uuid and kind='Consumo';
      if dispatch.id is null then raise exception 'DISPATCH_NOT_FOUND'; end if;
    elsif command in ('receive','authorize') then
      select * into purchase from public.purchase_orders where id=(payload->>'purchaseId')::uuid for update;
      if purchase.id is null then raise exception 'PURCHASE_NOT_FOUND'; end if;
      if (payload->>'expectedVersion')::integer is distinct from purchase.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    end if;
    select * into item from public.stock_items where id=coalesce(dispatch.item_id,purchase.item_id,(payload->>'itemId')::uuid) for update;
    if item.id is null then raise exception 'ITEM_NOT_FOUND'; end if;
    if command<>'authorize' then
      q:=(payload->>'quantity')::numeric;
      if q is null or q<=0 or q<>round(q,4) or q::text in ('NaN','Infinity') then raise exception 'INVALID_STOCK_QUANTITY'; end if;
    end if;
    if command in ('opening','request') then
      rate:=(payload->>'unitCost')::numeric;
      if rate is null or rate<=0 or rate<>round(rate,4) or rate::text in ('NaN','Infinity') then raise exception 'INVALID_STOCK_COST'; end if;
    end if;
    if command='request' then
      insert into public.purchase_orders(item_id,supplier,quantity,unit_cost,reason,created_by)
      values(item.id,btrim(payload->>'supplier'),q,rate,btrim(payload->>'reason'),auth.uid()) returning * into purchase;
      result:=to_jsonb(purchase);
    elsif command='authorize' then
      if purchase.status<>'Solicitada' or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception 'PURCHASE_AUTHORIZATION_REQUIRED'; end if;
      update public.purchase_orders set status='Autorizada',authorized_by=auth.uid(),version=version+1 where id=purchase.id returning * into purchase;
      result:=to_jsonb(purchase);
    else
      if command='receive' then
        if purchase.status<>'Autorizada' then raise exception 'PURCHASE_NOT_AUTHORIZED'; end if;
        select coalesce(sum(quantity),0) into received from public.stock_movements where purchase_id=purchase.id;
        if q>purchase.quantity-received then raise exception 'RECEIPT_EXCEEDS_PENDING_QUANTITY'; end if;
        rate:=purchase.unit_cost;value:=round(q*rate,2);
      elsif command='opening' then value:=round(q*rate,2);
      elsif command='consume' then
        if not exists(select 1 from public.work_orders where id=payload->>'orderId' and status<>'Entregado') then raise exception 'ORDER_NOT_OPEN'; end if;
        if q>item.quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
        rate:=round(item.stock_value/item.quantity,4);
        value:=case when q=item.quantity then item.stock_value else round(q*rate,2) end;
      else
        if not exists(select 1 from public.work_orders where id=dispatch.order_id and status<>'Entregado') then raise exception 'ORDER_NOT_OPEN'; end if;
        select coalesce(sum(quantity),0),coalesce(sum(amount),0) into returned_q,returned_value from public.stock_movements where reverses_id=dispatch.id;
        if q>dispatch.quantity-returned_q then raise exception 'RETURN_EXCEEDS_DISPATCH'; end if;
        rate:=dispatch.unit_cost;value:=case when q=dispatch.quantity-returned_q then dispatch.amount-returned_value else round(dispatch.amount*q/dispatch.quantity,2) end;
      end if;
      insert into public.stock_movements(item_id,order_id,purchase_id,reverses_id,kind,quantity,unit_cost,amount,reason,created_by)
      values(item.id,case when command='consume' then payload->>'orderId' else dispatch.order_id end,purchase.id,dispatch.id,
        case command when 'consume' then 'Consumo' when 'return' then 'Devolucion' else 'Entrada' end,q,rate,value,btrim(payload->>'reason'),auth.uid()) returning * into movement;
      update public.stock_items set quantity=quantity+case when command='consume' then -q else q end,
        stock_value=stock_value+case when command='consume' then -value else value end,version=version+1 where id=item.id;
      if command='consume' then
        insert into public.workshop_costs(order_id,kind,description,quantity,unit_cost,amount,stock_dispatch_id,occurred_at,created_by)
        values(payload->>'orderId','Consumo',item.name,q,rate,value,movement.id,(now() at time zone 'America/El_Salvador')::date,auth.uid());
      elsif command='return' then
        update public.workshop_costs set quantity=quantity-q,amount=amount-value,version=version+1,
          disposition=case when amount=value then 'Interno' else disposition end,reason='Devolución: '||btrim(payload->>'reason') where stock_dispatch_id=dispatch.id;
      elsif command='receive' then
        insert into public.supplier_obligations(purchase_id,receipt_id,supplier,amount,created_by) values(purchase.id,movement.id,purchase.supplier,value,auth.uid());
        update public.purchase_orders set status=case when received+q=quantity then 'Recibida' else 'Autorizada' end,version=version+1 where id=purchase.id;
      end if;
      result:=to_jsonb(movement);
    end if;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;


--
-- Name: execute_optional_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_optional_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','optional.'||command,'payload',payload);
  event public.integration_inbox;result jsonb;business_result jsonb;hash text;plan uuid;purchase uuid;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if command is null or command not in ('budget','link_purchase','link_expense','enqueue','process') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_OPTIONAL_COMMAND';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='budget' then
    insert into public.operating_budgets(name,area,category,starts_on,ends_on,authorized,created_by)
    values(btrim(payload->>'name'),payload->>'area',payload->>'category',(payload->>'startsOn')::date,(payload->>'endsOn')::date,(payload->>'authorized')::numeric,auth.uid())
      returning to_jsonb(operating_budgets.*) into result;
  elsif command='link_purchase' then
    insert into public.budget_purchase_links(budget_id,purchase_id,created_by) values((payload->>'budgetId')::uuid,(payload->>'purchaseId')::uuid,auth.uid())
      returning to_jsonb(budget_purchase_links.*) into result;
  elsif command='link_expense' then
    plan:=(payload->>'budgetId')::uuid;purchase:=(payload->>'purchaseId')::uuid;
    if purchase is not null and not exists(select 1 from public.budget_purchase_links where budget_id=plan and purchase_id=purchase) then raise exception 'PURCHASE_BUDGET_MISMATCH';end if;
    if purchase is not null and (select amount from public.expenses where id=payload->>'expenseId')+
      coalesce((select sum(e.amount) from public.budget_expense_links l join public.expenses e on e.id=l.expense_id where l.purchase_id=purchase),0)
      >coalesce((select sum(amount) from public.supplier_obligations where purchase_id=purchase),0) then raise exception 'LINKED_PAYMENT_EXCEEDS_RECEIVED_PURCHASE';end if;
    insert into public.budget_expense_links(budget_id,expense_id,purchase_id,reason,created_by)
    values(plan,payload->>'expenseId',purchase,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(budget_expense_links.*) into result;
  elsif command='enqueue' then
    hash:=encode(sha256(convert_to((payload->'event')::text,'UTF8')),'hex');
    select * into event from public.integration_inbox where source=btrim(execute_optional_command.payload->>'source') and external_id=btrim(execute_optional_command.payload->>'externalId');
    if event.id is not null then
      if event.payload_hash<>hash then raise exception 'EXTERNAL_EVENT_PAYLOAD_CONFLICT';end if;
    else
      if jsonb_typeof(payload->'event') is distinct from 'object' then raise exception 'EVENT_OBJECT_REQUIRED';end if;
      insert into public.integration_inbox(source,external_id,payload,payload_hash,created_by)
      values(btrim(payload->>'source'),btrim(payload->>'externalId'),payload->'event',hash,auth.uid()) returning * into event;
    end if;
    result:=to_jsonb(event);
  else
    select * into event from public.integration_inbox where id=(execute_optional_command.payload->>'eventId')::uuid for update;
    if event.id is null then raise exception 'EVENT_NOT_FOUND';end if;
    if event.state<>'Procesado' then
      begin
        business_result:=public.execute_command('record_expense',event.payload,event.id);
        update public.integration_inbox set state='Procesado',result=business_result,attempts=attempts+1,last_error=null where id=event.id returning * into event;
      exception when others then
        update public.integration_inbox set state='Error',attempts=attempts+1,last_error=SQLSTATE||':'||SQLERRM where id=event.id returning * into event;
      end;
    end if;
    result:=to_jsonb(event);
  end if;
  -- A failed process attempt must be retryable with a new request key; successful events always replay their result.
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;


--
-- Name: execute_payment_import(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_payment_import(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','payment-import.'||command,'payload',payload);
  batch public.payment_imports;file bytea;hash text;v_preview jsonb;row jsonb;p jsonb;payment jsonb;v_new_total numeric;result jsonb;command_key uuid;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if command is null or command not in ('stage','validate','commit') or idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_PAYMENT_IMPORT_COMMAND';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='stage' then
    if length(payload->>'base64')>7000000 or jsonb_typeof(payload->'rows') is distinct from 'array' or jsonb_array_length(payload->'rows') not between 1 and 500 then raise exception 'IMPORT_LIMIT_EXCEEDED';end if;
    file:=decode(payload->>'base64','base64');if octet_length(file) not between 1 and 5242880 then raise exception 'IMPORT_LIMIT_EXCEEDED';end if;
    hash:=encode(sha256(file),'hex');
    select * into batch from public.payment_imports where file_hash=hash and sheet=payload->>'sheet';
    if batch.id is null then
      insert into public.payment_imports(file_name,file_hash,sheet,rows,created_by)
      values(payload->>'fileName',hash,payload->>'sheet',payload->'rows',auth.uid()) returning * into batch;
      insert into private.payment_import_files values(batch.id,file);
    elsif batch.rows<>payload->'rows' then raise exception 'STORED_ARTIFACT_CONTENT_MISMATCH';end if;
  else
    select * into batch from public.payment_imports where id=(payload->>'batchId')::uuid for update;
    if batch.id is null then raise exception 'IMPORT_NOT_FOUND';end if;
    if batch.status='Publicado' then return to_jsonb(batch);end if;
    if (payload->>'expectedVersion')::integer is distinct from batch.version then raise exception 'VERSION_CONFLICT';end if;
    if command='validate' then
      if jsonb_typeof(payload->'mapping') is distinct from 'object' or jsonb_typeof(payload->'decisions') is distinct from 'object'
        or nullif(btrim(payload->>'sourceSystem'),'') is null then raise exception 'IMPORT_MAPPING_REQUIRED';end if;
      batch.mapping:=payload->'mapping';batch.decisions:=payload->'decisions';batch.source_system:=btrim(payload->>'sourceSystem');
      v_preview:=private.payment_import_preview(batch);
      select coalesce(sum((value->'payload'->>'amount')::numeric),0) into v_new_total from jsonb_array_elements(v_preview) where value->>'status'='Valida';
      update public.payment_imports set mapping=batch.mapping,decisions=batch.decisions,source_system=batch.source_system,
        preview=v_preview,new_total=v_new_total,status='Validado',version=version+1 where id=batch.id returning * into batch;
    else
      if batch.status<>'Validado' or batch.new_total is distinct from (payload->>'expectedTotal')::numeric then raise exception 'RECONCILIATION_REQUIRED';end if;
      v_preview:=private.payment_import_preview(batch);
      if v_preview<>batch.preview then raise exception 'IMPORT_PREVIEW_CHANGED';end if;
      if exists(select 1 from jsonb_array_elements(v_preview) where value->>'status' not in ('Valida','Duplicada','Excluida')) then raise exception 'UNRESOLVED_IMPORT_ROWS';end if;
      for row in select value from jsonb_array_elements(v_preview) loop
        p:=row->'payload';
        if row->>'status'='Valida' then
          command_key:=substr(encode(sha256(convert_to(batch.id::text||':'||(row->>'rowNumber'),'UTF8')),'hex'),1,32)::uuid;
          payment:=public.execute_billing_command('pay',p,command_key);
          if p->>'documentId' is not null then
            command_key:=substr(encode(sha256(convert_to(batch.id::text||':apply:'||(row->>'rowNumber'),'UTF8')),'hex'),1,32)::uuid;
            perform public.execute_billing_command('apply',p||jsonb_build_object('paymentId',payment->>'id'),command_key);
          end if;
        elsif row->>'status'='Duplicada' then payment:=jsonb_build_object('id',row->>'paymentId');else continue;end if;
        if p->>'sourceKey' is not null and not exists(select 1 from public.payment_import_origins where source_system=batch.source_system and source_key=p->>'sourceKey') then
          insert into public.payment_import_origins(source_system,source_key,payment_id,fingerprint,created_by)
          values(batch.source_system,p->>'sourceKey',(payment->>'id')::uuid,p,auth.uid());
        end if;
      end loop;
      update public.payment_imports set status='Publicado',version=version+1 where id=batch.id returning * into batch;
    end if;
  end if;
  result:=to_jsonb(batch);insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;


--
-- Name: execute_rental_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_rental_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','rental.'||command,'payload',payload);
  booking public.reservations;
  car public.vehicles;
  outgoing public.rental_inspections;
  incoming public.rental_inspections;
  proposal public.rental_extra_proposals;
  clean_start timestamptz;
  clean_end timestamptz;
  conflict boolean:=false;
  result jsonb;
begin
  if not public.has_permission('orders.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if command is null or command not in ('depart','return','decide_extra') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_RENTAL_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if command='decide_extra' then
    if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
    select * into proposal from public.rental_extra_proposals where id=(payload->>'proposalId')::uuid for update;
    if proposal.id is null or proposal.status<>'Propuesto' then raise exception 'EXTRA_NOT_PENDING'; end if;
    if (payload->>'expectedVersion')::integer is distinct from proposal.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    if payload->>'decision' not in ('Aprobado','Rechazado') or nullif(btrim(payload->>'reason'),'') is null then raise exception 'EXTRA_DECISION_REQUIRED'; end if;
    if payload->>'decision'='Aprobado' and (payload->>'amount')::numeric is null then raise exception 'EXTRA_AMOUNT_REQUIRED'; end if;
    update public.rental_extra_proposals set status=payload->>'decision',amount=(payload->>'amount')::numeric,
      reason=btrim(payload->>'reason'),version=version+1 where id=proposal.id returning * into proposal;
    result:=to_jsonb(proposal);
  else
    select * into booking from public.reservations where id=(payload->>'reservationId')::uuid for update;
    if booking.id is null or booking.status<>'Confirmada' then raise exception 'CONFIRMED_RESERVATION_REQUIRED'; end if;
    if (payload->>'expectedVersion')::integer is distinct from booking.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    select * into car from public.vehicles where id=booking.vehicle_id for update;
    if command='depart' then
      if booking.rental_state<>'Preparado' or car.status<>'Disponible' or car.readiness_hold or now()<booking.starts_at or now()>=booking.ends_at
        then raise exception 'RENTAL_NOT_READY_FOR_DEPARTURE'; end if;
      if (payload->>'km')::integer<car.km then raise exception 'ODOMETER_CANNOT_DECREASE'; end if;
      insert into public.rental_inspections(reservation_id,kind,km,fuel,condition,accessories,evidence,created_by)
      values(booking.id,'Salida',(payload->>'km')::integer,(payload->>'fuel')::numeric,btrim(payload->>'condition'),
        btrim(payload->>'accessories'),btrim(payload->>'evidence'),auth.uid()) returning * into outgoing;
      update public.reservations set rental_state='Entregado',version=version+1 where id=booking.id returning * into booking;
      update public.vehicles set status='Alquilado',km=coalesce(outgoing.km,km),version=version+1 where id=car.id;
      result:=jsonb_build_object('reservation',to_jsonb(booking),'inspection',to_jsonb(outgoing));
    else
      if booking.rental_state<>'Entregado' then raise exception 'RENTAL_NOT_OUT'; end if;
      select * into outgoing from public.rental_inspections where reservation_id=booking.id and kind='Salida';
      if (payload->>'km')::integer<greatest(outgoing.km,car.km) then raise exception 'ODOMETER_CANNOT_DECREASE'; end if;
      insert into public.rental_inspections(reservation_id,kind,km,fuel,condition,accessories,evidence,created_by)
      values(booking.id,'Retorno',(payload->>'km')::integer,(payload->>'fuel')::numeric,btrim(payload->>'condition'),
        btrim(payload->>'accessories'),btrim(payload->>'evidence'),auth.uid()) returning * into incoming;
      if incoming.condition<>outgoing.condition or incoming.accessories<>outgoing.accessories or incoming.fuel<outgoing.fuel then
        insert into public.rental_extra_proposals(reservation_id,description,comparison,created_by)
        values(booking.id,'Diferencias de condición, accesorios o combustible por revisar',
          jsonb_build_object('departure',to_jsonb(outgoing),'return',to_jsonb(incoming)),auth.uid());
      end if;
      update public.reservations set rental_state='Devuelto',version=version+1 where id=booking.id returning * into booking;
      update public.vehicles set status='En taller',readiness_hold=true,km=coalesce(incoming.km,km),version=version+1 where id=car.id;
      update public.vehicle_commitments set active=false where reservation_id=booking.id and kind='Limpieza';
    update public.vehicle_commitments set ends_at=least(ends_at,greatest(clock_timestamp(),starts_at+interval '1 microsecond'))
    where reservation_id=booking.id and kind='Reserva';
    clean_start:=clock_timestamp();clean_end:=clean_start+greatest(interval '1 second',make_interval(mins=>booking.cleaning_minutes));
      update public.vehicle_commitments set active=false where reservation_id=booking.id and kind='Limpieza';
      insert into public.vehicle_commitments(vehicle_id,reservation_id,kind,starts_at,ends_at,active,reason,created_by)
      values(car.id,booking.id,'Limpieza',clean_start,clean_end,false,'Revisión posterior a devolución',auth.uid())
      on conflict(reservation_id,kind) where reservation_id is not null do update set starts_at=excluded.starts_at,ends_at=excluded.ends_at,reason=excluded.reason;
      begin
        update public.vehicle_commitments set active=true where reservation_id=booking.id and kind='Limpieza';
      exception when exclusion_violation then
        conflict:=true;
        update public.vehicle_commitments set reason='CONFLICTO de limpieza tras devolución tardía; requiere reprogramación' where reservation_id=booking.id and kind='Limpieza';
      end;
      result:=jsonb_build_object('reservation',to_jsonb(booking),'departure',to_jsonb(outgoing),'return',to_jsonb(incoming),'cleaningConflict',conflict);
    end if;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;


--
-- Name: execute_report_delivery_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_report_delivery_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if command='claim' then
    perform pg_advisory_xact_lock(6192,1);
    select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
    if found then
      if prior.request<>jsonb_build_object('command','report-delivery.claim','payload',payload) then raise exception 'IDEMPOTENCY_CONFLICT';end if;
      return null;
    end if;
  end if;
  return private.report_delivery_command_core(command,payload,idempotency_key);
end;
$$;


--
-- Name: execute_reservation_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_reservation_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','reservation.'||command,'payload',payload);
  booking public.reservations;
  car public.vehicles;
  block public.vehicle_commitments;
  returned public.rental_inspections;
  latest_return uuid;
  completed_at timestamptz;
  release_blocked boolean;
  result jsonb;
begin
  -- Authorization also precedes cached-result replay, including after permission revocation.
  if auth.uid() is null or not public.has_permission('orders.write') then
    raise exception using errcode='42501',message='PERMISSION_DENIED';
  end if;
  if command is distinct from 'review_return_cleaning' then
    return private.reservation_command_before_cleaning_review(command,payload,idempotency_key);
  end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'INVALID_REQUEST';
  end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;
    return prior.result;
  end if;
  if nullif(btrim(payload->>'reason'),'') is null or length(btrim(payload->>'reason'))>4000 then
    raise exception 'RETURN_CLEANING_REVIEW_REASON_REQUIRED';
  end if;

  select * into booking from public.reservations where id=(payload->>'reservationId')::uuid for update;
  if booking.id is null or booking.status<>'Confirmada' or booking.rental_state<>'Devuelto' then
    raise exception 'RETURN_CLEANING_NOT_REVIEWABLE';
  end if;
  if booking.version is distinct from (payload->>'expectedVersion')::integer then
    raise exception 'VERSION_CONFLICT';
  end if;
  select * into car from public.vehicles where id=booking.vehicle_id for update;
  if car.version is distinct from (payload->>'expectedVehicleVersion')::integer then
    raise exception 'VEHICLE_VERSION_CONFLICT';
  end if;
  select * into block from public.vehicle_commitments where id=(payload->>'blockId')::uuid for update;
  select * into returned from public.rental_inspections where reservation_id=booking.id and kind='Retorno';
  select i.reservation_id into latest_return from public.rental_inspections i
    join public.reservations r on r.id=i.reservation_id
    where r.vehicle_id=car.id and r.status='Confirmada' and r.rental_state in ('Devuelto','Cerrado') and i.kind='Retorno'
    order by i.occurred_at desc,i.id desc limit 1;
  completed_at:=clock_timestamp();
  if block.id is null or block.vehicle_id is distinct from car.id or block.reservation_id is distinct from booking.id
    or block.kind<>'Limpieza' or block.order_id is not null or returned.id is null
    or latest_return is distinct from booking.id
    or not isfinite(returned.occurred_at) or returned.occurred_at>=completed_at
    or block.starts_at<returned.occurred_at or block.starts_at>=completed_at
    or (not block.active and block.reason<>'CONFLICTO de limpieza tras devolución tardía; requiere reprogramación') then
    raise exception 'RETURN_CLEANING_NOT_REVIEWABLE';
  end if;

  -- Review an actual completed cleaning, never activate an interval over another commitment.
  -- The prefix distinguishes successful proof from the generated return-conflict reason.
  update public.vehicle_commitments set ends_at=completed_at,active=false,
    reason='Revisión de limpieza confirmada: '||btrim(payload->>'reason')
    where id=block.id returning * into block;
  release_blocked:=exists(select 1 from public.work_orders where vehicle_id=car.id and status<>'Entregado')
    or exists(select 1 from public.reservations where vehicle_id=car.id and rental_state='Entregado')
    or exists(select 1 from public.vehicle_commitments where vehicle_id=car.id and id<>block.id and active
      and starts_at<=completed_at and ends_at>completed_at);
  if not release_blocked and (car.status<>'Disponible' or car.readiness_hold) then
    update public.vehicles set status='Disponible',readiness_hold=false,version=version+1
      where id=car.id returning * into car;
  end if;
  update public.reservations set version=version+1 where id=booking.id returning * into booking;
  result:=jsonb_build_object('reservation',to_jsonb(booking),'vehicle',to_jsonb(car),'cleaning',to_jsonb(block),
    'cleaningReviewed',true,'releaseBlocked',release_blocked);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end $$;


--
-- Name: execute_task_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_task_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  task public.workshop_tasks;
  prior private.command_results;
  request jsonb := jsonb_build_object('command','task.' || command,'payload',payload);
  result jsonb;
  assignee uuid;
  new_assignee_label text;
  new_responsible_name text;
begin
  if command not in ('create','assign','transition') or command is null or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_TASK_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  if command <> 'create' then
    select * into task from public.workshop_tasks where id = (payload->>'taskId')::uuid for update;
  end if;
  if not public.has_permission('orders.write') and not coalesce((
    command = 'transition' and public.has_task_access() and task.assigned_to = auth.uid()
  ),false) then raise exception using errcode = '42501', message = 'PERMISSION_DENIED'; end if;
  select * into prior from private.command_results where actor = auth.uid() and key = idempotency_key;
  if found then
    if prior.request <> request then raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  -- Transition authority must never become metadata-edit authority.
  if payload ? 'responsibleName' then
    if command = 'transition' then raise exception 'UNSUPPORTED_TASK_METADATA'; end if;
    if jsonb_typeof(payload->'responsibleName') not in ('string','null') then
      raise exception 'INVALID_RESPONSIBLE_NAME';
    end if;
    new_responsible_name := nullif(btrim(payload->>'responsibleName', E' \t\n\r\013\014'),'');
    if length(new_responsible_name) > 120 then raise exception 'INVALID_RESPONSIBLE_NAME'; end if;
  end if;
  if command <> 'create' and task.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  if not exists (select 1 from public.work_orders where id = coalesce(task.order_id,payload->>'orderId') and status <> 'Entregado') then
    raise exception 'ORDER_NOT_OPEN';
  end if;
  if command <> 'create' and (payload->>'expectedVersion')::integer is distinct from task.version then
    raise exception using errcode = '23505', message = 'VERSION_CONFLICT';
  end if;
  if command in ('create','assign') then
    assignee := (payload->>'assignedTo')::uuid;
    select coalesce(u.email,u.id::text) into new_assignee_label from auth.users u where u.id = assignee and exists (
      select 1 from public.user_roles r where r.user_id = u.id and r.role in ('owner','admin','reception','technician')
    );
    if new_assignee_label is null then raise exception 'INVALID_ASSIGNEE'; end if;
  end if;
  if command = 'create' then
    insert into public.workshop_tasks(order_id,description,assigned_to,assignee_label,created_by,responsible_name)
    values (payload->>'orderId',btrim(payload->>'description'),assignee,new_assignee_label,auth.uid(),new_responsible_name)
      returning * into task;
  elsif command = 'assign' then
    if task.status = 'Finalizada' then raise exception 'TASK_ALREADY_COMPLETED'; end if;
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'ASSIGNMENT_REASON_REQUIRED'; end if;
    update public.workshop_tasks set assigned_to = assignee,assignee_label = new_assignee_label,
      responsible_name = case when payload ? 'responsibleName' then new_responsible_name else task.responsible_name end,
      last_reason = btrim(payload->>'reason'),version = version + 1 where id = task.id returning * into task;
  else
    if not ((task.status = 'Pendiente' and payload->>'status' = 'En proceso')
      or (task.status = 'En proceso' and payload->>'status' = 'Finalizada')) then raise exception 'INVALID_TASK_TRANSITION'; end if;
    update public.workshop_tasks set status = payload->>'status',last_reason = 'State transition',version = version + 1
      where id = task.id returning * into task;
  end if;
  -- Do not change any sibling task, vehicle or work order status here.
  result := jsonb_build_object('id',task.id,'version',task.version,'status',task.status);
  -- Only new metadata requests need an acknowledgement; legacy result shape stays identical.
  if payload ? 'responsibleName' then result := result || '{"responsibleNameSupported":true}'::jsonb; end if;
  insert into private.command_results values (auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;


--
-- Name: execute_time_command(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_time_command(command text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','time.'||command,'payload',payload);
  task public.workshop_tasks;
  timer public.task_timers;
  span public.task_time_spans;
  server_time timestamptz;
  corrected_start timestamptz;
  corrected_end timestamptz;
  result jsonb;
begin
  if command is null or command not in ('start','pause','resume','finish','correct') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_TIME_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  server_time:=clock_timestamp();
  if command='start' then
    select * into task from public.workshop_tasks where id=(payload->>'taskId')::uuid;
  else
    if command='correct' then
      select * into span from public.task_time_spans where id=(payload->>'spanId')::uuid;
      select * into timer from public.task_timers where id=span.timer_id;
    else
      select * into timer from public.task_timers where id=(payload->>'timerId')::uuid;
    end if;
    select * into task from public.workshop_tasks where id=timer.task_id;
  end if;
  if task.id is null or not(public.has_permission('orders.write') or
    (public.has_task_access() and coalesce(timer.worker_id,task.assigned_to)=auth.uid())) then
    raise exception using errcode='42501',message='PERMISSION_DENIED';
  end if;
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if not exists(select 1 from public.work_orders where id=task.order_id and status<>'Entregado') then raise exception 'ORDER_NOT_OPEN'; end if;
  if command='start' then
    if task.assigned_to<>auth.uid() or task.status<>'En proceso' then raise exception 'TIME_REQUIRES_ASSIGNED_ACTIVE_TASK'; end if;
    if exists(select 1 from public.task_timers where (task_id=task.id and worker_id=auth.uid() and state<>'Finalizado')
      or (worker_id=auth.uid() and state='Activo')) then raise exception 'WORKER_HAS_OPEN_TIMER'; end if;
    insert into public.task_timers(task_id,worker_id,state,started_at,created_by)
    values(task.id,auth.uid(),'Activo',server_time,auth.uid()) returning * into timer;
    insert into public.task_time_spans(timer_id,started_at,reason,created_by,updated_by)
    values(timer.id,server_time,'Inicio de trabajo',auth.uid(),auth.uid());
  elsif command='correct' then
    if span.ended_at is null or timer.state<>'Finalizado' then raise exception 'ONLY_FINISHED_TIME_CAN_BE_CORRECTED'; end if;
    if (payload->>'expectedVersion')::integer is distinct from span.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'TIME_REASON_REQUIRED'; end if;
    corrected_start:=(payload->>'startedAt')::timestamptz;corrected_end:=(payload->>'endedAt')::timestamptz;
    if corrected_start is null or corrected_end is null or not isfinite(corrected_start) or not isfinite(corrected_end)
      or corrected_end<corrected_start or corrected_start<timer.started_at or corrected_end>timer.finished_at
      or corrected_end>server_time then raise exception 'INVALID_TIME_RANGE'; end if;
    if exists(select 1 from public.task_time_spans s join public.task_timers other_timer on other_timer.id=s.timer_id
      where other_timer.worker_id=timer.worker_id and s.id<>span.id
      and s.started_at<corrected_end and coalesce(s.ended_at,server_time)>corrected_start) then raise exception 'TIME_OVERLAP'; end if;
    update public.task_time_spans set started_at=corrected_start,ended_at=corrected_end,version=version+1,
      reason=btrim(payload->>'reason'),updated_by=auth.uid() where id=span.id returning * into span;
  else
    if (payload->>'expectedVersion')::integer is distinct from timer.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    if not((command='pause' and timer.state='Activo') or (command='resume' and timer.state='Pausado')
      or (command='finish' and timer.state in ('Activo','Pausado'))) then raise exception 'INVALID_TIMER_TRANSITION'; end if;
    if command='resume' then
      if task.status<>'En proceso' then raise exception 'TIME_REQUIRES_ASSIGNED_ACTIVE_TASK'; end if;
      if exists(select 1 from public.task_timers where worker_id=timer.worker_id and state='Activo') then raise exception 'WORKER_HAS_OPEN_TIMER'; end if;
      insert into public.task_time_spans(timer_id,started_at,reason,created_by,updated_by)
      values(timer.id,server_time,'Reanudación de trabajo',auth.uid(),auth.uid());
    else
      update public.task_time_spans set ended_at=server_time,updated_by=auth.uid(),version=version+1
      where timer_id=timer.id and ended_at is null;
    end if;
    update public.task_timers set state=case command when 'pause' then 'Pausado' when 'resume' then 'Activo' else 'Finalizado' end,
      finished_at=case when command='finish' then server_time else null end,version=version+1 where id=timer.id returning * into timer;
  end if;
  result:=jsonb_build_object('timer',to_jsonb(timer),'span',to_jsonb(span));
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;


--
-- Name: expense_import_original(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expense_import_original(batch_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  perform private.require_import_permission();
  return (select encode(content,'base64') from private.expense_import_files where import_id = batch_id);
end;
$$;


--
-- Name: has_permission(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_permission(permission text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.user_roles r where r.user_id = auth.uid() and (
      r.role = 'owner'
      or (r.role = 'admin' and permission in ('customers.read','customers.write','customers.merge',
        'vehicles.read','vehicles.write','orders.read','orders.write','expenses.read','expenses.write'))
      or (r.role = 'reception' and permission in ('customers.read','customers.write',
        'vehicles.read','vehicles.write','orders.read','orders.write'))
      or (r.role = 'accountant' and permission in ('expenses.read'))
    )
  );
$$;


--
-- Name: has_task_access(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_task_access() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select public.has_permission('orders.write') or exists (
    select 1 from public.user_roles where user_id = auth.uid() and role = 'technician'
  );
$$;


--
-- Name: issue_grouped_document(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.issue_grouped_document(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: issue_rental_extra(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.issue_rental_extra(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','rental.issue_extra','payload',payload);
  proposal public.rental_extra_proposals;
  booking public.reservations;
  customer public.customers;
  document public.billing_documents;
  value numeric;
  event_date date;
  due_date date;
  result jsonb;
begin
  -- Issuing an amount to collect is an expense decision on an order of a rental: both permissions.
  if not (public.has_permission('orders.write') and public.has_permission('expenses.write')) then
    raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  select * into proposal from public.rental_extra_proposals where id=(payload->>'proposalId')::uuid for update;
  if proposal.id is null then raise exception 'EXTRA_NOT_FOUND'; end if;
  if proposal.status<>'Aprobado' then raise exception 'EXTRA_NOT_APPROVED'; end if;
  -- The marker is written at insert time: an extra can be issued only once. This guard comes before
  -- the version, because an extra that was already issued says so whatever the version is.
  if proposal.document_id is not null or exists(
    select 1 from public.billing_documents d where d.source_key='rental-extra:'||proposal.id::text) then
    raise exception 'EXTRA_ALREADY_ISSUED'; end if;
  if (payload->>'expectedVersion')::integer is distinct from proposal.version then
    raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
  if proposal.amount is null then raise exception 'EXTRA_AMOUNT_REQUIRED'; end if;
  select * into booking from public.reservations where id=proposal.reservation_id for update;
  if booking.id is null then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if booking.status='Cancelada' then raise exception 'RENTAL_CANCELLED'; end if;
  if booking.status<>'Confirmada' then raise exception 'CONFIRMED_RESERVATION_REQUIRED'; end if;
  -- The amount is the one the approval decided, never one the client sends.
  value:=proposal.amount;
  if value is null or value<=0 or value<>round(value,2) or value::text in ('NaN','Infinity') then
    raise exception 'INVALID_BILLING_AMOUNT_DATE'; end if;
  begin
    event_date:=(payload->>'date')::date;
  exception when others then
    raise exception 'INVALID_BILLING_AMOUNT_DATE';
  end;
  begin
    due_date:=(payload->>'dueOn')::date;
  exception when others then
    raise exception 'INVALID_BILLING_AMOUNT_DATE';
  end;
  if event_date is null or not isfinite(event_date) or event_date>(now() at time zone 'America/El_Salvador')::date
    or due_date is null or not isfinite(due_date) or due_date<event_date then raise exception 'INVALID_BILLING_AMOUNT_DATE'; end if;
  if nullif(btrim(payload->>'reason'),'') is null then raise exception 'EXTRA_REASON_REQUIRED'; end if;
  select * into customer from public.customers where id=private.canonical_customer(booking.customer_id);
  if customer.id is null then raise exception 'INVALID_CUSTOMER'; end if;
  -- The document is inserted directly: the billing command cannot write the source_key and the
  -- billing documents are immutable.
  insert into public.billing_documents(customer_id,reservation_id,description,amount,issued_on,due_on,source_key,
    customer_snapshot,created_by)
  values(customer.id,booking.id,'Extra de inspección: '||btrim(proposal.description),value,event_date,due_date,
    'rental-extra:'||proposal.id::text,to_jsonb(customer)-'phone_key'-'document_key',auth.uid()) returning * into document;
  update public.rental_extra_proposals set document_id=document.id,issued_on=event_date,due_on=due_date,version=version+1
    where id=proposal.id returning * into proposal;
  result:=jsonb_build_object('proposal',to_jsonb(proposal),'document',to_jsonb(document));
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;


--
-- Name: link_workshop_expense(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.link_workshop_expense(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: pay_direct_purchase(uuid, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pay_direct_purchase(cost_id uuid, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare cost public.workshop_costs;prior private.command_results;result jsonb;paid_on date;value numeric;
  request jsonb:=jsonb_build_object('command','cost.pay','costId',cost_id,'payload',payload);
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  select * into cost from public.workshop_costs where id=cost_id for update;
  if cost.id is null or cost.kind<>'Compra directa' then raise exception 'DIRECT_PURCHASE_REQUIRED';end if;
  paid_on:=(payload->>'date')::date;value:=(payload->>'amount')::numeric;
  if paid_on is null or not isfinite(paid_on) or paid_on<cost.occurred_at
    or paid_on>(now() at time zone 'America/El_Salvador')::date then raise exception 'INVALID_DATE';end if;
  if value is null or value<=0 or value<>round(value,2) or value::text in ('NaN','Infinity','-Infinity') then raise exception 'INVALID_AMOUNT';end if;
  insert into public.expenses(date,concept,category,amount,method,account,operation_id,support,disposition,direct_purchase_cost_id,created_by)
  values(paid_on,left('Pago de compra: '||cost.description,2000),'Pago a proveedor',value,payload->>'method',btrim(payload->>'account'),
    cost.order_id,cost.source_reference,cost.disposition,cost.id,auth.uid()) returning to_jsonb(expenses.*) into result;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;


--
-- Name: payment_import_original(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payment_import_original(batch_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return(select encode(content,'base64') from private.payment_import_files where import_id=batch_id);
end;
$$;


--
-- Name: propose_agent_expense(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.propose_agent_expense(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','agent.propose-expense','payload',payload);
  normalized jsonb;mapping jsonb;proposal public.agent_expense_proposals;result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  select jsonb_object_agg(key,key) into mapping from jsonb_object_keys(payload) key;
  normalized:=private.normalize_import_expense(jsonb_build_object('cells',payload),mapping);
  insert into public.agent_expense_proposals(actor,payload,payload_hash,expires_at)
  values(auth.uid(),normalized,encode(sha256(convert_to(normalized::text,'UTF8')),'hex'),clock_timestamp()+interval '15 minutes') returning * into proposal;
  result:=to_jsonb(proposal);insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;


--
-- Name: receivables_at(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.receivables_at(cutoff date) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: receive_workshop_vehicle(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.receive_workshop_vehicle(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: record_cash_entry(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_cash_entry(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','cash.entry','payload',payload);result jsonb;value numeric;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if payload->>'kind'='Apertura' and not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception 'OPENING_REQUIRES_MANAGEMENT';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  value:=(payload->>'amount')::numeric;
  if value is null or value<>round(value,2) or (payload->>'date')::date>(now() at time zone 'America/El_Salvador')::date then raise exception 'INVALID_AMOUNT_DATE';end if;
  insert into public.cash_entries(kind,date,account,counter_account,amount,concept,reason,created_by)
  values(payload->>'kind',(payload->>'date')::date,btrim(payload->>'account'),nullif(btrim(payload->>'counterAccount'),''),value,
    btrim(payload->>'concept'),btrim(payload->>'reason'),auth.uid()) returning to_jsonb(cash_entries.*) into result;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;


--
-- Name: record_connected_quote(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_connected_quote(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: record_linked_expense(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_linked_expense(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: record_linked_receipt(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_linked_receipt(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: rental_alternatives(timestamp with time zone, timestamp with time zone, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rental_alternatives(starts_at timestamp with time zone, ends_at timestamp with time zone, exclude_reservation uuid DEFAULT NULL::uuid) RETURNS TABLE(id uuid, plate text, category text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('vehicles.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if starts_at is null or ends_at is null or not isfinite(starts_at) or ends_at<=starts_at or ends_at='-infinity'::timestamptz then raise exception 'INVALID_RENTAL_INTERVAL';end if;
  return query select v.id,v.plate,v.category from public.vehicles v where v.in_rental_fleet and not v.readiness_hold
    and not exists(select 1 from public.vehicle_commitments c where c.vehicle_id=v.id and c.active
      and (exclude_reservation is null or c.reservation_id is distinct from exclude_reservation)
      and tstzrange(c.starts_at,c.ends_at,'[)')&&tstzrange(rental_alternatives.starts_at,rental_alternatives.ends_at,'[)'))
    and not(v.status<>'Disponible' and rental_alternatives.starts_at<=now() and not exists(
      select 1 from public.reservations r where r.id=exclude_reservation and r.vehicle_id=v.id and r.rental_state='Entregado')) order by v.plate;
end $$;


--
-- Name: rental_case_file(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rental_case_file(reservation_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare result jsonb;begin
  result:=private.rental_case_file_before_connected_money(reservation_id);
  if public.has_permission('expenses.read') then result:=result||jsonb_build_object('advances',coalesce((
    select jsonb_agg(to_jsonb(p)||jsonb_build_object('available_amount',private.receipt_available(p.id)))
    from public.receipt_operation_contexts c join public.customer_payments p on p.id=c.payment_id
    where c.reservation_id=rental_case_file.reservation_id and private.receipt_available(p.id)>0),'[]'));end if;
  return jsonb_set(result,'{reservations}',private.rental_actual_dates(result->'reservations'));
end $$;


--
-- Name: rental_paid_through(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rental_paid_through(reservation_id uuid) RETURNS date
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: reservation_payment_status(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reservation_payment_status(reservation_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare total numeric;balance numeric;begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  select sum(s.amount),sum(s.balance) into total,balance from (
    select d.amount,private.document_balance(d.id,'infinity'::date) balance from public.billing_documents d where d.reservation_id=reservation_payment_status.reservation_id
    union all select l.amount,private.document_line_balance(l.id) from public.billing_document_lines l where l.reservation_id=reservation_payment_status.reservation_id
  ) s;
  return case when total is null then 'Sin cargos' when balance<=0 then 'Pagado' when balance<total then 'Parcial' else 'Pendiente' end;
end $$;


--
-- Name: reservation_payment_summary(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reservation_payment_summary() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  return coalesce((select jsonb_object_agg(r.id,public.reservation_payment_status(r.id)) from public.reservations r),'{}');
end;
$$;


--
-- Name: review_source_item(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.review_source_item(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','source.review','payload',payload);
  item public.source_workbook_items;result jsonb;entity jsonb;proposed_record jsonb:=payload->'proposal';
  action text:=payload->>'action';kind text:=payload->>'recordType';target text;exists_target boolean;table_name text;amount numeric;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' or action not in ('exclude','link','publish','reopen')
    or nullif(btrim(payload->>'reason'),'') is null then raise exception 'SOURCE_REVIEW_REASON_REQUIRED';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  select * into item from public.source_workbook_items where id=(payload->>'itemId')::uuid for update;
  if item.id is null then raise exception 'SOURCE_ITEM_NOT_FOUND';end if;
  if item.status in ('Vinculado','Publicado') then
    if item.proposal is not distinct from proposed_record and item.record_type is not distinct from kind and action='publish' then return to_jsonb(item);end if;
    raise exception 'SOURCE_ALREADY_RESOLVED';
  end if;
  if item.version is distinct from (payload->>'expectedVersion')::integer then raise exception 'VERSION_CONFLICT';end if;
  if action='reopen' and item.status='Excluido' then
    update public.source_workbook_items set status='Pendiente',version=version+1,reason=btrim(payload->>'reason'),reviewed_by=auth.uid(),reviewed_at=now()
      where id=item.id returning to_jsonb(source_workbook_items.*) into result;
  elsif action='exclude' then
    update public.source_workbook_items set status='Excluido',version=version+1,reason=btrim(payload->>'reason'),reviewed_by=auth.uid(),reviewed_at=now()
      where id=item.id returning to_jsonb(source_workbook_items.*) into result;
  else
    table_name:=case kind when 'expense' then 'expenses' when 'receipt' then 'customer_payments' when 'vehicle' then 'vehicles'
      when 'reservation' then 'reservations' when 'order' then 'work_orders' when 'quote' then 'estimate_versions' when 'document' then 'billing_documents' end;
    if table_name is null then raise exception 'INVALID_SOURCE_RECORD_TYPE';end if;
    if action='link' then
      target:=payload->>'recordId';
      execute format('select exists(select 1 from public.%I where id::text=$1)',table_name) into exists_target using target;
      if not exists_target then raise exception 'SOURCE_LINK_NOT_FOUND';end if;
    elsif action='publish' then
      if item.status<>'Pendiente' or item.metadata->>'category'='Control' or jsonb_typeof(proposed_record) is distinct from 'object' then raise exception 'SOURCE_NOT_PUBLISHABLE';end if;
      if jsonb_array_length(public.source_duplicate_candidates(kind,proposed_record))>0 and coalesce((payload->>'distinctConfirmed')::boolean,false) is not true then raise exception 'SOURCE_SIMILAR_RECORDS_REQUIRE_REVIEW';end if;
      if kind='expense' then entity:=public.execute_command('record_expense',proposed_record,gen_random_uuid());
      elsif kind='receipt' then entity:=public.execute_billing_command('pay',proposed_record,gen_random_uuid());
      elsif kind='vehicle' then entity:=public.execute_command('create_vehicle',proposed_record,gen_random_uuid());
      elsif kind='reservation' then entity:=public.execute_reservation_command('create',proposed_record,gen_random_uuid());
      elsif kind='quote' then entity:=public.execute_case_command('quote',proposed_record,gen_random_uuid());
      elsif kind='document' then
        if coalesce((proposed_record->>'grouped')::boolean,false) then entity:=public.issue_grouped_document(proposed_record,gen_random_uuid());
        else entity:=public.execute_billing_command('issue',proposed_record,gen_random_uuid());end if;
      else raise exception 'SOURCE_CREATE_IN_OPERATION_REQUIRED';end if;
      target:=entity->>'id';
      amount:=case kind when 'quote' then (entity->'snapshot'->>'total')::numeric
        when 'expense' then (proposed_record->>'amount')::numeric when 'receipt' then (entity->>'amount')::numeric
        when 'document' then (entity->>'amount')::numeric else null end;
      if kind in ('expense','receipt','quote','document') and amount is distinct from (payload->>'expectedAmount')::numeric then raise exception 'SOURCE_RECONCILIATION_MISMATCH';end if;
    else raise exception 'INVALID_SOURCE_REVIEW_ACTION';end if;
    update public.source_workbook_items set status=case when action='link' then 'Vinculado' else 'Publicado' end,record_type=kind,record_id=target,
      proposal=proposed_record,version=version+1,reason=btrim(payload->>'reason'),reviewed_by=auth.uid(),reviewed_at=now()
      where id=item.id returning to_jsonb(source_workbook_items.*) into result;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $_$;


--
-- Name: save_customer_document(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_customer_document(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb;bytes bytea;file public.customer_documents;mime text:=payload->>'mime';
begin
  if not public.has_permission('customers.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' or length(payload->>'base64')>2800000
    then raise exception 'INVALID_CUSTOMER_DOCUMENT';end if;
  bytes:=decode(payload->>'base64','base64');
  if bytes is null or octet_length(bytes) not between 1 and 2097152 or not coalesce((
    (mime='image/png' and substring(bytes from 1 for 8)=decode('89504e470d0a1a0a','hex')) or
    (mime='image/jpeg' and substring(bytes from 1 for 3)=decode('ffd8ff','hex')) or
    (mime='image/webp' and substring(bytes from 1 for 4)=convert_to('RIFF','UTF8') and substring(bytes from 9 for 4)=convert_to('WEBP','UTF8'))),false)
    then raise exception 'INVALID_CUSTOMER_DOCUMENT';end if;
  -- Do not copy identity image bytes into the command log or the audit trail.
  request:=jsonb_build_object('command','customer.document','customerId',payload->>'customerId',
    'kind',payload->>'kind','name',btrim(payload->>'name'),'mime',mime,'hash',encode(sha256(bytes),'hex'));
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if not exists(select 1 from public.customers where id=(payload->>'customerId')::uuid and merged_into is null) then raise exception 'INVALID_CUSTOMER';end if;
  insert into public.customer_documents(customer_id,kind,name,mime,size,file_hash,created_by)
  values((payload->>'customerId')::uuid,payload->>'kind',btrim(payload->>'name'),mime,octet_length(bytes),request->>'hash',auth.uid()) returning * into file;
  insert into private.customer_document_bytes values(file.id,bytes);
  insert into private.command_results values(auth.uid(),idempotency_key,request,to_jsonb(file));return to_jsonb(file);
end $$;


--
-- Name: save_registry_details(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_registry_details(kind text, payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
    if exists(select 1 from public.customer_matches(coalesce(payload->>'phone',''),coalesce(payload->>'document','')) candidate
      where candidate.id<>customer.id)
      then raise exception 'CUSTOMER_MATCH_EXISTS';end if;
    update public.customers set name=btrim(payload->>'name'),phone=btrim(coalesce(payload->>'phone','')),
      type=coalesce(payload->>'type',type),email=btrim(coalesce(payload->>'email','')),document=btrim(coalesce(payload->>'document','')),version=version+1
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
      if state='Disponible' and nullif(payload->>'km','') is null and 'km'=any(car.unverified_fields) and not car.in_rental_fleet
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


--
-- Name: save_vehicle_file(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_vehicle_file(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: save_workshop_quote(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_workshop_quote(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: source_duplicate_candidates(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.source_duplicate_candidates(record_type text, proposal jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if record_type='expense' then return coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'concept',e.concept,'amount',e.amount,'date',e.date)) from public.expenses e
    where e.date=(proposal->>'date')::date and e.amount=(proposal->>'amount')::numeric),'[]');
  elsif record_type='receipt' then return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'concept',p.reference,'amount',p.amount,'date',p.paid_on)) from public.customer_payments p
    where p.paid_on=(proposal->>'date')::date and p.amount=(proposal->>'amount')::numeric),'[]');
  else return '[]';end if;
end $$;


--
-- Name: source_workbook_bundle(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.source_workbook_bundle(workbook_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return jsonb_build_object('book',(select to_jsonb(b) from public.source_workbooks b where b.id=workbook_id),
    'items',coalesce((select jsonb_agg(to_jsonb(i) order by (i.metadata->>'row')::integer,i.source_ref) from public.source_workbook_items i where i.workbook_id=source_workbook_bundle.workbook_id),'[]'));
end $$;


--
-- Name: source_workbook_original(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.source_workbook_original(workbook_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return (select jsonb_build_object('fileName',b.file_name,'hash',b.file_hash,'base64',encode(f.content,'base64')) from public.source_workbooks b
    join private.source_workbook_bytes f on f.workbook_id=b.id where b.id=source_workbook_original.workbook_id);
end $$;


--
-- Name: stage_expense_import(text, text, text, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stage_expense_import(file_name text, file_base64 text, sheet_name text, columns jsonb, rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  original bytea;
  hash text;
  batch public.expense_imports;
begin
  perform private.require_import_permission();
  if length(file_base64) > 7000000 or file_name !~* '\.(xlsx|csv)$' or length(file_name) > 255
    or length(sheet_name) not between 1 and 120 or jsonb_typeof(columns) is distinct from 'array'
    or jsonb_typeof(rows) is distinct from 'array' then raise exception 'INVALID_IMPORT'; end if;
  original := decode(file_base64,'base64');
  if octet_length(original) not between 1 and 5242880 or jsonb_array_length(rows) not between 1 and 500
    or jsonb_array_length(columns) not between 1 and 50 or length(rows::text) > 6000000 then raise exception 'IMPORT_LIMIT_EXCEEDED'; end if;
  hash := encode(sha256(original),'hex');
  perform pg_advisory_xact_lock(6192,1);
  select * into batch from public.expense_imports i where i.file_hash = hash and i.sheet_name = stage_expense_import.sheet_name;
  if found then return to_jsonb(batch); end if;
  insert into public.expense_imports(file_name,file_hash,sheet_name,columns,created_by)
  values (file_name,hash,sheet_name,columns,auth.uid()) returning * into batch;
  insert into private.expense_import_files values (batch.id,original);
  insert into public.expense_import_rows(import_id,row_number,raw_data)
  select batch.id,(value->>'rowNumber')::integer,value from jsonb_array_elements(rows);
  return to_jsonb(batch);
end;
$_$;


--
-- Name: stage_source_workbook(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stage_source_workbook(payload jsonb, idempotency_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare prior private.command_results;request jsonb;bytes bytea;hash text;book public.source_workbooks;item jsonb;result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' or length(payload->>'base64')>7000000
    or jsonb_typeof(payload->'sheets') is distinct from 'array' or jsonb_array_length(payload->'sheets') not between 1 and 20
    or jsonb_typeof(payload->'items') is distinct from 'array' or jsonb_array_length(payload->'items')>10000
    or length((payload-'base64')::text)>12000000 or lower(payload->>'fileName') not like '%.xlsx' then raise exception 'INVALID_SOURCE_WORKBOOK';end if;
  bytes:=decode(payload->>'base64','base64');hash:=encode(sha256(bytes),'hex');
  if bytes is null or octet_length(bytes) not between 1 and 5242880 or substring(bytes from 1 for 2)<>decode('504b','hex') then raise exception 'INVALID_SOURCE_WORKBOOK';end if;
  request:=jsonb_build_object('command','source.stage','hash',hash);
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  select * into book from public.source_workbooks where file_hash=hash;
  if book.id is null then
    insert into public.source_workbooks(file_name,file_hash,format,parser_version,preview,created_by)
    values(btrim(payload->>'fileName'),hash,payload->>'format',payload->>'parserVersion',jsonb_build_object('sheets',payload->'sheets'),auth.uid()) returning * into book;
    insert into private.source_workbook_bytes values(book.id,bytes);
    for item in select value from jsonb_array_elements(payload->'items') loop
      if nullif(item->>'sourceRef','') is null or length(item::text)>50000 then raise exception 'INVALID_SOURCE_REFERENCE';end if;
      insert into public.source_workbook_items(workbook_id,source_ref,metadata) values(book.id,item->>'sourceRef',item);
    end loop;
  end if;
  result:=to_jsonb(book)-'preview';insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;


--
-- Name: validate_expense_import(uuid, integer, jsonb, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_expense_import(batch_id uuid, expected_version integer, mapping jsonb, source_system text, decisions jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare batch public.expense_imports;
begin
  perform private.require_import_permission();
  perform pg_advisory_xact_lock(6192,1);
  select * into batch from public.expense_imports where id = batch_id for update;
  if batch.id is null or batch.status = 'committed' then raise exception 'IMPORT_NOT_EDITABLE'; end if;
  if expected_version is distinct from batch.version then raise exception 'VERSION_CONFLICT'; end if;
  if jsonb_typeof(mapping) is distinct from 'object' or jsonb_typeof(decisions) is distinct from 'object'
    or length(btrim(source_system)) not between 1 and 100 then raise exception 'INVALID_MAPPING'; end if;
  batch.mapping := mapping; batch.decisions := decisions; batch.source_system := btrim(source_system);
  perform private.validate_expense_import_rows(batch);
  update public.expense_imports set mapping = batch.mapping, decisions = batch.decisions,
    source_system = batch.source_system, status = 'validated',version = version + 1,
    summary = private.expense_import_summary(batch.id) where id = batch.id returning * into batch;
  return to_jsonb(batch);
end;
$$;


--
-- Name: vehicle_case_file(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vehicle_case_file(vehicle_id uuid, order_id text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare result jsonb;begin
  result:=private.vehicle_case_file_before_connected_money(vehicle_id,order_id);
  if not public.has_permission('expenses.read') then return jsonb_set(result,'{reservations}',private.rental_actual_dates(result->'reservations'));end if;
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
  return jsonb_set(result,'{reservations}',private.rental_actual_dates(result->'reservations'));
end $$;


--
-- Name: vehicle_contribution(uuid, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vehicle_contribution(vehicle_id uuid, from_date date, cutoff date) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: vehicle_file_content(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vehicle_file_content(file_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare file public.vehicle_files;begin
  select * into file from public.vehicle_files where id=file_id;
  if file.id is null or not public.has_permission('vehicles.read') or (file.financial and not public.has_permission('expenses.read')) then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return jsonb_build_object('mime',file.mime,'name',file.name,'base64',(select encode(content,'base64') from private.vehicle_file_bytes where vehicle_file_bytes.file_id=file.id));
end $$;


--
-- Name: workshop_assignees(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workshop_assignees() RETURNS TABLE(id uuid, label text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('orders.write') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  return query select u.id,coalesce(u.email::text,u.id::text) from auth.users u where exists (
    select 1 from public.user_roles r where r.user_id = u.id and r.role in ('owner','admin','reception','technician')
  ) order by u.email;
end;
$$;


--
-- Name: workshop_delivery_checklist(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workshop_delivery_checklist(order_id text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  return private.delivery_checklist(order_id);
end;
$$;


--
-- Name: workshop_expense_inbox(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workshop_expense_inbox() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return coalesce((select jsonb_agg(to_jsonb(e) order by e.date desc,e.id) from public.expenses e
    where e.cost_center_id='workshop' and e.operation_id is null and e.vehicle_id is null and e.reservation_id is null
    and e.direct_purchase_cost_id is null
    and not exists(select 1 from public.workshop_costs c where c.linked_expense_id=e.id or c.expense_id=e.id)),'[]');
end $$;


--
-- Name: command_results; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.command_results (
    actor uuid NOT NULL,
    key uuid NOT NULL,
    request jsonb NOT NULL,
    result jsonb NOT NULL
);


--
-- Name: contract_files; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.contract_files (
    contract_id uuid NOT NULL,
    content bytea NOT NULL,
    file_hash text NOT NULL
);


--
-- Name: customer_document_bytes; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.customer_document_bytes (
    file_id uuid NOT NULL,
    content bytea NOT NULL
);


--
-- Name: estimate_document_files; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.estimate_document_files (
    document_id uuid NOT NULL,
    content bytea NOT NULL
);


--
-- Name: expense_import_files; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.expense_import_files (
    import_id uuid NOT NULL,
    content bytea NOT NULL
);


--
-- Name: payment_import_files; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.payment_import_files (
    import_id uuid NOT NULL,
    content bytea NOT NULL
);


--
-- Name: source_workbook_bytes; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.source_workbook_bytes (
    workbook_id uuid NOT NULL,
    content bytea NOT NULL
);


--
-- Name: vehicle_file_bytes; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.vehicle_file_bytes (
    file_id uuid NOT NULL,
    content bytea NOT NULL
);


--
-- Name: agent_expense_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_expense_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor uuid NOT NULL,
    payload jsonb NOT NULL,
    payload_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor uuid,
    entity text NOT NULL,
    entity_id text NOT NULL,
    action text NOT NULL,
    before_data jsonb,
    after_data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: billing_application_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_application_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    line_id uuid NOT NULL,
    amount numeric(14,2) NOT NULL,
    CONSTRAINT billing_application_lines_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text]))))
);


--
-- Name: billing_credit_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_credit_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    credit_id uuid NOT NULL,
    line_id uuid NOT NULL,
    amount numeric(14,2) NOT NULL,
    CONSTRAINT billing_credit_lines_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text]))))
);


--
-- Name: billing_credits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_credits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    amount numeric(14,2) NOT NULL,
    credited_on date NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT billing_credits_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT billing_credits_reason_check CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: billing_document_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_document_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    order_id text,
    reservation_id uuid,
    description text NOT NULL,
    gross numeric(14,2) NOT NULL,
    discount numeric(14,2) DEFAULT 0 NOT NULL,
    amount numeric(14,2) GENERATED ALWAYS AS ((gross - discount)) STORED,
    discount_reason text NOT NULL,
    starts_on date,
    ends_on date,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT billing_document_lines_check CHECK (((discount >= (0)::numeric) AND (discount < gross))),
    CONSTRAINT billing_document_lines_check1 CHECK ((num_nonnulls(order_id, reservation_id) = 1)),
    CONSTRAINT billing_document_lines_check2 CHECK (((discount = (0)::numeric) OR (length(btrim(discount_reason)) > 0))),
    CONSTRAINT billing_document_lines_check3 CHECK ((((gross)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])) AND ((discount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT billing_document_lines_check4 CHECK ((((starts_on IS NULL) AND (ends_on IS NULL)) OR ((starts_on IS NOT NULL) AND (ends_on IS NOT NULL) AND isfinite(starts_on) AND isfinite(ends_on) AND (ends_on >= starts_on)))),
    CONSTRAINT billing_document_lines_description_check CHECK ((length(btrim(description)) > 0)),
    CONSTRAINT billing_document_lines_gross_check CHECK ((gross > (0)::numeric))
);


--
-- Name: billing_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    order_id text,
    reservation_id uuid,
    description text NOT NULL,
    amount numeric(14,2) NOT NULL,
    issued_on date NOT NULL,
    due_on date NOT NULL,
    source_key text,
    customer_snapshot jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    commission_eligible boolean DEFAULT false NOT NULL,
    estimate_id uuid,
    grouped boolean DEFAULT false NOT NULL,
    external_reference text DEFAULT ''::text NOT NULL,
    folio_number bigint NOT NULL,
    CONSTRAINT billing_documents_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT billing_documents_check1 CHECK ((due_on >= issued_on)),
    CONSTRAINT billing_documents_description_check CHECK ((length(btrim(description)) > 0)),
    CONSTRAINT document_scope_fit CHECK (((grouped AND (num_nonnulls(order_id, reservation_id) = 0)) OR ((NOT grouped) AND (num_nonnulls(order_id, reservation_id) = 1))))
);


--
-- Name: billing_documents_folio_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.billing_documents ALTER COLUMN folio_number ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.billing_documents_folio_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: budget_expense_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_expense_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    budget_id uuid NOT NULL,
    expense_id text NOT NULL,
    purchase_id uuid,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT budget_expense_links_reason_check CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: budget_purchase_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_purchase_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    budget_id uuid NOT NULL,
    purchase_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cash_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    date date NOT NULL,
    account text NOT NULL,
    counter_account text,
    amount numeric(14,2) NOT NULL,
    concept text NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_entries_account_check CHECK ((length(btrim(account)) > 0)),
    CONSTRAINT cash_entries_amount_check CHECK (((amount >= (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT cash_entries_check CHECK (((kind = 'Apertura'::text) OR (amount > (0)::numeric))),
    CONSTRAINT cash_entries_check1 CHECK ((((kind = 'Transferencia'::text) AND (NULLIF(btrim(counter_account), ''::text) IS NOT NULL) AND (account <> counter_account)) OR ((kind <> 'Transferencia'::text) AND (counter_account IS NULL)))),
    CONSTRAINT cash_entries_concept_check CHECK (((length(btrim(concept)) >= 1) AND (length(btrim(concept)) <= 2000))),
    CONSTRAINT cash_entries_date_check CHECK (isfinite(date)),
    CONSTRAINT cash_entries_kind_check CHECK ((kind = ANY (ARRAY['Apertura'::text, 'Transferencia'::text, 'Ingreso no comercial'::text, 'Salida no operativa'::text]))),
    CONSTRAINT cash_entries_reason_check CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: commission_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: commission_eligibility; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_eligibility (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    eligible boolean NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_eligibility_reason_check CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: commission_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    seller_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    cutoff date NOT NULL,
    eligible_base numeric(18,2) NOT NULL,
    amount numeric(18,2) NOT NULL,
    rule_snapshot jsonb NOT NULL,
    basis_hash text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: commission_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    revision integer NOT NULL,
    rate numeric(9,6) NOT NULL,
    valid_from date NOT NULL,
    valid_until date NOT NULL,
    policy text DEFAULT 'net-applied-eligible-receipts-v1'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_rules_check CHECK ((valid_until >= valid_from)),
    CONSTRAINT commission_rules_rate_check CHECK ((((rate >= (0)::numeric) AND (rate <= (1)::numeric)) AND ((rate)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text]))))
);


--
-- Name: contract_acceptances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_acceptances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    accepted_by text NOT NULL,
    evidence text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_acceptances_accepted_by_check CHECK ((length(btrim(accepted_by)) > 0)),
    CONSTRAINT contract_acceptances_evidence_check CHECK ((length(btrim(evidence)) > 0))
);


--
-- Name: cost_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cost_id uuid NOT NULL,
    estimate_id uuid,
    line_index integer,
    description text NOT NULL,
    amount numeric(14,2) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cost_allocations_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT cost_allocations_description_check CHECK (((length(btrim(description)) >= 1) AND (length(btrim(description)) <= 2000))),
    CONSTRAINT cost_allocations_line_index_check CHECK ((line_index >= 0)),
    CONSTRAINT cost_allocations_reason_check CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: cost_centers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_centers (
    id text NOT NULL,
    name text NOT NULL
);


--
-- Name: customer_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_aliases (
    source_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    snapshot jsonb NOT NULL,
    phone_key text NOT NULL,
    document_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    mime text NOT NULL,
    size integer NOT NULL,
    file_hash text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT customer_documents_kind_check CHECK ((kind = ANY (ARRAY['DUI'::text, 'Licencia'::text]))),
    CONSTRAINT customer_documents_mime_check CHECK ((mime = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text]))),
    CONSTRAINT customer_documents_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))),
    CONSTRAINT customer_documents_size_check CHECK (((size >= 1) AND (size <= 2097152)))
);


--
-- Name: customer_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    amount numeric(14,2) NOT NULL,
    paid_on date NOT NULL,
    method text NOT NULL,
    account text NOT NULL,
    reference text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    folio_number bigint NOT NULL,
    CONSTRAINT customer_payments_account_check CHECK ((length(btrim(account)) > 0)),
    CONSTRAINT customer_payments_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT customer_payments_method_check CHECK ((method = ANY (ARRAY['Efectivo'::text, 'Transferencia'::text, 'Tarjeta'::text])))
);


--
-- Name: customer_payments_folio_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.customer_payments ALTER COLUMN folio_number ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.customer_payments_folio_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: estimate_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimate_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    estimate_id uuid NOT NULL,
    decision text NOT NULL,
    approver_name text NOT NULL,
    evidence text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT estimate_approvals_approver_name_check CHECK ((length(btrim(approver_name)) > 0)),
    CONSTRAINT estimate_approvals_decision_check CHECK ((decision = ANY (ARRAY['Aprobado'::text, 'Rechazado'::text]))),
    CONSTRAINT estimate_approvals_evidence_check CHECK ((length(btrim(evidence)) > 0))
);


--
-- Name: estimate_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimate_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    estimate_id uuid NOT NULL,
    status text NOT NULL,
    file_hash text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: estimate_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimate_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id text NOT NULL,
    revision integer NOT NULL,
    parent_id uuid,
    status text DEFAULT 'Borrador'::text NOT NULL,
    snapshot jsonb NOT NULL,
    customer_snapshot jsonb NOT NULL,
    vehicle_snapshot jsonb NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    folio_number bigint NOT NULL,
    source_reference text DEFAULT ''::text NOT NULL,
    source_totals jsonb,
    CONSTRAINT estimate_versions_status_check CHECK ((status = ANY (ARRAY['Borrador'::text, 'Aprobado'::text, 'Rechazado'::text])))
);


--
-- Name: estimate_versions_folio_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.estimate_versions ALTER COLUMN folio_number ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.estimate_versions_folio_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: expense_folio; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.expense_folio
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: expense_import_origins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_import_origins (
    source_system text NOT NULL,
    source_key text NOT NULL,
    fingerprint jsonb NOT NULL,
    expense_id text NOT NULL,
    import_id uuid NOT NULL
);


--
-- Name: expense_import_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_import_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    import_id uuid NOT NULL,
    row_number integer NOT NULL,
    raw_data jsonb NOT NULL,
    payload jsonb,
    fingerprint jsonb,
    source_key text,
    status text DEFAULT 'pending'::text NOT NULL,
    issue text DEFAULT ''::text NOT NULL,
    candidates text[] DEFAULT '{}'::text[] NOT NULL,
    expense_id text,
    command_key uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT expense_import_rows_row_number_check CHECK ((row_number > 0)),
    CONSTRAINT expense_import_rows_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'valid'::text, 'rejected'::text, 'duplicate'::text, 'ambiguous'::text, 'excluded'::text, 'published'::text])))
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id text DEFAULT ('EG-'::text || (nextval('public.expense_folio'::regclass))::text) NOT NULL,
    date date NOT NULL,
    concept text NOT NULL,
    category text NOT NULL,
    amount numeric(14,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    method text NOT NULL,
    account text NOT NULL,
    operation_id text,
    cost_center_id text,
    support text DEFAULT ''::text NOT NULL,
    disposition text DEFAULT 'Pendiente'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    direct_purchase_cost_id uuid,
    vehicle_id uuid,
    reservation_id uuid,
    CONSTRAINT expense_one_destination CHECK ((num_nonnulls(operation_id, cost_center_id, vehicle_id, reservation_id) = 1)),
    CONSTRAINT expenses_account_check CHECK ((length(btrim(account)) > 0)),
    CONSTRAINT expenses_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT expenses_category_check CHECK ((length(btrim(category)) > 0)),
    CONSTRAINT expenses_concept_check CHECK (((length(btrim(concept)) >= 1) AND (length(btrim(concept)) <= 2000))),
    CONSTRAINT expenses_currency_check CHECK ((currency = 'USD'::text)),
    CONSTRAINT expenses_method_check CHECK ((method = ANY (ARRAY['Efectivo'::text, 'Transferencia'::text, 'Tarjeta'::text])))
);


--
-- Name: integration_inbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_inbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    payload jsonb NOT NULL,
    payload_hash text NOT NULL,
    state text DEFAULT 'Pendiente'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    result jsonb,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_inbox_external_id_check CHECK ((length(btrim(external_id)) > 0)),
    CONSTRAINT integration_inbox_source_check CHECK ((length(btrim(source)) > 0)),
    CONSTRAINT integration_inbox_state_check CHECK ((state = ANY (ARRAY['Pendiente'::text, 'Error'::text, 'Procesado'::text])))
);


--
-- Name: operating_budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operating_budgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    area text NOT NULL,
    category text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    authorized numeric(18,2) NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operating_budgets_authorized_check CHECK (((authorized >= (0)::numeric) AND ((authorized)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT operating_budgets_check CHECK ((ends_on >= starts_on)),
    CONSTRAINT operating_budgets_name_check CHECK ((length(btrim(name)) > 0))
);


--
-- Name: payment_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payment_id uuid NOT NULL,
    document_id uuid NOT NULL,
    amount numeric(14,2) NOT NULL,
    kind text DEFAULT 'Aplicacion'::text NOT NULL,
    effective_on date NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_applications_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT payment_applications_kind_check CHECK ((kind = ANY (ARRAY['Aplicacion'::text, 'Reverso'::text])))
);


--
-- Name: payment_import_origins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_import_origins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_system text NOT NULL,
    source_key text NOT NULL,
    payment_id uuid NOT NULL,
    fingerprint jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_refunds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payment_id uuid NOT NULL,
    document_id uuid,
    amount numeric(14,2) NOT NULL,
    refunded_on date NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    refund_account text DEFAULT ''::text NOT NULL,
    CONSTRAINT payment_refunds_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT payment_refunds_reason_check CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    supplier text NOT NULL,
    quantity numeric(18,4) NOT NULL,
    unit_cost numeric(18,4) NOT NULL,
    status text DEFAULT 'Solicitada'::text NOT NULL,
    reason text NOT NULL,
    authorized_by uuid,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT purchase_orders_quantity_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT purchase_orders_reason_check CHECK ((length(btrim(reason)) > 0)),
    CONSTRAINT purchase_orders_status_check CHECK ((status = ANY (ARRAY['Solicitada'::text, 'Autorizada'::text, 'Recibida'::text]))),
    CONSTRAINT purchase_orders_supplier_check CHECK ((length(btrim(supplier)) > 0)),
    CONSTRAINT purchase_orders_unit_cost_check CHECK ((unit_cost > (0)::numeric))
);


--
-- Name: receipt_operation_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipt_operation_contexts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payment_id uuid NOT NULL,
    order_id text,
    reservation_id uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT receipt_operation_contexts_check CHECK ((num_nonnulls(order_id, reservation_id) = 1))
);


--
-- Name: rental_extra_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rental_extra_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    description text NOT NULL,
    comparison jsonb NOT NULL,
    amount numeric(14,2),
    status text DEFAULT 'Propuesto'::text NOT NULL,
    reason text DEFAULT 'Diferencia detectada en inspección'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    document_id uuid,
    issued_on date,
    due_on date,
    CONSTRAINT rental_extra_proposals_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT rental_extra_proposals_status_check CHECK ((status = ANY (ARRAY['Propuesto'::text, 'Aprobado'::text, 'Rechazado'::text])))
);


--
-- Name: rental_inspections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rental_inspections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    kind text NOT NULL,
    km integer,
    fuel numeric(5,2),
    condition text NOT NULL,
    accessories text NOT NULL,
    evidence text NOT NULL,
    created_by uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT rental_inspections_condition_check CHECK ((length(btrim(condition)) > 0)),
    CONSTRAINT rental_inspections_evidence_check CHECK ((length(btrim(evidence)) > 0)),
    CONSTRAINT rental_inspections_fuel_check CHECK ((((fuel >= (0)::numeric) AND (fuel <= (100)::numeric)) AND ((fuel)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT rental_inspections_kind_check CHECK ((kind = ANY (ARRAY['Salida'::text, 'Retorno'::text]))),
    CONSTRAINT rental_inspections_km_check CHECK ((km >= 0))
);


--
-- Name: rental_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rental_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    document_id uuid NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    document_line_id uuid,
    CONSTRAINT rental_periods_check CHECK ((isfinite(starts_on) AND isfinite(ends_on) AND (ends_on >= starts_on))),
    CONSTRAINT rental_periods_reason_check CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: report_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schedule_id uuid NOT NULL,
    cutoff date NOT NULL,
    recipient_id uuid NOT NULL,
    recipient_email text NOT NULL,
    filters jsonb NOT NULL,
    snapshot jsonb NOT NULL,
    state text DEFAULT 'Pendiente'::text NOT NULL,
    message_id text,
    delivery_detail text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT report_outbox_state_check CHECK ((state = ANY (ARRAY['Pendiente'::text, 'Enviando'::text, 'Enviado'::text, 'Error'::text, 'Incierto'::text])))
);


--
-- Name: report_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_id uuid NOT NULL,
    vehicle_id uuid NOT NULL,
    from_date date NOT NULL,
    next_on date NOT NULL,
    every_days integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT report_schedules_check CHECK ((isfinite(from_date) AND isfinite(next_on) AND (next_on >= from_date))),
    CONSTRAINT report_schedules_every_days_check CHECK (((every_days >= 1) AND (every_days <= 366)))
);


--
-- Name: reservation_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservation_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    channel text DEFAULT 'WhatsApp'::text NOT NULL,
    body text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reservation_evidence_body_check CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 20000)))
);


--
-- Name: reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    vehicle_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    daily_rate numeric(14,2) NOT NULL,
    total numeric(14,2) NOT NULL,
    cleaning_minutes integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'Borrador'::text NOT NULL,
    rental_state text DEFAULT 'Preparado'::text NOT NULL,
    seller_id uuid NOT NULL,
    customer_snapshot jsonb NOT NULL,
    vehicle_snapshot jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    open_ended boolean DEFAULT false NOT NULL,
    folio_number bigint NOT NULL,
    CONSTRAINT rental_interval_fit CHECK ((isfinite(starts_at) AND (ends_at > starts_at) AND ((open_ended AND (ends_at = 'infinity'::timestamp with time zone)) OR ((NOT open_ended) AND isfinite(ends_at))))),
    CONSTRAINT reservations_cleaning_minutes_check CHECK (((cleaning_minutes >= 0) AND (cleaning_minutes <= 10080))),
    CONSTRAINT reservations_daily_rate_check CHECK (((daily_rate >= (0)::numeric) AND ((daily_rate)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT reservations_rental_state_check CHECK ((rental_state = ANY (ARRAY['Preparado'::text, 'Entregado'::text, 'Devuelto'::text, 'Cerrado'::text]))),
    CONSTRAINT reservations_status_check CHECK ((status = ANY (ARRAY['Borrador'::text, 'Confirmada'::text, 'Cancelada'::text]))),
    CONSTRAINT reservations_total_check CHECK (((total >= (0)::numeric) AND ((total)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text]))))
);


--
-- Name: reservations_folio_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.reservations ALTER COLUMN folio_number ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.reservations_folio_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: source_workbook_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_workbook_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workbook_id uuid NOT NULL,
    source_ref text NOT NULL,
    metadata jsonb NOT NULL,
    status text DEFAULT 'Pendiente'::text NOT NULL,
    record_type text,
    record_id text,
    proposal jsonb,
    reason text DEFAULT ''::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    CONSTRAINT source_workbook_items_status_check CHECK ((status = ANY (ARRAY['Pendiente'::text, 'Excluido'::text, 'Vinculado'::text, 'Publicado'::text])))
);


--
-- Name: source_workbooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_workbooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_name text NOT NULL,
    file_hash text NOT NULL,
    format text NOT NULL,
    parser_version text NOT NULL,
    preview jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_workbooks_file_name_check CHECK (((length(btrim(file_name)) >= 1) AND (length(btrim(file_name)) <= 200))),
    CONSTRAINT source_workbooks_format_check CHECK ((format = ANY (ARRAY['diary'::text, 'budget'::text, 'fleet'::text, 'receivables'::text, 'unknown'::text])))
);


--
-- Name: stock_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku text NOT NULL,
    name text NOT NULL,
    unit text NOT NULL,
    quantity numeric(18,4) DEFAULT 0 NOT NULL,
    stock_value numeric(18,2) DEFAULT 0 NOT NULL,
    valuation_policy text DEFAULT 'moving-weighted-average-v1'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stock_items_name_check CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT stock_items_quantity_check CHECK ((quantity >= (0)::numeric)),
    CONSTRAINT stock_items_sku_check CHECK ((length(btrim(sku)) > 0)),
    CONSTRAINT stock_items_stock_value_check CHECK ((stock_value >= (0)::numeric)),
    CONSTRAINT stock_items_unit_check CHECK ((length(btrim(unit)) > 0))
);


--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    order_id text,
    purchase_id uuid,
    reverses_id uuid,
    kind text NOT NULL,
    quantity numeric(18,4) NOT NULL,
    unit_cost numeric(18,4) NOT NULL,
    amount numeric(18,2) NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stock_movements_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT stock_movements_check CHECK ((((kind = 'Consumo'::text) AND (order_id IS NOT NULL)) OR (kind <> 'Consumo'::text))),
    CONSTRAINT stock_movements_check1 CHECK (((kind = 'Devolucion'::text) = (reverses_id IS NOT NULL))),
    CONSTRAINT stock_movements_kind_check CHECK ((kind = ANY (ARRAY['Entrada'::text, 'Consumo'::text, 'Devolucion'::text]))),
    CONSTRAINT stock_movements_quantity_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT stock_movements_reason_check CHECK ((length(btrim(reason)) > 0)),
    CONSTRAINT stock_movements_unit_cost_check CHECK ((unit_cost >= (0)::numeric))
);


--
-- Name: supplier_obligations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_obligations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purchase_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    supplier text NOT NULL,
    amount numeric(18,2) NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT supplier_obligations_amount_check CHECK ((amount >= (0)::numeric))
);


--
-- Name: task_time_spans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_time_spans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    timer_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    active_seconds numeric GENERATED ALWAYS AS (EXTRACT(epoch FROM (ended_at - started_at))) STORED,
    version integer DEFAULT 1 NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    CONSTRAINT task_time_spans_check CHECK (((ended_at IS NULL) OR (ended_at >= started_at)))
);


--
-- Name: task_timers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_timers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    state text NOT NULL,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    finished_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT task_timers_check CHECK (((state = 'Finalizado'::text) = (finished_at IS NOT NULL))),
    CONSTRAINT task_timers_state_check CHECK ((state = ANY (ARRAY['Activo'::text, 'Pausado'::text, 'Finalizado'::text])))
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role text NOT NULL,
    CONSTRAINT user_roles_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'reception'::text, 'technician'::text, 'accountant'::text])))
);


--
-- Name: vehicle_commitments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_commitments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vehicle_id uuid NOT NULL,
    reservation_id uuid,
    order_id text,
    kind text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    active boolean DEFAULT true NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fleet_block_end CHECK ((isfinite(ends_at) OR ((kind = ANY (ARRAY['Reserva'::text, 'Taller'::text, 'Uso interno'::text, 'Préstamo'::text])) AND (ends_at = 'infinity'::timestamp with time zone)))),
    CONSTRAINT fleet_block_kind CHECK ((kind = ANY (ARRAY['Reserva'::text, 'Taller'::text, 'Limpieza'::text, 'Uso interno'::text, 'Préstamo'::text]))),
    CONSTRAINT vehicle_commitments_check CHECK ((isfinite(starts_at) AND (ends_at > starts_at)))
);


--
-- Name: vehicle_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vehicle_id uuid NOT NULL,
    order_id text,
    reservation_id uuid,
    name text NOT NULL,
    mime text NOT NULL,
    purpose text NOT NULL,
    financial boolean DEFAULT false NOT NULL,
    file_hash text NOT NULL,
    size integer NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vehicle_files_check CHECK ((num_nonnulls(order_id, reservation_id) <= 1)),
    CONSTRAINT vehicle_files_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))),
    CONSTRAINT vehicle_files_purpose_check CHECK ((purpose = ANY (ARRAY['Vehículo'::text, 'Ingreso'::text, 'Salida'::text, 'Soporte'::text]))),
    CONSTRAINT vehicle_files_size_check CHECK (((size >= 1) AND (size <= 2097152)))
);


--
-- Name: vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plate text NOT NULL,
    plate_key text GENERATED ALWAYS AS (upper(regexp_replace(plate, '[^a-zA-Z0-9]'::text, ''::text, 'g'::text))) STORED,
    vin text,
    brand text NOT NULL,
    model text NOT NULL,
    year integer NOT NULL,
    category text NOT NULL,
    color text NOT NULL,
    daily numeric(14,2) DEFAULT 0 NOT NULL,
    km integer DEFAULT 0 NOT NULL,
    ownership text NOT NULL,
    owner_customer_id uuid,
    status text DEFAULT 'Disponible'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    readiness_hold boolean DEFAULT false NOT NULL,
    in_rental_fleet boolean DEFAULT false NOT NULL,
    registered_holder text DEFAULT ''::text NOT NULL,
    commercial_line text DEFAULT ''::text NOT NULL,
    unverified_fields text[] DEFAULT '{}'::text[] NOT NULL,
    source_workbook_id uuid,
    source_ref text,
    CONSTRAINT vehicles_brand_check CHECK ((length(btrim(brand)) > 0)),
    CONSTRAINT vehicles_check CHECK ((((ownership = ANY (ARRAY['Propio'::text, 'Por confirmar'::text])) AND (owner_customer_id IS NULL)) OR ((ownership = 'Cliente'::text) AND (owner_customer_id IS NOT NULL)))),
    CONSTRAINT vehicles_daily_check CHECK (((daily >= (0)::numeric) AND ((daily)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT vehicles_km_check CHECK ((km >= 0)),
    CONSTRAINT vehicles_model_check CHECK ((length(btrim(model)) > 0)),
    CONSTRAINT vehicles_ownership_check CHECK ((ownership = ANY (ARRAY['Propio'::text, 'Cliente'::text, 'Por confirmar'::text]))),
    CONSTRAINT vehicles_status_check CHECK ((status = ANY (ARRAY['Disponible'::text, 'Alquilado'::text, 'En taller'::text, 'Por confirmar'::text]))),
    CONSTRAINT vehicles_year_check CHECK (((year >= 1900) AND (year <= 2100)))
);


--
-- Name: work_order_folio; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.work_order_folio
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: work_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_orders (
    id text DEFAULT ('OT-'::text || (nextval('public.work_order_folio'::regclass))::text) NOT NULL,
    vehicle_id uuid NOT NULL,
    customer_id uuid,
    area text NOT NULL,
    service text NOT NULL,
    technician text DEFAULT 'Sin asignar'::text NOT NULL,
    status text DEFAULT 'Diagnóstico'::text NOT NULL,
    hours numeric(10,2) DEFAULT 0 NOT NULL,
    estimate numeric(14,2) DEFAULT 0 NOT NULL,
    paid numeric(14,2) DEFAULT 0 NOT NULL,
    due date NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    pending_fields text[] DEFAULT ARRAY['kilometraje'::text, 'condición'::text, 'accesorios'::text, 'fotos'::text] NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    active_estimate_id uuid,
    internal_job boolean DEFAULT false NOT NULL,
    CONSTRAINT case_customer_required CHECK ((internal_job OR (customer_id IS NOT NULL))),
    CONSTRAINT work_orders_area_check CHECK ((area = ANY (ARRAY['Mecánica'::text, 'Pintura'::text]))),
    CONSTRAINT work_orders_service_check CHECK (((length(btrim(service)) >= 1) AND (length(btrim(service)) <= 2000)))
);


--
-- Name: workshop_costs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workshop_costs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id text NOT NULL,
    kind text NOT NULL,
    description text NOT NULL,
    quantity numeric(14,4) NOT NULL,
    unit_cost numeric(18,4) NOT NULL,
    amount numeric(14,2) NOT NULL,
    expense_id text,
    supplier text DEFAULT ''::text NOT NULL,
    source_reference text DEFAULT ''::text NOT NULL,
    disposition text DEFAULT 'Pendiente'::text NOT NULL,
    estimate_id uuid,
    version integer DEFAULT 1 NOT NULL,
    reason text DEFAULT 'Registro inicial'::text NOT NULL,
    occurred_at date NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stock_dispatch_id uuid,
    linked_expense_id text,
    CONSTRAINT cost_amount CHECK (((amount >= (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])) AND ((kind = 'Consumo'::text) OR (amount > (0)::numeric)))),
    CONSTRAINT cost_kind CHECK ((kind = ANY (ARRAY['Gasto'::text, 'Compra directa'::text, 'Consumo'::text, 'Gasto vinculado'::text]))),
    CONSTRAINT cost_quantity CHECK (((quantity >= (0)::numeric) AND ((quantity)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])) AND ((kind = 'Consumo'::text) OR (quantity > (0)::numeric)))),
    CONSTRAINT cost_source CHECK ((((kind = 'Gasto'::text) AND (expense_id IS NOT NULL)) OR ((kind <> 'Gasto'::text) AND (expense_id IS NULL)))),
    CONSTRAINT direct_purchase_source CHECK (((kind <> 'Compra directa'::text) OR ((length(btrim(supplier)) > 0) AND (length(btrim(source_reference)) > 0)))),
    CONSTRAINT linked_cash_cost_source CHECK (((kind = 'Gasto vinculado'::text) = (linked_expense_id IS NOT NULL))),
    CONSTRAINT stock_cost_source CHECK (((kind = 'Consumo'::text) = (stock_dispatch_id IS NOT NULL))),
    CONSTRAINT workshop_costs_description_check CHECK (((length(btrim(description)) >= 1) AND (length(btrim(description)) <= 2000))),
    CONSTRAINT workshop_costs_disposition_check CHECK ((disposition = ANY (ARRAY['Pendiente'::text, 'Incluido'::text, 'Adicional autorizado'::text, 'Interno'::text, 'Absorbido'::text]))),
    CONSTRAINT workshop_costs_unit_cost_check CHECK (((unit_cost >= (0)::numeric) AND ((unit_cost)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text]))))
);


--
-- Name: workshop_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workshop_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id text NOT NULL,
    recipient text NOT NULL,
    evidence text NOT NULL,
    exception boolean NOT NULL,
    reason text NOT NULL,
    credit_reason text DEFAULT ''::text NOT NULL,
    checklist jsonb NOT NULL,
    responsible_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workshop_deliveries_check CHECK (((NOT exception) OR (length(btrim(reason)) > 0))),
    CONSTRAINT workshop_deliveries_evidence_check CHECK ((length(btrim(evidence)) > 0)),
    CONSTRAINT workshop_deliveries_recipient_check CHECK ((length(btrim(recipient)) > 0))
);


--
-- Name: workshop_inspections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workshop_inspections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id text NOT NULL,
    km integer,
    fuel numeric(5,2),
    condition text NOT NULL,
    accessories text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workshop_inspections_condition_check CHECK (((length(btrim(condition)) >= 1) AND (length(btrim(condition)) <= 4000))),
    CONSTRAINT workshop_inspections_fuel_check CHECK ((((fuel >= (0)::numeric) AND (fuel <= (100)::numeric)) AND ((fuel)::text <> 'NaN'::text))),
    CONSTRAINT workshop_inspections_km_check CHECK ((km >= 0))
);


--
-- Name: workshop_tariffs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workshop_tariffs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    revision integer NOT NULL,
    description text NOT NULL,
    kind text NOT NULL,
    unit_cost numeric(14,4) NOT NULL,
    unit_price numeric(14,4) NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workshop_tariffs_code_check CHECK (((length(btrim(code)) >= 1) AND (length(btrim(code)) <= 100))),
    CONSTRAINT workshop_tariffs_description_check CHECK (((length(btrim(description)) >= 1) AND (length(btrim(description)) <= 500))),
    CONSTRAINT workshop_tariffs_kind_check CHECK ((kind = ANY (ARRAY['Material'::text, 'Trabajo'::text, 'Tercero'::text, 'Indirecto'::text]))),
    CONSTRAINT workshop_tariffs_unit_cost_check CHECK (((unit_cost >= (0)::numeric) AND ((unit_cost)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text])))),
    CONSTRAINT workshop_tariffs_unit_price_check CHECK (((unit_price >= (0)::numeric) AND ((unit_price)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text]))))
);


--
-- Name: workshop_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workshop_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id text NOT NULL,
    description text NOT NULL,
    assigned_to uuid NOT NULL,
    assignee_label text NOT NULL,
    status text DEFAULT 'Pendiente'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    last_reason text DEFAULT 'Created'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responsible_name text,
    CONSTRAINT workshop_tasks_description_check CHECK (((length(btrim(description)) >= 1) AND (length(btrim(description)) <= 2000))),
    CONSTRAINT workshop_tasks_status_check CHECK ((status = ANY (ARRAY['Pendiente'::text, 'En proceso'::text, 'Finalizada'::text])))
);


--
-- Name: command_results command_results_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.command_results
    ADD CONSTRAINT command_results_pkey PRIMARY KEY (actor, key);


--
-- Name: contract_files contract_files_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.contract_files
    ADD CONSTRAINT contract_files_pkey PRIMARY KEY (contract_id);


--
-- Name: customer_document_bytes customer_document_bytes_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.customer_document_bytes
    ADD CONSTRAINT customer_document_bytes_pkey PRIMARY KEY (file_id);


--
-- Name: estimate_document_files estimate_document_files_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.estimate_document_files
    ADD CONSTRAINT estimate_document_files_pkey PRIMARY KEY (document_id);


--
-- Name: expense_import_files expense_import_files_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.expense_import_files
    ADD CONSTRAINT expense_import_files_pkey PRIMARY KEY (import_id);


--
-- Name: payment_import_files payment_import_files_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.payment_import_files
    ADD CONSTRAINT payment_import_files_pkey PRIMARY KEY (import_id);


--
-- Name: source_workbook_bytes source_workbook_bytes_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.source_workbook_bytes
    ADD CONSTRAINT source_workbook_bytes_pkey PRIMARY KEY (workbook_id);


--
-- Name: vehicle_file_bytes vehicle_file_bytes_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.vehicle_file_bytes
    ADD CONSTRAINT vehicle_file_bytes_pkey PRIMARY KEY (file_id);


--
-- Name: agent_expense_proposals agent_expense_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_expense_proposals
    ADD CONSTRAINT agent_expense_proposals_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: billing_application_lines billing_application_lines_application_id_line_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_application_lines
    ADD CONSTRAINT billing_application_lines_application_id_line_id_key UNIQUE (application_id, line_id);


--
-- Name: billing_application_lines billing_application_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_application_lines
    ADD CONSTRAINT billing_application_lines_pkey PRIMARY KEY (id);


--
-- Name: billing_credit_lines billing_credit_lines_credit_id_line_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_credit_lines
    ADD CONSTRAINT billing_credit_lines_credit_id_line_id_key UNIQUE (credit_id, line_id);


--
-- Name: billing_credit_lines billing_credit_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_credit_lines
    ADD CONSTRAINT billing_credit_lines_pkey PRIMARY KEY (id);


--
-- Name: billing_credits billing_credits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_credits
    ADD CONSTRAINT billing_credits_pkey PRIMARY KEY (id);


--
-- Name: billing_document_lines billing_document_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_document_lines
    ADD CONSTRAINT billing_document_lines_pkey PRIMARY KEY (id);


--
-- Name: billing_documents billing_documents_folio_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_documents
    ADD CONSTRAINT billing_documents_folio_number_key UNIQUE (folio_number);


--
-- Name: billing_documents billing_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_documents
    ADD CONSTRAINT billing_documents_pkey PRIMARY KEY (id);


--
-- Name: billing_documents billing_documents_source_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_documents
    ADD CONSTRAINT billing_documents_source_key_key UNIQUE (source_key);


--
-- Name: budget_expense_links budget_expense_links_expense_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_expense_links
    ADD CONSTRAINT budget_expense_links_expense_id_key UNIQUE (expense_id);


--
-- Name: budget_expense_links budget_expense_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_expense_links
    ADD CONSTRAINT budget_expense_links_pkey PRIMARY KEY (id);


--
-- Name: budget_purchase_links budget_purchase_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_purchase_links
    ADD CONSTRAINT budget_purchase_links_pkey PRIMARY KEY (id);


--
-- Name: budget_purchase_links budget_purchase_links_purchase_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_purchase_links
    ADD CONSTRAINT budget_purchase_links_purchase_id_key UNIQUE (purchase_id);


--
-- Name: cash_entries cash_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_entries
    ADD CONSTRAINT cash_entries_pkey PRIMARY KEY (id);


--
-- Name: commission_bindings commission_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_bindings
    ADD CONSTRAINT commission_bindings_pkey PRIMARY KEY (id);


--
-- Name: commission_bindings commission_bindings_reservation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_bindings
    ADD CONSTRAINT commission_bindings_reservation_id_key UNIQUE (reservation_id);


--
-- Name: commission_eligibility commission_eligibility_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_eligibility
    ADD CONSTRAINT commission_eligibility_pkey PRIMARY KEY (id);


--
-- Name: commission_entries commission_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_pkey PRIMARY KEY (id);


--
-- Name: commission_entries commission_entries_reservation_id_basis_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_reservation_id_basis_hash_key UNIQUE (reservation_id, basis_hash);


--
-- Name: commission_rules commission_rules_code_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_code_revision_key UNIQUE (code, revision);


--
-- Name: commission_rules commission_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_pkey PRIMARY KEY (id);


--
-- Name: contract_acceptances contract_acceptances_contract_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_acceptances
    ADD CONSTRAINT contract_acceptances_contract_id_key UNIQUE (contract_id);


--
-- Name: contract_acceptances contract_acceptances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_acceptances
    ADD CONSTRAINT contract_acceptances_pkey PRIMARY KEY (id);


--
-- Name: cost_allocations cost_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_allocations
    ADD CONSTRAINT cost_allocations_pkey PRIMARY KEY (id);


--
-- Name: cost_centers cost_centers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_centers
    ADD CONSTRAINT cost_centers_pkey PRIMARY KEY (id);


--
-- Name: customer_aliases customer_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_aliases
    ADD CONSTRAINT customer_aliases_pkey PRIMARY KEY (source_id);


--
-- Name: customer_documents customer_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_documents
    ADD CONSTRAINT customer_documents_pkey PRIMARY KEY (id);


--
-- Name: customer_payments customer_payments_folio_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_payments
    ADD CONSTRAINT customer_payments_folio_number_key UNIQUE (folio_number);


--
-- Name: customer_payments customer_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_payments
    ADD CONSTRAINT customer_payments_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: estimate_approvals estimate_approvals_estimate_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_approvals
    ADD CONSTRAINT estimate_approvals_estimate_id_key UNIQUE (estimate_id);


--
-- Name: estimate_approvals estimate_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_approvals
    ADD CONSTRAINT estimate_approvals_pkey PRIMARY KEY (id);


--
-- Name: estimate_documents estimate_documents_estimate_id_status_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_documents
    ADD CONSTRAINT estimate_documents_estimate_id_status_key UNIQUE (estimate_id, status);


--
-- Name: estimate_documents estimate_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_documents
    ADD CONSTRAINT estimate_documents_pkey PRIMARY KEY (id);


--
-- Name: estimate_versions estimate_versions_folio_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_versions
    ADD CONSTRAINT estimate_versions_folio_number_key UNIQUE (folio_number);


--
-- Name: estimate_versions estimate_versions_order_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_versions
    ADD CONSTRAINT estimate_versions_order_id_revision_key UNIQUE (order_id, revision);


--
-- Name: estimate_versions estimate_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_versions
    ADD CONSTRAINT estimate_versions_pkey PRIMARY KEY (id);


--
-- Name: expense_import_origins expense_import_origins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_import_origins
    ADD CONSTRAINT expense_import_origins_pkey PRIMARY KEY (source_system, source_key);


--
-- Name: expense_import_rows expense_import_rows_import_id_row_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_import_rows
    ADD CONSTRAINT expense_import_rows_import_id_row_number_key UNIQUE (import_id, row_number);


--
-- Name: expense_import_rows expense_import_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_import_rows
    ADD CONSTRAINT expense_import_rows_pkey PRIMARY KEY (id);


--
-- Name: expense_imports expense_imports_file_hash_sheet_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_imports
    ADD CONSTRAINT expense_imports_file_hash_sheet_name_key UNIQUE (file_hash, sheet_name);


--
-- Name: expense_imports expense_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_imports
    ADD CONSTRAINT expense_imports_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: integration_inbox integration_inbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_inbox
    ADD CONSTRAINT integration_inbox_pkey PRIMARY KEY (id);


--
-- Name: integration_inbox integration_inbox_source_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_inbox
    ADD CONSTRAINT integration_inbox_source_external_id_key UNIQUE (source, external_id);


--
-- Name: operating_budgets operating_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operating_budgets
    ADD CONSTRAINT operating_budgets_pkey PRIMARY KEY (id);


--
-- Name: payment_applications payment_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_applications
    ADD CONSTRAINT payment_applications_pkey PRIMARY KEY (id);


--
-- Name: payment_import_origins payment_import_origins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_import_origins
    ADD CONSTRAINT payment_import_origins_pkey PRIMARY KEY (id);


--
-- Name: payment_import_origins payment_import_origins_source_system_source_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_import_origins
    ADD CONSTRAINT payment_import_origins_source_system_source_key_key UNIQUE (source_system, source_key);


--
-- Name: payment_imports payment_imports_file_hash_sheet_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_imports
    ADD CONSTRAINT payment_imports_file_hash_sheet_key UNIQUE (file_hash, sheet);


--
-- Name: payment_imports payment_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_imports
    ADD CONSTRAINT payment_imports_pkey PRIMARY KEY (id);


--
-- Name: payment_refunds payment_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: receipt_operation_contexts receipt_operation_contexts_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_operation_contexts
    ADD CONSTRAINT receipt_operation_contexts_payment_id_key UNIQUE (payment_id);


--
-- Name: receipt_operation_contexts receipt_operation_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_operation_contexts
    ADD CONSTRAINT receipt_operation_contexts_pkey PRIMARY KEY (id);


--
-- Name: rental_contracts rental_contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_contracts
    ADD CONSTRAINT rental_contracts_pkey PRIMARY KEY (id);


--
-- Name: rental_contracts rental_contracts_reservation_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_contracts
    ADD CONSTRAINT rental_contracts_reservation_id_revision_key UNIQUE (reservation_id, revision);


--
-- Name: rental_extra_proposals rental_extra_proposals_document_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_extra_proposals
    ADD CONSTRAINT rental_extra_proposals_document_id_key UNIQUE (document_id);


--
-- Name: rental_extra_proposals rental_extra_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_extra_proposals
    ADD CONSTRAINT rental_extra_proposals_pkey PRIMARY KEY (id);


--
-- Name: rental_inspections rental_inspections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_inspections
    ADD CONSTRAINT rental_inspections_pkey PRIMARY KEY (id);


--
-- Name: rental_inspections rental_inspections_reservation_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_inspections
    ADD CONSTRAINT rental_inspections_reservation_id_kind_key UNIQUE (reservation_id, kind);


--
-- Name: rental_periods rental_periods_document_line_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_periods
    ADD CONSTRAINT rental_periods_document_line_id_key UNIQUE (document_line_id);


--
-- Name: rental_periods rental_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_periods
    ADD CONSTRAINT rental_periods_pkey PRIMARY KEY (id);


--
-- Name: rental_periods rental_periods_reservation_id_daterange_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_periods
    ADD CONSTRAINT rental_periods_reservation_id_daterange_excl EXCLUDE USING gist (reservation_id WITH =, daterange(starts_on, ends_on, '[]'::text) WITH &&);


--
-- Name: report_outbox report_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_outbox
    ADD CONSTRAINT report_outbox_pkey PRIMARY KEY (id);


--
-- Name: report_outbox report_outbox_schedule_id_cutoff_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_outbox
    ADD CONSTRAINT report_outbox_schedule_id_cutoff_key UNIQUE (schedule_id, cutoff);


--
-- Name: report_schedules report_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_schedules
    ADD CONSTRAINT report_schedules_pkey PRIMARY KEY (id);


--
-- Name: reservation_evidence reservation_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_evidence
    ADD CONSTRAINT reservation_evidence_pkey PRIMARY KEY (id);


--
-- Name: reservations reservations_folio_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_folio_number_key UNIQUE (folio_number);


--
-- Name: reservations reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_pkey PRIMARY KEY (id);


--
-- Name: source_workbook_items source_workbook_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_workbook_items
    ADD CONSTRAINT source_workbook_items_pkey PRIMARY KEY (id);


--
-- Name: source_workbook_items source_workbook_items_workbook_id_source_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_workbook_items
    ADD CONSTRAINT source_workbook_items_workbook_id_source_ref_key UNIQUE (workbook_id, source_ref);


--
-- Name: source_workbooks source_workbooks_file_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_workbooks
    ADD CONSTRAINT source_workbooks_file_hash_key UNIQUE (file_hash);


--
-- Name: source_workbooks source_workbooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_workbooks
    ADD CONSTRAINT source_workbooks_pkey PRIMARY KEY (id);


--
-- Name: stock_items stock_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_pkey PRIMARY KEY (id);


--
-- Name: stock_items stock_items_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_sku_key UNIQUE (sku);


--
-- Name: stock_movements stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);


--
-- Name: supplier_obligations supplier_obligations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_obligations
    ADD CONSTRAINT supplier_obligations_pkey PRIMARY KEY (id);


--
-- Name: supplier_obligations supplier_obligations_receipt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_obligations
    ADD CONSTRAINT supplier_obligations_receipt_id_key UNIQUE (receipt_id);


--
-- Name: task_time_spans task_time_spans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_time_spans
    ADD CONSTRAINT task_time_spans_pkey PRIMARY KEY (id);


--
-- Name: task_timers task_timers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_timers
    ADD CONSTRAINT task_timers_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role);


--
-- Name: vehicle_commitments vehicle_commitments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_commitments
    ADD CONSTRAINT vehicle_commitments_pkey PRIMARY KEY (id);


--
-- Name: vehicle_commitments vehicle_commitments_vehicle_id_tstzrange_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_commitments
    ADD CONSTRAINT vehicle_commitments_vehicle_id_tstzrange_excl EXCLUDE USING gist (vehicle_id WITH =, tstzrange(starts_at, ends_at, '[)'::text) WITH &&) WHERE (active);


--
-- Name: vehicle_files vehicle_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_files
    ADD CONSTRAINT vehicle_files_pkey PRIMARY KEY (id);


--
-- Name: vehicles vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);


--
-- Name: work_orders work_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_pkey PRIMARY KEY (id);


--
-- Name: workshop_costs workshop_costs_expense_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_costs
    ADD CONSTRAINT workshop_costs_expense_id_key UNIQUE (expense_id);


--
-- Name: workshop_costs workshop_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_costs
    ADD CONSTRAINT workshop_costs_pkey PRIMARY KEY (id);


--
-- Name: workshop_costs workshop_costs_stock_dispatch_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_costs
    ADD CONSTRAINT workshop_costs_stock_dispatch_id_key UNIQUE (stock_dispatch_id);


--
-- Name: workshop_deliveries workshop_deliveries_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_deliveries
    ADD CONSTRAINT workshop_deliveries_order_id_key UNIQUE (order_id);


--
-- Name: workshop_deliveries workshop_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_deliveries
    ADD CONSTRAINT workshop_deliveries_pkey PRIMARY KEY (id);


--
-- Name: workshop_inspections workshop_inspections_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_inspections
    ADD CONSTRAINT workshop_inspections_order_id_key UNIQUE (order_id);


--
-- Name: workshop_inspections workshop_inspections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_inspections
    ADD CONSTRAINT workshop_inspections_pkey PRIMARY KEY (id);


--
-- Name: workshop_tariffs workshop_tariffs_code_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_tariffs
    ADD CONSTRAINT workshop_tariffs_code_revision_key UNIQUE (code, revision);


--
-- Name: workshop_tariffs workshop_tariffs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_tariffs
    ADD CONSTRAINT workshop_tariffs_pkey PRIMARY KEY (id);


--
-- Name: workshop_tasks workshop_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_tasks
    ADD CONSTRAINT workshop_tasks_pkey PRIMARY KEY (id);


--
-- Name: billing_external_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX billing_external_reference ON public.billing_documents USING btree (customer_id, external_reference) WHERE (external_reference <> ''::text);


--
-- Name: cash_account_opening; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cash_account_opening ON public.cash_entries USING btree (account) WHERE (kind = 'Apertura'::text);


--
-- Name: commitment_reservation_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX commitment_reservation_kind ON public.vehicle_commitments USING btree (reservation_id, kind) WHERE (reservation_id IS NOT NULL);


--
-- Name: commitment_work_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX commitment_work_order ON public.vehicle_commitments USING btree (order_id) WHERE (order_id IS NOT NULL);


--
-- Name: customer_documents_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_documents_customer ON public.customer_documents USING btree (customer_id, created_at DESC);


--
-- Name: customers_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customers_document ON public.customers USING btree (document_key) WHERE (document_key <> ''::text);


--
-- Name: customers_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customers_phone ON public.customers USING btree (phone_key);


--
-- Name: direct_purchase_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX direct_purchase_reference ON public.workshop_costs USING btree (lower(btrim(supplier)), lower(btrim(source_reference))) WHERE (kind = 'Compra directa'::text);


--
-- Name: expense_direct_purchase; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expense_direct_purchase ON public.expenses USING btree (direct_purchase_cost_id) WHERE (direct_purchase_cost_id IS NOT NULL);


--
-- Name: expense_import_rows_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expense_import_rows_batch ON public.expense_import_rows USING btree (import_id, row_number);


--
-- Name: expenses_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_date ON public.expenses USING btree (date);


--
-- Name: expenses_operation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_operation ON public.expenses USING btree (operation_id);


--
-- Name: legacy_period_document; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX legacy_period_document ON public.rental_periods USING btree (document_id) WHERE (document_line_id IS NULL);


--
-- Name: linked_expense_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX linked_expense_order ON public.workshop_costs USING btree (linked_expense_id, order_id) WHERE (linked_expense_id IS NOT NULL);


--
-- Name: one_active_timer_per_worker; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX one_active_timer_per_worker ON public.task_timers USING btree (worker_id) WHERE (state = 'Activo'::text);


--
-- Name: one_live_timer_per_task_worker; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX one_live_timer_per_task_worker ON public.task_timers USING btree (task_id, worker_id) WHERE (state <> 'Finalizado'::text);


--
-- Name: one_open_order_per_vehicle; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX one_open_order_per_vehicle ON public.work_orders USING btree (vehicle_id) WHERE (status <> 'Entregado'::text);


--
-- Name: one_open_span_per_timer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX one_open_span_per_timer ON public.task_time_spans USING btree (timer_id) WHERE (ended_at IS NULL);


--
-- Name: vehicles_known_plate_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX vehicles_known_plate_key ON public.vehicles USING btree (plate_key) WHERE (plate_key <> ''::text);


--
-- Name: vehicles_source_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX vehicles_source_reference ON public.vehicles USING btree (source_workbook_id, source_ref) WHERE (source_workbook_id IS NOT NULL);


--
-- Name: work_orders_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX work_orders_customer ON public.work_orders USING btree (customer_id);


--
-- Name: work_orders_vehicle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX work_orders_vehicle ON public.work_orders USING btree (vehicle_id, occurred_at);


--
-- Name: workshop_cost_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workshop_cost_order ON public.workshop_costs USING btree (order_id);


--
-- Name: workshop_tasks_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workshop_tasks_assignee ON public.workshop_tasks USING btree (assigned_to, status);


--
-- Name: workshop_tasks_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workshop_tasks_order ON public.workshop_tasks USING btree (order_id, created_at);


--
-- Name: agent_expense_proposals agent_proposal_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_proposal_audit AFTER INSERT OR UPDATE ON public.agent_expense_proposals FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: payment_applications allocate_application; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER allocate_application AFTER INSERT ON public.payment_applications FOR EACH ROW EXECUTE FUNCTION private.allocate_document_event();


--
-- Name: billing_credits allocate_credit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER allocate_credit AFTER INSERT ON public.billing_credits FOR EACH ROW EXECUTE FUNCTION private.allocate_document_event();


--
-- Name: workshop_costs allocated_cost_net; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER allocated_cost_net BEFORE UPDATE ON public.workshop_costs FOR EACH ROW EXECUTE FUNCTION private.check_cost_allocation_net();


--
-- Name: estimate_approvals approval_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approval_audit AFTER INSERT ON public.estimate_approvals FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: estimate_approvals approval_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approval_immutable BEFORE DELETE OR UPDATE ON public.estimate_approvals FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: billing_credits billing_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_audit AFTER INSERT ON public.billing_credits FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: billing_documents billing_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_audit AFTER INSERT ON public.billing_documents FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: customer_payments billing_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_audit AFTER INSERT ON public.customer_payments FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: payment_applications billing_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_audit AFTER INSERT ON public.payment_applications FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: payment_refunds billing_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_audit AFTER INSERT ON public.payment_refunds FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: billing_credits billing_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_immutable BEFORE DELETE OR UPDATE ON public.billing_credits FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: billing_documents billing_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_immutable BEFORE DELETE OR UPDATE ON public.billing_documents FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: customer_payments billing_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_immutable BEFORE DELETE OR UPDATE ON public.customer_payments FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: payment_applications billing_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_immutable BEFORE DELETE OR UPDATE ON public.payment_applications FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: payment_refunds billing_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_immutable BEFORE DELETE OR UPDATE ON public.payment_refunds FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: budget_expense_links budget_expense_link_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER budget_expense_link_immutable BEFORE DELETE OR UPDATE ON public.budget_expense_links FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: budget_purchase_links budget_purchase_link_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER budget_purchase_link_immutable BEFORE DELETE OR UPDATE ON public.budget_purchase_links FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: cost_allocations case_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER case_audit AFTER INSERT OR UPDATE ON public.cost_allocations FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: vehicle_files case_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER case_audit AFTER INSERT OR UPDATE ON public.vehicle_files FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: workshop_inspections case_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER case_audit AFTER INSERT OR UPDATE ON public.workshop_inspections FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: cash_entries cash_entry_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cash_entry_audit AFTER INSERT ON public.cash_entries FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: cash_entries cash_entry_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cash_entry_immutable BEFORE DELETE OR UPDATE ON public.cash_entries FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: vehicle_commitments commitment_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER commitment_audit AFTER INSERT OR UPDATE ON public.vehicle_commitments FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: customers customer_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customer_audit AFTER INSERT OR UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: customer_documents customer_document_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customer_document_audit AFTER INSERT ON public.customer_documents FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: customer_documents customer_document_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customer_document_immutable BEFORE DELETE OR UPDATE ON public.customer_documents FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: workshop_deliveries delivery_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delivery_audit AFTER INSERT ON public.workshop_deliveries FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: workshop_deliveries delivery_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delivery_immutable BEFORE DELETE OR UPDATE ON public.workshop_deliveries FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: estimate_versions estimate_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER estimate_audit AFTER INSERT OR UPDATE ON public.estimate_versions FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: estimate_documents estimate_document_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER estimate_document_audit AFTER INSERT ON public.estimate_documents FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: estimate_documents estimate_document_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER estimate_document_immutable BEFORE DELETE OR UPDATE ON public.estimate_documents FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: estimate_versions estimate_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER estimate_immutable BEFORE DELETE OR UPDATE ON public.estimate_versions FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: workshop_inspections estimate_intake; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER estimate_intake AFTER INSERT ON public.workshop_inspections FOR EACH ROW EXECUTE FUNCTION private.receive_estimated_work();


--
-- Name: expenses expense_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expense_audit AFTER INSERT ON public.expenses FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: expenses expense_cost; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expense_cost AFTER INSERT ON public.expenses FOR EACH ROW EXECUTE FUNCTION private.expense_to_workshop_cost();


--
-- Name: expenses expense_update_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expense_update_audit AFTER UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: billing_application_lines grouped_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grouped_audit AFTER INSERT ON public.billing_application_lines FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: billing_credit_lines grouped_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grouped_audit AFTER INSERT ON public.billing_credit_lines FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: billing_document_lines grouped_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grouped_audit AFTER INSERT ON public.billing_document_lines FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: billing_application_lines grouped_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grouped_immutable BEFORE DELETE OR UPDATE ON public.billing_application_lines FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: billing_credit_lines grouped_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grouped_immutable BEFORE DELETE OR UPDATE ON public.billing_credit_lines FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: billing_document_lines grouped_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grouped_immutable BEFORE DELETE OR UPDATE ON public.billing_document_lines FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: expense_imports import_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER import_audit AFTER INSERT OR UPDATE ON public.expense_imports FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: rental_inspections inspection_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inspection_audit AFTER INSERT ON public.rental_inspections FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: rental_inspections inspection_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inspection_immutable BEFORE DELETE OR UPDATE ON public.rental_inspections FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: workshop_inspections intake_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER intake_immutable BEFORE DELETE OR UPDATE ON public.workshop_inspections FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: purchase_orders inventory_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_audit AFTER INSERT OR UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: stock_items inventory_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_audit AFTER INSERT OR UPDATE ON public.stock_items FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: stock_movements inventory_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_audit AFTER INSERT OR UPDATE ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: supplier_obligations inventory_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_audit AFTER INSERT OR UPDATE ON public.supplier_obligations FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: commission_bindings management_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_audit AFTER INSERT ON public.commission_bindings FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: commission_eligibility management_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_audit AFTER INSERT ON public.commission_eligibility FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: commission_entries management_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_audit AFTER INSERT ON public.commission_entries FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: commission_rules management_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_audit AFTER INSERT ON public.commission_rules FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: contract_acceptances management_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_audit AFTER INSERT ON public.contract_acceptances FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: rental_contracts management_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_audit AFTER INSERT ON public.rental_contracts FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: commission_bindings management_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_immutable BEFORE DELETE OR UPDATE ON public.commission_bindings FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: commission_eligibility management_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_immutable BEFORE DELETE OR UPDATE ON public.commission_eligibility FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: commission_entries management_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_immutable BEFORE DELETE OR UPDATE ON public.commission_entries FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: commission_rules management_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_immutable BEFORE DELETE OR UPDATE ON public.commission_rules FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: contract_acceptances management_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_immutable BEFORE DELETE OR UPDATE ON public.contract_acceptances FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: rental_contracts management_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER management_immutable BEFORE DELETE OR UPDATE ON public.rental_contracts FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: supplier_obligations obligation_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER obligation_immutable BEFORE DELETE OR UPDATE ON public.supplier_obligations FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: operating_budgets operating_budget_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER operating_budget_immutable BEFORE DELETE OR UPDATE ON public.operating_budgets FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: budget_expense_links optional_module_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER optional_module_audit AFTER INSERT OR UPDATE ON public.budget_expense_links FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: budget_purchase_links optional_module_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER optional_module_audit AFTER INSERT OR UPDATE ON public.budget_purchase_links FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: integration_inbox optional_module_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER optional_module_audit AFTER INSERT OR UPDATE ON public.integration_inbox FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: operating_budgets optional_module_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER optional_module_audit AFTER INSERT OR UPDATE ON public.operating_budgets FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: work_orders order_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER order_audit AFTER INSERT OR UPDATE ON public.work_orders FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: payment_imports payment_import_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payment_import_audit AFTER INSERT OR UPDATE ON public.payment_imports FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: payment_import_origins payment_origin_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payment_origin_audit AFTER INSERT ON public.payment_import_origins FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: rental_periods period_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER period_audit AFTER INSERT ON public.rental_periods FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: rental_periods period_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER period_immutable BEFORE DELETE OR UPDATE ON public.rental_periods FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: receipt_operation_contexts receipt_context_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER receipt_context_audit AFTER INSERT ON public.receipt_operation_contexts FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: receipt_operation_contexts receipt_context_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER receipt_context_immutable BEFORE DELETE OR UPDATE ON public.receipt_operation_contexts FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: payment_refunds refund_account_capture; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER refund_account_capture BEFORE INSERT ON public.payment_refunds FOR EACH ROW EXECUTE FUNCTION private.capture_refund_account();


--
-- Name: rental_extra_proposals rental_extra_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rental_extra_audit AFTER INSERT OR UPDATE ON public.rental_extra_proposals FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: report_outbox report_delivery_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER report_delivery_audit AFTER INSERT OR UPDATE ON public.report_outbox FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: report_schedules report_delivery_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER report_delivery_audit AFTER INSERT OR UPDATE ON public.report_schedules FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: reservations reservation_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reservation_audit AFTER INSERT OR UPDATE ON public.reservations FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: reservation_evidence reservation_evidence_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reservation_evidence_audit AFTER INSERT ON public.reservation_evidence FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: reservation_evidence reservation_evidence_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reservation_evidence_immutable BEFORE DELETE OR UPDATE ON public.reservation_evidence FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: customers reservation_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reservation_identity AFTER UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION private.merge_reservation_identity();


--
-- Name: source_workbook_items source_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_audit AFTER INSERT OR UPDATE ON public.source_workbook_items FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: source_workbooks source_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_audit AFTER INSERT OR UPDATE ON public.source_workbooks FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: source_workbooks source_book_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_book_immutable BEFORE DELETE OR UPDATE ON public.source_workbooks FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: stock_movements stock_movement_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER stock_movement_immutable BEFORE DELETE OR UPDATE ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: workshop_tariffs tariff_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tariff_audit AFTER INSERT ON public.workshop_tariffs FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: workshop_tariffs tariff_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tariff_immutable BEFORE DELETE OR UPDATE ON public.workshop_tariffs FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: workshop_tasks task_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_audit AFTER INSERT OR UPDATE ON public.workshop_tasks FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: workshop_tasks task_timer_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_timer_guard BEFORE UPDATE ON public.workshop_tasks FOR EACH ROW EXECUTE FUNCTION private.task_timer_guard();


--
-- Name: task_time_spans time_span_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER time_span_audit AFTER INSERT OR UPDATE ON public.task_time_spans FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: task_timers timer_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER timer_audit AFTER INSERT OR UPDATE ON public.task_timers FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: vehicles vehicle_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vehicle_audit AFTER INSERT OR UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: vehicle_files vehicle_file_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vehicle_file_immutable BEFORE DELETE OR UPDATE ON public.vehicle_files FOR EACH ROW EXECUTE FUNCTION private.immutable_quote_record();


--
-- Name: work_orders workshop_commitment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workshop_commitment AFTER INSERT OR UPDATE ON public.work_orders FOR EACH ROW EXECUTE FUNCTION private.workshop_commitment();


--
-- Name: workshop_costs workshop_cost_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workshop_cost_audit AFTER INSERT OR UPDATE ON public.workshop_costs FOR EACH ROW EXECUTE FUNCTION private.audit_change();


--
-- Name: command_results command_results_actor_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.command_results
    ADD CONSTRAINT command_results_actor_fkey FOREIGN KEY (actor) REFERENCES auth.users(id);


--
-- Name: contract_files contract_files_contract_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.contract_files
    ADD CONSTRAINT contract_files_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.rental_contracts(id);


--
-- Name: customer_document_bytes customer_document_bytes_file_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.customer_document_bytes
    ADD CONSTRAINT customer_document_bytes_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.customer_documents(id);


--
-- Name: estimate_document_files estimate_document_files_document_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.estimate_document_files
    ADD CONSTRAINT estimate_document_files_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.estimate_documents(id);


--
-- Name: expense_import_files expense_import_files_import_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.expense_import_files
    ADD CONSTRAINT expense_import_files_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.expense_imports(id);


--
-- Name: payment_import_files payment_import_files_import_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.payment_import_files
    ADD CONSTRAINT payment_import_files_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.payment_imports(id);


--
-- Name: source_workbook_bytes source_workbook_bytes_workbook_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.source_workbook_bytes
    ADD CONSTRAINT source_workbook_bytes_workbook_id_fkey FOREIGN KEY (workbook_id) REFERENCES public.source_workbooks(id);


--
-- Name: vehicle_file_bytes vehicle_file_bytes_file_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.vehicle_file_bytes
    ADD CONSTRAINT vehicle_file_bytes_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.vehicle_files(id);


--
-- Name: agent_expense_proposals agent_expense_proposals_actor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_expense_proposals
    ADD CONSTRAINT agent_expense_proposals_actor_fkey FOREIGN KEY (actor) REFERENCES auth.users(id);


--
-- Name: audit_events audit_events_actor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_fkey FOREIGN KEY (actor) REFERENCES auth.users(id);


--
-- Name: billing_application_lines billing_application_lines_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_application_lines
    ADD CONSTRAINT billing_application_lines_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.payment_applications(id);


--
-- Name: billing_application_lines billing_application_lines_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_application_lines
    ADD CONSTRAINT billing_application_lines_line_id_fkey FOREIGN KEY (line_id) REFERENCES public.billing_document_lines(id);


--
-- Name: billing_credit_lines billing_credit_lines_credit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_credit_lines
    ADD CONSTRAINT billing_credit_lines_credit_id_fkey FOREIGN KEY (credit_id) REFERENCES public.billing_credits(id);


--
-- Name: billing_credit_lines billing_credit_lines_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_credit_lines
    ADD CONSTRAINT billing_credit_lines_line_id_fkey FOREIGN KEY (line_id) REFERENCES public.billing_document_lines(id);


--
-- Name: billing_credits billing_credits_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_credits
    ADD CONSTRAINT billing_credits_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: billing_credits billing_credits_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_credits
    ADD CONSTRAINT billing_credits_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.billing_documents(id);


--
-- Name: billing_document_lines billing_document_lines_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_document_lines
    ADD CONSTRAINT billing_document_lines_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: billing_document_lines billing_document_lines_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_document_lines
    ADD CONSTRAINT billing_document_lines_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.billing_documents(id);


--
-- Name: billing_document_lines billing_document_lines_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_document_lines
    ADD CONSTRAINT billing_document_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: billing_document_lines billing_document_lines_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_document_lines
    ADD CONSTRAINT billing_document_lines_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: billing_documents billing_documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_documents
    ADD CONSTRAINT billing_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: billing_documents billing_documents_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_documents
    ADD CONSTRAINT billing_documents_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: billing_documents billing_documents_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_documents
    ADD CONSTRAINT billing_documents_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimate_versions(id);


--
-- Name: billing_documents billing_documents_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_documents
    ADD CONSTRAINT billing_documents_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: billing_documents billing_documents_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_documents
    ADD CONSTRAINT billing_documents_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: budget_expense_links budget_expense_links_budget_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_expense_links
    ADD CONSTRAINT budget_expense_links_budget_id_fkey FOREIGN KEY (budget_id) REFERENCES public.operating_budgets(id);


--
-- Name: budget_expense_links budget_expense_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_expense_links
    ADD CONSTRAINT budget_expense_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: budget_expense_links budget_expense_links_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_expense_links
    ADD CONSTRAINT budget_expense_links_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id);


--
-- Name: budget_expense_links budget_expense_links_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_expense_links
    ADD CONSTRAINT budget_expense_links_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchase_orders(id);


--
-- Name: budget_purchase_links budget_purchase_links_budget_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_purchase_links
    ADD CONSTRAINT budget_purchase_links_budget_id_fkey FOREIGN KEY (budget_id) REFERENCES public.operating_budgets(id);


--
-- Name: budget_purchase_links budget_purchase_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_purchase_links
    ADD CONSTRAINT budget_purchase_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: budget_purchase_links budget_purchase_links_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_purchase_links
    ADD CONSTRAINT budget_purchase_links_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchase_orders(id);


--
-- Name: cash_entries cash_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_entries
    ADD CONSTRAINT cash_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: commission_bindings commission_bindings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_bindings
    ADD CONSTRAINT commission_bindings_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: commission_bindings commission_bindings_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_bindings
    ADD CONSTRAINT commission_bindings_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: commission_bindings commission_bindings_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_bindings
    ADD CONSTRAINT commission_bindings_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.commission_rules(id);


--
-- Name: commission_eligibility commission_eligibility_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_eligibility
    ADD CONSTRAINT commission_eligibility_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: commission_eligibility commission_eligibility_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_eligibility
    ADD CONSTRAINT commission_eligibility_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.billing_documents(id);


--
-- Name: commission_entries commission_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: commission_entries commission_entries_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: commission_entries commission_entries_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.commission_rules(id);


--
-- Name: commission_entries commission_entries_seller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES auth.users(id);


--
-- Name: commission_rules commission_rules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: contract_acceptances contract_acceptances_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_acceptances
    ADD CONSTRAINT contract_acceptances_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.rental_contracts(id);


--
-- Name: contract_acceptances contract_acceptances_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_acceptances
    ADD CONSTRAINT contract_acceptances_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: cost_allocations cost_allocations_cost_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_allocations
    ADD CONSTRAINT cost_allocations_cost_id_fkey FOREIGN KEY (cost_id) REFERENCES public.workshop_costs(id);


--
-- Name: cost_allocations cost_allocations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_allocations
    ADD CONSTRAINT cost_allocations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: cost_allocations cost_allocations_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_allocations
    ADD CONSTRAINT cost_allocations_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimate_versions(id);


--
-- Name: customer_aliases customer_aliases_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_aliases
    ADD CONSTRAINT customer_aliases_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: customer_aliases customer_aliases_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_aliases
    ADD CONSTRAINT customer_aliases_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.customers(id);


--
-- Name: customer_documents customer_documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_documents
    ADD CONSTRAINT customer_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: customer_documents customer_documents_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_documents
    ADD CONSTRAINT customer_documents_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: customer_payments customer_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_payments
    ADD CONSTRAINT customer_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: customer_payments customer_payments_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_payments
    ADD CONSTRAINT customer_payments_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: customers customers_merged_into_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.customers(id);


--
-- Name: estimate_approvals estimate_approvals_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_approvals
    ADD CONSTRAINT estimate_approvals_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimate_versions(id);


--
-- Name: estimate_approvals estimate_approvals_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_approvals
    ADD CONSTRAINT estimate_approvals_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES auth.users(id);


--
-- Name: estimate_documents estimate_documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_documents
    ADD CONSTRAINT estimate_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: estimate_documents estimate_documents_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_documents
    ADD CONSTRAINT estimate_documents_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimate_versions(id);


--
-- Name: estimate_versions estimate_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_versions
    ADD CONSTRAINT estimate_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: estimate_versions estimate_versions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_versions
    ADD CONSTRAINT estimate_versions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: estimate_versions estimate_versions_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_versions
    ADD CONSTRAINT estimate_versions_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.estimate_versions(id);


--
-- Name: expense_import_origins expense_import_origins_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_import_origins
    ADD CONSTRAINT expense_import_origins_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id);


--
-- Name: expense_import_origins expense_import_origins_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_import_origins
    ADD CONSTRAINT expense_import_origins_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.expense_imports(id);


--
-- Name: expense_import_rows expense_import_rows_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_import_rows
    ADD CONSTRAINT expense_import_rows_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id);


--
-- Name: expense_import_rows expense_import_rows_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_import_rows
    ADD CONSTRAINT expense_import_rows_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.expense_imports(id);


--
-- Name: expense_imports expense_imports_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_imports
    ADD CONSTRAINT expense_imports_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: expenses expenses_cost_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_cost_center_id_fkey FOREIGN KEY (cost_center_id) REFERENCES public.cost_centers(id);


--
-- Name: expenses expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: expenses expenses_direct_purchase_cost_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_direct_purchase_cost_id_fkey FOREIGN KEY (direct_purchase_cost_id) REFERENCES public.workshop_costs(id);


--
-- Name: expenses expenses_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.work_orders(id);


--
-- Name: expenses expenses_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: expenses expenses_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: integration_inbox integration_inbox_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_inbox
    ADD CONSTRAINT integration_inbox_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: operating_budgets operating_budgets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operating_budgets
    ADD CONSTRAINT operating_budgets_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: payment_applications payment_applications_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_applications
    ADD CONSTRAINT payment_applications_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: payment_applications payment_applications_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_applications
    ADD CONSTRAINT payment_applications_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.billing_documents(id);


--
-- Name: payment_applications payment_applications_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_applications
    ADD CONSTRAINT payment_applications_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.customer_payments(id);


--
-- Name: payment_import_origins payment_import_origins_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_import_origins
    ADD CONSTRAINT payment_import_origins_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: payment_import_origins payment_import_origins_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_import_origins
    ADD CONSTRAINT payment_import_origins_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.customer_payments(id);


--
-- Name: payment_imports payment_imports_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_imports
    ADD CONSTRAINT payment_imports_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: payment_refunds payment_refunds_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: payment_refunds payment_refunds_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.billing_documents(id);


--
-- Name: payment_refunds payment_refunds_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.customer_payments(id);


--
-- Name: purchase_orders purchase_orders_authorized_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_authorized_by_fkey FOREIGN KEY (authorized_by) REFERENCES auth.users(id);


--
-- Name: purchase_orders purchase_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: purchase_orders purchase_orders_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.stock_items(id);


--
-- Name: receipt_operation_contexts receipt_operation_contexts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_operation_contexts
    ADD CONSTRAINT receipt_operation_contexts_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: receipt_operation_contexts receipt_operation_contexts_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_operation_contexts
    ADD CONSTRAINT receipt_operation_contexts_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: receipt_operation_contexts receipt_operation_contexts_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_operation_contexts
    ADD CONSTRAINT receipt_operation_contexts_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.customer_payments(id);


--
-- Name: receipt_operation_contexts receipt_operation_contexts_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_operation_contexts
    ADD CONSTRAINT receipt_operation_contexts_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: rental_contracts rental_contracts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_contracts
    ADD CONSTRAINT rental_contracts_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: rental_contracts rental_contracts_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_contracts
    ADD CONSTRAINT rental_contracts_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.rental_contracts(id);


--
-- Name: rental_contracts rental_contracts_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_contracts
    ADD CONSTRAINT rental_contracts_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: rental_extra_proposals rental_extra_proposals_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_extra_proposals
    ADD CONSTRAINT rental_extra_proposals_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: rental_extra_proposals rental_extra_proposals_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_extra_proposals
    ADD CONSTRAINT rental_extra_proposals_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.billing_documents(id);


--
-- Name: rental_extra_proposals rental_extra_proposals_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_extra_proposals
    ADD CONSTRAINT rental_extra_proposals_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: rental_inspections rental_inspections_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_inspections
    ADD CONSTRAINT rental_inspections_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: rental_inspections rental_inspections_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_inspections
    ADD CONSTRAINT rental_inspections_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: rental_periods rental_periods_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_periods
    ADD CONSTRAINT rental_periods_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: rental_periods rental_periods_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_periods
    ADD CONSTRAINT rental_periods_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.billing_documents(id);


--
-- Name: rental_periods rental_periods_document_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_periods
    ADD CONSTRAINT rental_periods_document_line_id_fkey FOREIGN KEY (document_line_id) REFERENCES public.billing_document_lines(id);


--
-- Name: rental_periods rental_periods_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rental_periods
    ADD CONSTRAINT rental_periods_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: report_outbox report_outbox_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_outbox
    ADD CONSTRAINT report_outbox_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: report_outbox report_outbox_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_outbox
    ADD CONSTRAINT report_outbox_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES auth.users(id);


--
-- Name: report_outbox report_outbox_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_outbox
    ADD CONSTRAINT report_outbox_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.report_schedules(id);


--
-- Name: report_schedules report_schedules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_schedules
    ADD CONSTRAINT report_schedules_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: report_schedules report_schedules_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_schedules
    ADD CONSTRAINT report_schedules_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES auth.users(id);


--
-- Name: report_schedules report_schedules_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_schedules
    ADD CONSTRAINT report_schedules_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: reservation_evidence reservation_evidence_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_evidence
    ADD CONSTRAINT reservation_evidence_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: reservation_evidence reservation_evidence_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_evidence
    ADD CONSTRAINT reservation_evidence_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: reservations reservations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: reservations reservations_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: reservations reservations_seller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES auth.users(id);


--
-- Name: reservations reservations_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: source_workbook_items source_workbook_items_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_workbook_items
    ADD CONSTRAINT source_workbook_items_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);


--
-- Name: source_workbook_items source_workbook_items_workbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_workbook_items
    ADD CONSTRAINT source_workbook_items_workbook_id_fkey FOREIGN KEY (workbook_id) REFERENCES public.source_workbooks(id);


--
-- Name: source_workbooks source_workbooks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_workbooks
    ADD CONSTRAINT source_workbooks_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: stock_items stock_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: stock_movements stock_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: stock_movements stock_movements_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.stock_items(id);


--
-- Name: stock_movements stock_movements_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: stock_movements stock_movements_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchase_orders(id);


--
-- Name: stock_movements stock_movements_reverses_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_reverses_id_fkey FOREIGN KEY (reverses_id) REFERENCES public.stock_movements(id);


--
-- Name: supplier_obligations supplier_obligations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_obligations
    ADD CONSTRAINT supplier_obligations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: supplier_obligations supplier_obligations_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_obligations
    ADD CONSTRAINT supplier_obligations_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchase_orders(id);


--
-- Name: supplier_obligations supplier_obligations_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_obligations
    ADD CONSTRAINT supplier_obligations_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.stock_movements(id);


--
-- Name: task_time_spans task_time_spans_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_time_spans
    ADD CONSTRAINT task_time_spans_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: task_time_spans task_time_spans_timer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_time_spans
    ADD CONSTRAINT task_time_spans_timer_id_fkey FOREIGN KEY (timer_id) REFERENCES public.task_timers(id);


--
-- Name: task_time_spans task_time_spans_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_time_spans
    ADD CONSTRAINT task_time_spans_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);


--
-- Name: task_timers task_timers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_timers
    ADD CONSTRAINT task_timers_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: task_timers task_timers_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_timers
    ADD CONSTRAINT task_timers_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.workshop_tasks(id);


--
-- Name: task_timers task_timers_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_timers
    ADD CONSTRAINT task_timers_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES auth.users(id);


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: vehicle_commitments vehicle_commitments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_commitments
    ADD CONSTRAINT vehicle_commitments_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: vehicle_commitments vehicle_commitments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_commitments
    ADD CONSTRAINT vehicle_commitments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: vehicle_commitments vehicle_commitments_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_commitments
    ADD CONSTRAINT vehicle_commitments_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: vehicle_commitments vehicle_commitments_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_commitments
    ADD CONSTRAINT vehicle_commitments_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: vehicle_files vehicle_files_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_files
    ADD CONSTRAINT vehicle_files_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: vehicle_files vehicle_files_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_files
    ADD CONSTRAINT vehicle_files_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: vehicle_files vehicle_files_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_files
    ADD CONSTRAINT vehicle_files_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: vehicle_files vehicle_files_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_files
    ADD CONSTRAINT vehicle_files_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: vehicles vehicles_owner_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_owner_customer_id_fkey FOREIGN KEY (owner_customer_id) REFERENCES public.customers(id);


--
-- Name: vehicles vehicles_source_workbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_source_workbook_id_fkey FOREIGN KEY (source_workbook_id) REFERENCES public.source_workbooks(id);


--
-- Name: work_orders work_orders_active_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_active_estimate_id_fkey FOREIGN KEY (active_estimate_id) REFERENCES public.estimate_versions(id);


--
-- Name: work_orders work_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: work_orders work_orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: work_orders work_orders_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: workshop_costs workshop_costs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_costs
    ADD CONSTRAINT workshop_costs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: workshop_costs workshop_costs_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_costs
    ADD CONSTRAINT workshop_costs_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimate_versions(id);


--
-- Name: workshop_costs workshop_costs_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_costs
    ADD CONSTRAINT workshop_costs_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id);


--
-- Name: workshop_costs workshop_costs_linked_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_costs
    ADD CONSTRAINT workshop_costs_linked_expense_id_fkey FOREIGN KEY (linked_expense_id) REFERENCES public.expenses(id);


--
-- Name: workshop_costs workshop_costs_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_costs
    ADD CONSTRAINT workshop_costs_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: workshop_costs workshop_costs_stock_dispatch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_costs
    ADD CONSTRAINT workshop_costs_stock_dispatch_id_fkey FOREIGN KEY (stock_dispatch_id) REFERENCES public.stock_movements(id);


--
-- Name: workshop_deliveries workshop_deliveries_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_deliveries
    ADD CONSTRAINT workshop_deliveries_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: workshop_deliveries workshop_deliveries_responsible_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_deliveries
    ADD CONSTRAINT workshop_deliveries_responsible_id_fkey FOREIGN KEY (responsible_id) REFERENCES auth.users(id);


--
-- Name: workshop_inspections workshop_inspections_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_inspections
    ADD CONSTRAINT workshop_inspections_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: workshop_inspections workshop_inspections_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_inspections
    ADD CONSTRAINT workshop_inspections_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: workshop_tariffs workshop_tariffs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_tariffs
    ADD CONSTRAINT workshop_tariffs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: workshop_tasks workshop_tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_tasks
    ADD CONSTRAINT workshop_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES auth.users(id);


--
-- Name: workshop_tasks workshop_tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_tasks
    ADD CONSTRAINT workshop_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: workshop_tasks workshop_tasks_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workshop_tasks
    ADD CONSTRAINT workshop_tasks_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id);


--
-- Name: agent_expense_proposals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_expense_proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_expense_proposals agent_proposal_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_proposal_read ON public.agent_expense_proposals FOR SELECT TO authenticated USING (((actor = auth.uid()) AND public.has_permission('expenses.write'::text)));


--
-- Name: customer_aliases aliases_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY aliases_read ON public.customer_aliases FOR SELECT TO authenticated USING (public.has_permission('customers.read'::text));


--
-- Name: cost_allocations allocation_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY allocation_read ON public.cost_allocations FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: estimate_approvals approval_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY approval_read ON public.estimate_approvals FOR SELECT TO authenticated USING (public.has_permission('expenses.write'::text));


--
-- Name: audit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_events audit_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_read ON public.audit_events FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'owner'::text)))));


--
-- Name: billing_application_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_application_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_credit_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_credit_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_credits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_credits ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_document_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_document_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_credits billing_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_read ON public.billing_credits FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: billing_documents billing_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_read ON public.billing_documents FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: customer_payments billing_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_read ON public.customer_payments FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: payment_applications billing_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_read ON public.payment_applications FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: payment_refunds billing_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_read ON public.payment_refunds FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: budget_expense_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_expense_links ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_purchase_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_purchase_links ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_entries cash_entry_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cash_entry_read ON public.cash_entries FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: cost_centers centers_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY centers_read ON public.cost_centers FOR SELECT TO authenticated USING (public.has_permission('expenses.write'::text));


--
-- Name: commission_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_eligibility; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_eligibility ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicle_commitments commitment_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY commitment_read ON public.vehicle_commitments FOR SELECT TO authenticated USING (public.has_permission('vehicles.read'::text));


--
-- Name: contract_acceptances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contract_acceptances ENABLE ROW LEVEL SECURITY;

--
-- Name: cost_allocations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cost_allocations ENABLE ROW LEVEL SECURITY;

--
-- Name: cost_centers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cost_centers ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_aliases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_aliases ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_documents customer_document_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY customer_document_read ON public.customer_documents FOR SELECT TO authenticated USING (public.has_permission('customers.write'::text));


--
-- Name: customer_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: customers customers_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY customers_read ON public.customers FOR SELECT TO authenticated USING (public.has_permission('customers.read'::text));


--
-- Name: workshop_deliveries delivery_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_read ON public.workshop_deliveries FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: estimate_approvals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimate_approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: estimate_documents estimate_document_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY estimate_document_read ON public.estimate_documents FOR SELECT TO authenticated USING (public.has_permission('orders.read'::text));


--
-- Name: estimate_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimate_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: estimate_versions estimate_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY estimate_read ON public.estimate_versions FOR SELECT TO authenticated USING (public.has_permission('expenses.write'::text));


--
-- Name: estimate_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimate_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_import_origins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_import_origins ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_import_rows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_import_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_imports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_imports ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses expenses_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expenses_read ON public.expenses FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: billing_application_lines grouped_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY grouped_read ON public.billing_application_lines FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: billing_credit_lines grouped_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY grouped_read ON public.billing_credit_lines FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: billing_document_lines grouped_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY grouped_read ON public.billing_document_lines FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: expense_import_origins import_origins_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_origins_read ON public.expense_import_origins FOR SELECT TO authenticated USING ((public.has_permission('expenses.write'::text) AND public.has_permission('expenses.read'::text)));


--
-- Name: expense_imports import_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_read ON public.expense_imports FOR SELECT TO authenticated USING ((public.has_permission('expenses.write'::text) AND public.has_permission('expenses.read'::text)));


--
-- Name: expense_import_rows import_rows_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_rows_read ON public.expense_import_rows FOR SELECT TO authenticated USING ((public.has_permission('expenses.write'::text) AND public.has_permission('expenses.read'::text)));


--
-- Name: rental_inspections inspection_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY inspection_read ON public.rental_inspections FOR SELECT TO authenticated USING (public.has_permission('orders.read'::text));


--
-- Name: workshop_inspections intake_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intake_read ON public.workshop_inspections FOR SELECT TO authenticated USING (public.has_permission('orders.read'::text));


--
-- Name: integration_inbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_inbox ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_orders inventory_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY inventory_read ON public.purchase_orders FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: stock_items inventory_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY inventory_read ON public.stock_items FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: stock_movements inventory_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY inventory_read ON public.stock_movements FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: supplier_obligations inventory_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY inventory_read ON public.supplier_obligations FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: commission_bindings management_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY management_read ON public.commission_bindings FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: commission_eligibility management_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY management_read ON public.commission_eligibility FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: commission_entries management_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY management_read ON public.commission_entries FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: commission_rules management_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY management_read ON public.commission_rules FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: contract_acceptances management_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY management_read ON public.contract_acceptances FOR SELECT TO authenticated USING (public.has_permission('orders.read'::text));


--
-- Name: rental_contracts management_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY management_read ON public.rental_contracts FOR SELECT TO authenticated USING (public.has_permission('orders.read'::text));


--
-- Name: operating_budgets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.operating_budgets ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_expense_links optional_module_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY optional_module_read ON public.budget_expense_links FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'owner'::text)))));


--
-- Name: budget_purchase_links optional_module_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY optional_module_read ON public.budget_purchase_links FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'owner'::text)))));


--
-- Name: integration_inbox optional_module_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY optional_module_read ON public.integration_inbox FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'owner'::text)))));


--
-- Name: operating_budgets optional_module_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY optional_module_read ON public.operating_budgets FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'owner'::text)))));


--
-- Name: work_orders orders_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_read ON public.work_orders FOR SELECT TO authenticated USING (public.has_permission('orders.read'::text));


--
-- Name: user_roles own_roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_roles ON public.user_roles FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: payment_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_applications ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_import_origins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_import_origins ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_imports payment_import_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payment_import_read ON public.payment_imports FOR SELECT TO authenticated USING (public.has_permission('expenses.write'::text));


--
-- Name: payment_imports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_imports ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_import_origins payment_origin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payment_origin_read ON public.payment_import_origins FOR SELECT TO authenticated USING (public.has_permission('expenses.write'::text));


--
-- Name: payment_refunds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_refunds ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_periods period_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY period_read ON public.rental_periods FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: purchase_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: receipt_operation_contexts receipt_context_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY receipt_context_read ON public.receipt_operation_contexts FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: receipt_operation_contexts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.receipt_operation_contexts ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_contracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rental_contracts ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_extra_proposals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rental_extra_proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_extra_proposals rental_extra_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rental_extra_read ON public.rental_extra_proposals FOR SELECT TO authenticated USING (public.has_permission('orders.read'::text));


--
-- Name: rental_inspections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rental_inspections ENABLE ROW LEVEL SECURITY;

--
-- Name: rental_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rental_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: report_outbox report_delivery_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY report_delivery_read ON public.report_outbox FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'owner'::text)))));


--
-- Name: report_schedules report_delivery_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY report_delivery_read ON public.report_schedules FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'owner'::text)))));


--
-- Name: report_outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.report_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: report_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: reservation_evidence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reservation_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: reservation_evidence reservation_evidence_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reservation_evidence_read ON public.reservation_evidence FOR SELECT TO authenticated USING (public.has_permission('orders.read'::text));


--
-- Name: reservations reservation_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reservation_read ON public.reservations FOR SELECT TO authenticated USING (public.has_permission('orders.read'::text));


--
-- Name: reservations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: source_workbook_items source_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_read ON public.source_workbook_items FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: source_workbooks source_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_read ON public.source_workbooks FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: source_workbook_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_workbook_items ENABLE ROW LEVEL SECURITY;

--
-- Name: source_workbooks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_workbooks ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_obligations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supplier_obligations ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_tariffs tariff_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tariff_read ON public.workshop_tariffs FOR SELECT TO authenticated USING (public.has_permission('expenses.write'::text));


--
-- Name: workshop_tasks task_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY task_read ON public.workshop_tasks FOR SELECT TO authenticated USING ((public.has_permission('orders.read'::text) OR ((assigned_to = auth.uid()) AND public.has_task_access())));


--
-- Name: task_time_spans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task_time_spans ENABLE ROW LEVEL SECURITY;

--
-- Name: task_timers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task_timers ENABLE ROW LEVEL SECURITY;

--
-- Name: task_time_spans time_span_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY time_span_read ON public.task_time_spans FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.task_timers timer
  WHERE (timer.id = task_time_spans.timer_id))));


--
-- Name: task_timers timer_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY timer_read ON public.task_timers FOR SELECT TO authenticated USING ((public.has_permission('orders.read'::text) OR ((worker_id = auth.uid()) AND public.has_task_access())));


--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicle_commitments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vehicle_commitments ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicle_files vehicle_file_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vehicle_file_read ON public.vehicle_files FOR SELECT TO authenticated USING ((public.has_permission('vehicles.read'::text) AND ((NOT financial) OR public.has_permission('expenses.read'::text))));


--
-- Name: vehicle_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vehicle_files ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicles vehicles_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vehicles_read ON public.vehicles FOR SELECT TO authenticated USING (public.has_permission('vehicles.read'::text));


--
-- Name: work_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.work_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_costs workshop_cost_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workshop_cost_read ON public.workshop_costs FOR SELECT TO authenticated USING (public.has_permission('expenses.read'::text));


--
-- Name: workshop_costs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workshop_costs ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workshop_deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_inspections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workshop_inspections ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_tariffs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workshop_tariffs ENABLE ROW LEVEL SECURITY;

--
-- Name: workshop_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workshop_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION gbtreekey16_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey16_in(cstring) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey16_in(cstring) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey16_in(cstring) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey16_in(cstring) TO service_role;


--
-- Name: FUNCTION gbtreekey16_out(public.gbtreekey16); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey16_out(public.gbtreekey16) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey16_out(public.gbtreekey16) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey16_out(public.gbtreekey16) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey16_out(public.gbtreekey16) TO service_role;


--
-- Name: FUNCTION gbtreekey2_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey2_in(cstring) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey2_in(cstring) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey2_in(cstring) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey2_in(cstring) TO service_role;


--
-- Name: FUNCTION gbtreekey2_out(public.gbtreekey2); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey2_out(public.gbtreekey2) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey2_out(public.gbtreekey2) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey2_out(public.gbtreekey2) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey2_out(public.gbtreekey2) TO service_role;


--
-- Name: FUNCTION gbtreekey32_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey32_in(cstring) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey32_in(cstring) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey32_in(cstring) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey32_in(cstring) TO service_role;


--
-- Name: FUNCTION gbtreekey32_out(public.gbtreekey32); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey32_out(public.gbtreekey32) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey32_out(public.gbtreekey32) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey32_out(public.gbtreekey32) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey32_out(public.gbtreekey32) TO service_role;


--
-- Name: FUNCTION gbtreekey4_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey4_in(cstring) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey4_in(cstring) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey4_in(cstring) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey4_in(cstring) TO service_role;


--
-- Name: FUNCTION gbtreekey4_out(public.gbtreekey4); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey4_out(public.gbtreekey4) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey4_out(public.gbtreekey4) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey4_out(public.gbtreekey4) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey4_out(public.gbtreekey4) TO service_role;


--
-- Name: FUNCTION gbtreekey8_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey8_in(cstring) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey8_in(cstring) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey8_in(cstring) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey8_in(cstring) TO service_role;


--
-- Name: FUNCTION gbtreekey8_out(public.gbtreekey8); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey8_out(public.gbtreekey8) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey8_out(public.gbtreekey8) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey8_out(public.gbtreekey8) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey8_out(public.gbtreekey8) TO service_role;


--
-- Name: FUNCTION gbtreekey_var_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey_var_in(cstring) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey_var_in(cstring) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey_var_in(cstring) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey_var_in(cstring) TO service_role;


--
-- Name: FUNCTION gbtreekey_var_out(public.gbtreekey_var); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey_var_out(public.gbtreekey_var) TO postgres;
GRANT ALL ON FUNCTION public.gbtreekey_var_out(public.gbtreekey_var) TO anon;
GRANT ALL ON FUNCTION public.gbtreekey_var_out(public.gbtreekey_var) TO authenticated;
GRANT ALL ON FUNCTION public.gbtreekey_var_out(public.gbtreekey_var) TO service_role;


--
-- Name: FUNCTION allocate_document_event(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.allocate_document_event() FROM PUBLIC;


--
-- Name: FUNCTION audit_change(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.audit_change() FROM PUBLIC;


--
-- Name: FUNCTION billing_command_before_grouped(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.billing_command_before_grouped(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION private.billing_command_before_grouped(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION business_command_before_cases(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.business_command_before_cases(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION private.business_command_before_cases(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION calculate_estimate(lines jsonb, method text, ratio numeric, discount numeric); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.calculate_estimate(lines jsonb, method text, ratio numeric, discount numeric) FROM PUBLIC;


--
-- Name: FUNCTION canonical_customer(id uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.canonical_customer(id uuid) FROM PUBLIC;


--
-- Name: FUNCTION capture_oct30_function(signature text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.capture_oct30_function(signature text) FROM PUBLIC;


--
-- Name: FUNCTION capture_refund_account(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.capture_refund_account() FROM PUBLIC;


--
-- Name: FUNCTION cash_diary_before_connected_money(from_date date, to_date date, account_filter text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.cash_diary_before_connected_money(from_date date, to_date date, account_filter text) FROM PUBLIC;


--
-- Name: FUNCTION cash_operation_links(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.cash_operation_links() FROM PUBLIC;


--
-- Name: FUNCTION check_cost_allocation_net(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.check_cost_allocation_net() FROM PUBLIC;


--
-- Name: FUNCTION contract_winansi_hex(value text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.contract_winansi_hex(value text) FROM PUBLIC;


--
-- Name: FUNCTION delivery_checklist(order_id text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.delivery_checklist(order_id text) FROM PUBLIC;


--
-- Name: FUNCTION delivery_checklist_before_billing(order_id text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.delivery_checklist_before_billing(order_id text) FROM PUBLIC;


--
-- Name: FUNCTION delivery_checklist_before_cases(order_id text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.delivery_checklist_before_cases(order_id text) FROM PUBLIC;


--
-- Name: FUNCTION diary_sources(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.diary_sources() FROM PUBLIC;


--
-- Name: FUNCTION document_balance(document_id uuid, cutoff date); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.document_balance(document_id uuid, cutoff date) FROM PUBLIC;


--
-- Name: FUNCTION document_line_balance(line_id uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.document_line_balance(line_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION expense_import_summary(batch_id uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.expense_import_summary(batch_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION expense_to_workshop_cost(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.expense_to_workshop_cost() FROM PUBLIC;


--
-- Name: FUNCTION immutable_quote_record(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.immutable_quote_record() FROM PUBLIC;


--
-- Name: FUNCTION import_fingerprint(p jsonb); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.import_fingerprint(p jsonb) FROM PUBLIC;


--
-- Name: FUNCTION link_workshop_expense(source_expense_id text, allocations jsonb, reason text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.link_workshop_expense(source_expense_id text, allocations jsonb, reason text) FROM PUBLIC;


--
-- Name: FUNCTION merge_reservation_identity(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.merge_reservation_identity() FROM PUBLIC;


--
-- Name: FUNCTION normalize_import_expense(raw jsonb, mapping jsonb); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.normalize_import_expense(raw jsonb, mapping jsonb) FROM PUBLIC;


--
-- Name: FUNCTION normalize_import_payment(raw jsonb, mapping jsonb); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.normalize_import_payment(raw jsonb, mapping jsonb) FROM PUBLIC;


--
-- Name: TABLE payment_imports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_imports TO service_role;
GRANT SELECT ON TABLE public.payment_imports TO authenticated;


--
-- Name: FUNCTION payment_import_preview(batch public.payment_imports); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.payment_import_preview(batch public.payment_imports) FROM PUBLIC;


--
-- Name: FUNCTION receipt_available(payment_id uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.receipt_available(payment_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION receive_estimated_work(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.receive_estimated_work() FROM PUBLIC;


--
-- Name: TABLE rental_contracts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rental_contracts TO service_role;
GRANT SELECT ON TABLE public.rental_contracts TO authenticated;


--
-- Name: FUNCTION render_contract_pdf(contract public.rental_contracts); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.render_contract_pdf(contract public.rental_contracts) FROM PUBLIC;


--
-- Name: FUNCTION rental_actual_dates(records jsonb); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.rental_actual_dates(records jsonb) FROM PUBLIC;


--
-- Name: FUNCTION rental_case_file_before_connected_money(reservation_id uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.rental_case_file_before_connected_money(reservation_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION report_delivery_command_core(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.report_delivery_command_core(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION private.report_delivery_command_core(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION require_import_permission(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.require_import_permission() FROM PUBLIC;


--
-- Name: FUNCTION reservation_command_before_cleaning_review(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.reservation_command_before_cleaning_review(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION private.reservation_command_before_cleaning_review(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION reservation_command_before_fit(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.reservation_command_before_fit(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION private.reservation_command_before_fit(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION reservation_command_before_review(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.reservation_command_before_review(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION private.reservation_command_before_review(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION reservation_credit_sources(reservation_id uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.reservation_credit_sources(reservation_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION reservation_document_sources(reservation_id uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.reservation_document_sources(reservation_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION reservation_payment_sources(reservation_id uuid); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.reservation_payment_sources(reservation_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION task_timer_guard(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.task_timer_guard() FROM PUBLIC;


--
-- Name: TABLE expense_imports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expense_imports TO service_role;
GRANT SELECT ON TABLE public.expense_imports TO authenticated;


--
-- Name: FUNCTION validate_expense_import_rows(batch public.expense_imports); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.validate_expense_import_rows(batch public.expense_imports) FROM PUBLIC;


--
-- Name: FUNCTION vehicle_application_sources(vehicle_id uuid, order_id text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.vehicle_application_sources(vehicle_id uuid, order_id text) FROM PUBLIC;


--
-- Name: FUNCTION vehicle_case_file_before_connected_money(vehicle_id uuid, order_id text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.vehicle_case_file_before_connected_money(vehicle_id uuid, order_id text) FROM PUBLIC;


--
-- Name: FUNCTION vehicle_credit_sources(vehicle_id uuid, order_id text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.vehicle_credit_sources(vehicle_id uuid, order_id text) FROM PUBLIC;


--
-- Name: FUNCTION vehicle_document_sources(vehicle_id uuid, order_id text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.vehicle_document_sources(vehicle_id uuid, order_id text) FROM PUBLIC;


--
-- Name: FUNCTION workshop_commitment(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.workshop_commitment() FROM PUBLIC;


--
-- Name: FUNCTION administration_users(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.administration_users() FROM PUBLIC;
GRANT ALL ON FUNCTION public.administration_users() TO authenticated;
GRANT ALL ON FUNCTION public.administration_users() TO service_role;


--
-- Name: FUNCTION agent_vehicle_cost(vehicle_ref text, order_ref text, cutoff date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_vehicle_cost(vehicle_ref text, order_ref text, cutoff date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_vehicle_cost(vehicle_ref text, order_ref text, cutoff date) TO authenticated;
GRANT ALL ON FUNCTION public.agent_vehicle_cost(vehicle_ref text, order_ref text, cutoff date) TO service_role;


--
-- Name: FUNCTION billing_line_positions(document_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_line_positions(document_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_line_positions(document_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.billing_line_positions(document_id uuid) TO service_role;


--
-- Name: FUNCTION budget_position(budget_id uuid, cutoff date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.budget_position(budget_id uuid, cutoff date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.budget_position(budget_id uuid, cutoff date) TO authenticated;
GRANT ALL ON FUNCTION public.budget_position(budget_id uuid, cutoff date) TO service_role;


--
-- Name: FUNCTION calculate_estimate(lines jsonb, method text, ratio numeric, discount numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.calculate_estimate(lines jsonb, method text, ratio numeric, discount numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.calculate_estimate(lines jsonb, method text, ratio numeric, discount numeric) TO authenticated;
GRANT ALL ON FUNCTION public.calculate_estimate(lines jsonb, method text, ratio numeric, discount numeric) TO service_role;


--
-- Name: FUNCTION cash_diary(from_date date, to_date date, account_filter text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_diary(from_date date, to_date date, account_filter text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_diary(from_date date, to_date date, account_filter text) TO authenticated;
GRANT ALL ON FUNCTION public.cash_diary(from_date date, to_date date, account_filter text) TO service_role;


--
-- Name: FUNCTION cash_dist(money, money); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cash_dist(money, money) TO postgres;
GRANT ALL ON FUNCTION public.cash_dist(money, money) TO anon;
GRANT ALL ON FUNCTION public.cash_dist(money, money) TO authenticated;
GRANT ALL ON FUNCTION public.cash_dist(money, money) TO service_role;


--
-- Name: FUNCTION collect_document(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.collect_document(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.collect_document(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.collect_document(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION commit_expense_import(batch_id uuid, expected_version integer, expected_new_total numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.commit_expense_import(batch_id uuid, expected_version integer, expected_new_total numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.commit_expense_import(batch_id uuid, expected_version integer, expected_new_total numeric) TO authenticated;
GRANT ALL ON FUNCTION public.commit_expense_import(batch_id uuid, expected_version integer, expected_new_total numeric) TO service_role;


--
-- Name: FUNCTION confirm_agent_expense(proposal_id uuid, expected_hash text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.confirm_agent_expense(proposal_id uuid, expected_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_agent_expense(proposal_id uuid, expected_hash text) TO authenticated;
GRANT ALL ON FUNCTION public.confirm_agent_expense(proposal_id uuid, expected_hash text) TO service_role;


--
-- Name: FUNCTION contract_pdf(contract_id uuid, pdf_base64 text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.contract_pdf(contract_id uuid, pdf_base64 text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.contract_pdf(contract_id uuid, pdf_base64 text) TO authenticated;
GRANT ALL ON FUNCTION public.contract_pdf(contract_id uuid, pdf_base64 text) TO service_role;


--
-- Name: FUNCTION customer_document_content(file_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_document_content(file_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_document_content(file_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.customer_document_content(file_id uuid) TO service_role;


--
-- Name: FUNCTION customer_document_list(customer_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_document_list(customer_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_document_list(customer_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.customer_document_list(customer_id uuid) TO service_role;


--
-- Name: TABLE customers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customers TO service_role;
GRANT SELECT ON TABLE public.customers TO authenticated;


--
-- Name: FUNCTION customer_matches(phone text, document text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_matches(phone text, document text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_matches(phone text, document text) TO authenticated;
GRANT ALL ON FUNCTION public.customer_matches(phone text, document text) TO service_role;


--
-- Name: FUNCTION date_dist(date, date); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.date_dist(date, date) TO postgres;
GRANT ALL ON FUNCTION public.date_dist(date, date) TO anon;
GRANT ALL ON FUNCTION public.date_dist(date, date) TO authenticated;
GRANT ALL ON FUNCTION public.date_dist(date, date) TO service_role;


--
-- Name: FUNCTION deliver_workshop_order(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.deliver_workshop_order(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.deliver_workshop_order(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.deliver_workshop_order(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION estimate_pdf(estimate_id uuid, expected_status text, pdf_base64 text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.estimate_pdf(estimate_id uuid, expected_status text, pdf_base64 text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.estimate_pdf(estimate_id uuid, expected_status text, pdf_base64 text) TO authenticated;
GRANT ALL ON FUNCTION public.estimate_pdf(estimate_id uuid, expected_status text, pdf_base64 text) TO service_role;


--
-- Name: FUNCTION execute_administration_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_administration_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_administration_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_administration_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_billing_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_billing_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_billing_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_billing_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_case_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_case_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_case_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_case_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_commission_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_commission_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_commission_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_commission_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_contract_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_contract_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_contract_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_contract_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_cost_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_cost_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_cost_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_cost_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_delivery_cost_adjustment(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_delivery_cost_adjustment(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_delivery_cost_adjustment(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_delivery_cost_adjustment(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_estimate_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_estimate_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_estimate_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_estimate_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_inventory_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_inventory_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_inventory_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_inventory_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_optional_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_optional_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_optional_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_optional_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_payment_import(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_payment_import(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_payment_import(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_payment_import(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_rental_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_rental_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_rental_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_rental_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_report_delivery_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_report_delivery_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_report_delivery_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_report_delivery_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_reservation_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_reservation_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_reservation_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_reservation_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_task_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_task_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_task_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_task_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION execute_time_command(command text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_time_command(command text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_time_command(command text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.execute_time_command(command text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION expense_import_original(batch_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.expense_import_original(batch_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.expense_import_original(batch_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.expense_import_original(batch_id uuid) TO service_role;


--
-- Name: FUNCTION float4_dist(real, real); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.float4_dist(real, real) TO postgres;
GRANT ALL ON FUNCTION public.float4_dist(real, real) TO anon;
GRANT ALL ON FUNCTION public.float4_dist(real, real) TO authenticated;
GRANT ALL ON FUNCTION public.float4_dist(real, real) TO service_role;


--
-- Name: FUNCTION float8_dist(double precision, double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.float8_dist(double precision, double precision) TO postgres;
GRANT ALL ON FUNCTION public.float8_dist(double precision, double precision) TO anon;
GRANT ALL ON FUNCTION public.float8_dist(double precision, double precision) TO authenticated;
GRANT ALL ON FUNCTION public.float8_dist(double precision, double precision) TO service_role;


--
-- Name: FUNCTION gbt_bit_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bit_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bit_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bit_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_bit_consistent(internal, bit, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_consistent(internal, bit, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bit_consistent(internal, bit, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bit_consistent(internal, bit, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bit_consistent(internal, bit, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_bit_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bit_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bit_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bit_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_bit_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bit_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bit_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bit_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_bit_same(public.gbtreekey_var, public.gbtreekey_var, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bit_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bit_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bit_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO service_role;


--
-- Name: FUNCTION gbt_bit_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bit_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bit_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bit_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_bool_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bool_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bool_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bool_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_bool_consistent(internal, boolean, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_consistent(internal, boolean, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bool_consistent(internal, boolean, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bool_consistent(internal, boolean, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bool_consistent(internal, boolean, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_bool_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bool_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bool_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bool_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_bool_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bool_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bool_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bool_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_bool_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bool_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bool_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bool_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_bool_same(public.gbtreekey2, public.gbtreekey2, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_same(public.gbtreekey2, public.gbtreekey2, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bool_same(public.gbtreekey2, public.gbtreekey2, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bool_same(public.gbtreekey2, public.gbtreekey2, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bool_same(public.gbtreekey2, public.gbtreekey2, internal) TO service_role;


--
-- Name: FUNCTION gbt_bool_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bool_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bool_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bool_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_bpchar_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bpchar_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bpchar_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bpchar_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bpchar_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_bpchar_consistent(internal, character, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bpchar_consistent(internal, character, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bpchar_consistent(internal, character, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bpchar_consistent(internal, character, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bpchar_consistent(internal, character, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_bytea_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bytea_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bytea_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bytea_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_bytea_consistent(internal, bytea, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_consistent(internal, bytea, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bytea_consistent(internal, bytea, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bytea_consistent(internal, bytea, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bytea_consistent(internal, bytea, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_bytea_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bytea_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bytea_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bytea_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_bytea_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bytea_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bytea_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bytea_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_bytea_same(public.gbtreekey_var, public.gbtreekey_var, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bytea_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bytea_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bytea_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO service_role;


--
-- Name: FUNCTION gbt_bytea_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_bytea_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_bytea_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_bytea_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_cash_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_cash_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_cash_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_cash_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_cash_consistent(internal, money, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_consistent(internal, money, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_cash_consistent(internal, money, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_cash_consistent(internal, money, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_cash_consistent(internal, money, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_cash_distance(internal, money, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_distance(internal, money, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_cash_distance(internal, money, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_cash_distance(internal, money, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_cash_distance(internal, money, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_cash_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_cash_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_cash_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_cash_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_cash_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_cash_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_cash_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_cash_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_cash_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_cash_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_cash_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_cash_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_cash_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_same(public.gbtreekey16, public.gbtreekey16, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_cash_same(public.gbtreekey16, public.gbtreekey16, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_cash_same(public.gbtreekey16, public.gbtreekey16, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_cash_same(public.gbtreekey16, public.gbtreekey16, internal) TO service_role;


--
-- Name: FUNCTION gbt_cash_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_cash_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_cash_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_cash_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_date_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_date_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_date_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_date_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_date_consistent(internal, date, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_consistent(internal, date, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_date_consistent(internal, date, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_date_consistent(internal, date, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_date_consistent(internal, date, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_date_distance(internal, date, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_distance(internal, date, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_date_distance(internal, date, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_date_distance(internal, date, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_date_distance(internal, date, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_date_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_date_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_date_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_date_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_date_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_date_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_date_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_date_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_date_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_date_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_date_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_date_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_date_same(public.gbtreekey8, public.gbtreekey8, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_same(public.gbtreekey8, public.gbtreekey8, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_date_same(public.gbtreekey8, public.gbtreekey8, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_date_same(public.gbtreekey8, public.gbtreekey8, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_date_same(public.gbtreekey8, public.gbtreekey8, internal) TO service_role;


--
-- Name: FUNCTION gbt_date_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_date_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_date_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_date_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_decompress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_decompress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_decompress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_decompress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_decompress(internal) TO service_role;


--
-- Name: FUNCTION gbt_enum_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_enum_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_enum_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_enum_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_enum_consistent(internal, anyenum, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_consistent(internal, anyenum, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_enum_consistent(internal, anyenum, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_enum_consistent(internal, anyenum, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_enum_consistent(internal, anyenum, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_enum_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_enum_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_enum_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_enum_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_enum_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_enum_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_enum_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_enum_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_enum_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_enum_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_enum_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_enum_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_enum_same(public.gbtreekey8, public.gbtreekey8, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_same(public.gbtreekey8, public.gbtreekey8, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_enum_same(public.gbtreekey8, public.gbtreekey8, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_enum_same(public.gbtreekey8, public.gbtreekey8, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_enum_same(public.gbtreekey8, public.gbtreekey8, internal) TO service_role;


--
-- Name: FUNCTION gbt_enum_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_enum_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_enum_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_enum_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_float4_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float4_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float4_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float4_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_float4_consistent(internal, real, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_consistent(internal, real, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float4_consistent(internal, real, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float4_consistent(internal, real, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float4_consistent(internal, real, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_float4_distance(internal, real, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_distance(internal, real, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float4_distance(internal, real, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float4_distance(internal, real, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float4_distance(internal, real, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_float4_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float4_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float4_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float4_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_float4_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float4_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float4_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float4_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_float4_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float4_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float4_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float4_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_float4_same(public.gbtreekey8, public.gbtreekey8, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_same(public.gbtreekey8, public.gbtreekey8, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float4_same(public.gbtreekey8, public.gbtreekey8, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float4_same(public.gbtreekey8, public.gbtreekey8, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float4_same(public.gbtreekey8, public.gbtreekey8, internal) TO service_role;


--
-- Name: FUNCTION gbt_float4_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float4_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float4_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float4_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_float8_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float8_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float8_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float8_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_float8_consistent(internal, double precision, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_consistent(internal, double precision, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float8_consistent(internal, double precision, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float8_consistent(internal, double precision, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float8_consistent(internal, double precision, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_float8_distance(internal, double precision, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_distance(internal, double precision, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float8_distance(internal, double precision, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float8_distance(internal, double precision, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float8_distance(internal, double precision, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_float8_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float8_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float8_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float8_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_float8_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float8_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float8_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float8_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_float8_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float8_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float8_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float8_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_float8_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_same(public.gbtreekey16, public.gbtreekey16, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float8_same(public.gbtreekey16, public.gbtreekey16, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float8_same(public.gbtreekey16, public.gbtreekey16, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float8_same(public.gbtreekey16, public.gbtreekey16, internal) TO service_role;


--
-- Name: FUNCTION gbt_float8_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_float8_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_float8_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_float8_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_inet_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_inet_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_inet_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_inet_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_inet_consistent(internal, inet, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_consistent(internal, inet, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_inet_consistent(internal, inet, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_inet_consistent(internal, inet, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_inet_consistent(internal, inet, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_inet_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_inet_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_inet_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_inet_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_inet_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_inet_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_inet_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_inet_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_inet_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_same(public.gbtreekey16, public.gbtreekey16, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_inet_same(public.gbtreekey16, public.gbtreekey16, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_inet_same(public.gbtreekey16, public.gbtreekey16, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_inet_same(public.gbtreekey16, public.gbtreekey16, internal) TO service_role;


--
-- Name: FUNCTION gbt_inet_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_inet_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_inet_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_inet_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_int2_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int2_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int2_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int2_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_int2_consistent(internal, smallint, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_consistent(internal, smallint, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int2_consistent(internal, smallint, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int2_consistent(internal, smallint, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int2_consistent(internal, smallint, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_int2_distance(internal, smallint, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_distance(internal, smallint, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int2_distance(internal, smallint, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int2_distance(internal, smallint, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int2_distance(internal, smallint, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_int2_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int2_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int2_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int2_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_int2_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int2_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int2_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int2_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_int2_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int2_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int2_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int2_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_int2_same(public.gbtreekey4, public.gbtreekey4, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_same(public.gbtreekey4, public.gbtreekey4, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int2_same(public.gbtreekey4, public.gbtreekey4, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int2_same(public.gbtreekey4, public.gbtreekey4, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int2_same(public.gbtreekey4, public.gbtreekey4, internal) TO service_role;


--
-- Name: FUNCTION gbt_int2_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int2_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int2_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int2_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_int4_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int4_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int4_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int4_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_int4_consistent(internal, integer, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_consistent(internal, integer, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int4_consistent(internal, integer, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int4_consistent(internal, integer, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int4_consistent(internal, integer, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_int4_distance(internal, integer, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_distance(internal, integer, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int4_distance(internal, integer, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int4_distance(internal, integer, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int4_distance(internal, integer, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_int4_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int4_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int4_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int4_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_int4_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int4_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int4_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int4_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_int4_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int4_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int4_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int4_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_int4_same(public.gbtreekey8, public.gbtreekey8, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_same(public.gbtreekey8, public.gbtreekey8, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int4_same(public.gbtreekey8, public.gbtreekey8, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int4_same(public.gbtreekey8, public.gbtreekey8, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int4_same(public.gbtreekey8, public.gbtreekey8, internal) TO service_role;


--
-- Name: FUNCTION gbt_int4_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int4_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int4_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int4_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_int8_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int8_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int8_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int8_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_int8_consistent(internal, bigint, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_consistent(internal, bigint, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int8_consistent(internal, bigint, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int8_consistent(internal, bigint, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int8_consistent(internal, bigint, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_int8_distance(internal, bigint, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_distance(internal, bigint, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int8_distance(internal, bigint, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int8_distance(internal, bigint, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int8_distance(internal, bigint, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_int8_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int8_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int8_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int8_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_int8_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int8_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int8_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int8_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_int8_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int8_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int8_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int8_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_int8_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_same(public.gbtreekey16, public.gbtreekey16, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int8_same(public.gbtreekey16, public.gbtreekey16, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int8_same(public.gbtreekey16, public.gbtreekey16, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int8_same(public.gbtreekey16, public.gbtreekey16, internal) TO service_role;


--
-- Name: FUNCTION gbt_int8_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_int8_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_int8_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_int8_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_intv_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_intv_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_intv_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_intv_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_intv_consistent(internal, interval, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_consistent(internal, interval, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_intv_consistent(internal, interval, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_intv_consistent(internal, interval, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_intv_consistent(internal, interval, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_intv_decompress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_decompress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_intv_decompress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_intv_decompress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_intv_decompress(internal) TO service_role;


--
-- Name: FUNCTION gbt_intv_distance(internal, interval, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_distance(internal, interval, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_intv_distance(internal, interval, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_intv_distance(internal, interval, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_intv_distance(internal, interval, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_intv_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_intv_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_intv_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_intv_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_intv_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_intv_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_intv_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_intv_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_intv_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_intv_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_intv_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_intv_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_intv_same(public.gbtreekey32, public.gbtreekey32, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_same(public.gbtreekey32, public.gbtreekey32, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_intv_same(public.gbtreekey32, public.gbtreekey32, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_intv_same(public.gbtreekey32, public.gbtreekey32, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_intv_same(public.gbtreekey32, public.gbtreekey32, internal) TO service_role;


--
-- Name: FUNCTION gbt_intv_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_intv_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_intv_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_intv_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_macad8_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad8_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad8_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad8_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_macad8_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad8_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad8_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad8_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_macad8_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad8_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad8_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad8_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_macad8_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad8_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad8_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad8_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_macad8_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_same(public.gbtreekey16, public.gbtreekey16, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad8_same(public.gbtreekey16, public.gbtreekey16, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad8_same(public.gbtreekey16, public.gbtreekey16, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad8_same(public.gbtreekey16, public.gbtreekey16, internal) TO service_role;


--
-- Name: FUNCTION gbt_macad8_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad8_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad8_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad8_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_macad_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_macad_consistent(internal, macaddr, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_consistent(internal, macaddr, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad_consistent(internal, macaddr, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad_consistent(internal, macaddr, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad_consistent(internal, macaddr, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_macad_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_macad_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_macad_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_macad_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_same(public.gbtreekey16, public.gbtreekey16, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad_same(public.gbtreekey16, public.gbtreekey16, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad_same(public.gbtreekey16, public.gbtreekey16, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad_same(public.gbtreekey16, public.gbtreekey16, internal) TO service_role;


--
-- Name: FUNCTION gbt_macad_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_macad_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_macad_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_macad_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_numeric_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_numeric_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_numeric_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_numeric_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_numeric_consistent(internal, numeric, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_consistent(internal, numeric, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_numeric_consistent(internal, numeric, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_numeric_consistent(internal, numeric, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_numeric_consistent(internal, numeric, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_numeric_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_numeric_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_numeric_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_numeric_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_numeric_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_numeric_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_numeric_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_numeric_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_numeric_same(public.gbtreekey_var, public.gbtreekey_var, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_numeric_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_numeric_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_numeric_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO service_role;


--
-- Name: FUNCTION gbt_numeric_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_numeric_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_numeric_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_numeric_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_oid_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_oid_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_oid_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_oid_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_oid_consistent(internal, oid, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_consistent(internal, oid, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_oid_consistent(internal, oid, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_oid_consistent(internal, oid, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_oid_consistent(internal, oid, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_oid_distance(internal, oid, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_distance(internal, oid, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_oid_distance(internal, oid, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_oid_distance(internal, oid, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_oid_distance(internal, oid, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_oid_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_oid_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_oid_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_oid_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_oid_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_oid_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_oid_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_oid_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_oid_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_oid_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_oid_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_oid_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_oid_same(public.gbtreekey8, public.gbtreekey8, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_same(public.gbtreekey8, public.gbtreekey8, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_oid_same(public.gbtreekey8, public.gbtreekey8, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_oid_same(public.gbtreekey8, public.gbtreekey8, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_oid_same(public.gbtreekey8, public.gbtreekey8, internal) TO service_role;


--
-- Name: FUNCTION gbt_oid_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_oid_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_oid_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_oid_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_text_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_text_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_text_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_text_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_text_consistent(internal, text, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_consistent(internal, text, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_text_consistent(internal, text, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_text_consistent(internal, text, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_text_consistent(internal, text, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_text_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_text_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_text_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_text_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_text_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_text_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_text_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_text_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_text_same(public.gbtreekey_var, public.gbtreekey_var, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_text_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_text_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_text_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO service_role;


--
-- Name: FUNCTION gbt_text_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_text_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_text_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_text_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_time_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_time_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_time_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_time_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_time_consistent(internal, time without time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_consistent(internal, time without time zone, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_time_consistent(internal, time without time zone, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_time_consistent(internal, time without time zone, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_time_consistent(internal, time without time zone, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_time_distance(internal, time without time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_distance(internal, time without time zone, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_time_distance(internal, time without time zone, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_time_distance(internal, time without time zone, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_time_distance(internal, time without time zone, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_time_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_time_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_time_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_time_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_time_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_time_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_time_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_time_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_time_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_time_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_time_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_time_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_time_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_same(public.gbtreekey16, public.gbtreekey16, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_time_same(public.gbtreekey16, public.gbtreekey16, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_time_same(public.gbtreekey16, public.gbtreekey16, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_time_same(public.gbtreekey16, public.gbtreekey16, internal) TO service_role;


--
-- Name: FUNCTION gbt_time_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_time_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_time_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_time_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_timetz_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_timetz_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_timetz_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_timetz_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_timetz_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_ts_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_ts_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_ts_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_ts_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_ts_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_ts_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_ts_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_ts_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_ts_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_ts_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_ts_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_ts_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_ts_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_ts_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_ts_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_ts_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_ts_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_same(public.gbtreekey16, public.gbtreekey16, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_ts_same(public.gbtreekey16, public.gbtreekey16, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_ts_same(public.gbtreekey16, public.gbtreekey16, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_ts_same(public.gbtreekey16, public.gbtreekey16, internal) TO service_role;


--
-- Name: FUNCTION gbt_ts_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_ts_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_ts_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_ts_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_tstz_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_tstz_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_tstz_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_tstz_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_tstz_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_uuid_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_compress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_uuid_compress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_uuid_compress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_uuid_compress(internal) TO service_role;


--
-- Name: FUNCTION gbt_uuid_consistent(internal, uuid, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_consistent(internal, uuid, smallint, oid, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_uuid_consistent(internal, uuid, smallint, oid, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_uuid_consistent(internal, uuid, smallint, oid, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_uuid_consistent(internal, uuid, smallint, oid, internal) TO service_role;


--
-- Name: FUNCTION gbt_uuid_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_uuid_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_uuid_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_uuid_fetch(internal) TO service_role;


--
-- Name: FUNCTION gbt_uuid_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_penalty(internal, internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_uuid_penalty(internal, internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_uuid_penalty(internal, internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_uuid_penalty(internal, internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_uuid_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_picksplit(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_uuid_picksplit(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_uuid_picksplit(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_uuid_picksplit(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_uuid_same(public.gbtreekey32, public.gbtreekey32, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_same(public.gbtreekey32, public.gbtreekey32, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_uuid_same(public.gbtreekey32, public.gbtreekey32, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_uuid_same(public.gbtreekey32, public.gbtreekey32, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_uuid_same(public.gbtreekey32, public.gbtreekey32, internal) TO service_role;


--
-- Name: FUNCTION gbt_uuid_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_union(internal, internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_uuid_union(internal, internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_uuid_union(internal, internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_uuid_union(internal, internal) TO service_role;


--
-- Name: FUNCTION gbt_var_decompress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_var_decompress(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_var_decompress(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_var_decompress(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_var_decompress(internal) TO service_role;


--
-- Name: FUNCTION gbt_var_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_var_fetch(internal) TO postgres;
GRANT ALL ON FUNCTION public.gbt_var_fetch(internal) TO anon;
GRANT ALL ON FUNCTION public.gbt_var_fetch(internal) TO authenticated;
GRANT ALL ON FUNCTION public.gbt_var_fetch(internal) TO service_role;


--
-- Name: FUNCTION has_permission(permission text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.has_permission(permission text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.has_permission(permission text) TO authenticated;
GRANT ALL ON FUNCTION public.has_permission(permission text) TO service_role;


--
-- Name: FUNCTION has_task_access(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.has_task_access() FROM PUBLIC;
GRANT ALL ON FUNCTION public.has_task_access() TO authenticated;
GRANT ALL ON FUNCTION public.has_task_access() TO service_role;


--
-- Name: FUNCTION int2_dist(smallint, smallint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.int2_dist(smallint, smallint) TO postgres;
GRANT ALL ON FUNCTION public.int2_dist(smallint, smallint) TO anon;
GRANT ALL ON FUNCTION public.int2_dist(smallint, smallint) TO authenticated;
GRANT ALL ON FUNCTION public.int2_dist(smallint, smallint) TO service_role;


--
-- Name: FUNCTION int4_dist(integer, integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.int4_dist(integer, integer) TO postgres;
GRANT ALL ON FUNCTION public.int4_dist(integer, integer) TO anon;
GRANT ALL ON FUNCTION public.int4_dist(integer, integer) TO authenticated;
GRANT ALL ON FUNCTION public.int4_dist(integer, integer) TO service_role;


--
-- Name: FUNCTION int8_dist(bigint, bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.int8_dist(bigint, bigint) TO postgres;
GRANT ALL ON FUNCTION public.int8_dist(bigint, bigint) TO anon;
GRANT ALL ON FUNCTION public.int8_dist(bigint, bigint) TO authenticated;
GRANT ALL ON FUNCTION public.int8_dist(bigint, bigint) TO service_role;


--
-- Name: FUNCTION interval_dist(interval, interval); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.interval_dist(interval, interval) TO postgres;
GRANT ALL ON FUNCTION public.interval_dist(interval, interval) TO anon;
GRANT ALL ON FUNCTION public.interval_dist(interval, interval) TO authenticated;
GRANT ALL ON FUNCTION public.interval_dist(interval, interval) TO service_role;


--
-- Name: FUNCTION issue_grouped_document(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.issue_grouped_document(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.issue_grouped_document(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.issue_grouped_document(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION issue_rental_extra(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.issue_rental_extra(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.issue_rental_extra(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.issue_rental_extra(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION link_workshop_expense(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.link_workshop_expense(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.link_workshop_expense(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.link_workshop_expense(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION oid_dist(oid, oid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.oid_dist(oid, oid) TO postgres;
GRANT ALL ON FUNCTION public.oid_dist(oid, oid) TO anon;
GRANT ALL ON FUNCTION public.oid_dist(oid, oid) TO authenticated;
GRANT ALL ON FUNCTION public.oid_dist(oid, oid) TO service_role;


--
-- Name: FUNCTION pay_direct_purchase(cost_id uuid, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pay_direct_purchase(cost_id uuid, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.pay_direct_purchase(cost_id uuid, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.pay_direct_purchase(cost_id uuid, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION payment_import_original(batch_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.payment_import_original(batch_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.payment_import_original(batch_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.payment_import_original(batch_id uuid) TO service_role;


--
-- Name: FUNCTION propose_agent_expense(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.propose_agent_expense(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.propose_agent_expense(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.propose_agent_expense(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION receivables_at(cutoff date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.receivables_at(cutoff date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.receivables_at(cutoff date) TO authenticated;
GRANT ALL ON FUNCTION public.receivables_at(cutoff date) TO service_role;


--
-- Name: FUNCTION receive_workshop_vehicle(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.receive_workshop_vehicle(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.receive_workshop_vehicle(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.receive_workshop_vehicle(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION record_cash_entry(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_cash_entry(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_cash_entry(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.record_cash_entry(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION record_connected_quote(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_connected_quote(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_connected_quote(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.record_connected_quote(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION record_linked_expense(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_linked_expense(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_linked_expense(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.record_linked_expense(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION record_linked_receipt(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_linked_receipt(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_linked_receipt(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.record_linked_receipt(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION rental_alternatives(starts_at timestamp with time zone, ends_at timestamp with time zone, exclude_reservation uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rental_alternatives(starts_at timestamp with time zone, ends_at timestamp with time zone, exclude_reservation uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rental_alternatives(starts_at timestamp with time zone, ends_at timestamp with time zone, exclude_reservation uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rental_alternatives(starts_at timestamp with time zone, ends_at timestamp with time zone, exclude_reservation uuid) TO service_role;


--
-- Name: FUNCTION rental_case_file(reservation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rental_case_file(reservation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rental_case_file(reservation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rental_case_file(reservation_id uuid) TO service_role;


--
-- Name: FUNCTION rental_paid_through(reservation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rental_paid_through(reservation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rental_paid_through(reservation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rental_paid_through(reservation_id uuid) TO service_role;


--
-- Name: FUNCTION reservation_payment_status(reservation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reservation_payment_status(reservation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reservation_payment_status(reservation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.reservation_payment_status(reservation_id uuid) TO service_role;


--
-- Name: FUNCTION reservation_payment_summary(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reservation_payment_summary() FROM PUBLIC;
GRANT ALL ON FUNCTION public.reservation_payment_summary() TO authenticated;
GRANT ALL ON FUNCTION public.reservation_payment_summary() TO service_role;


--
-- Name: FUNCTION review_source_item(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.review_source_item(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.review_source_item(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.review_source_item(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION save_customer_document(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.save_customer_document(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.save_customer_document(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.save_customer_document(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION save_registry_details(kind text, payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.save_registry_details(kind text, payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.save_registry_details(kind text, payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.save_registry_details(kind text, payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION save_vehicle_file(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.save_vehicle_file(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.save_vehicle_file(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.save_vehicle_file(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION save_workshop_quote(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.save_workshop_quote(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.save_workshop_quote(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.save_workshop_quote(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION source_duplicate_candidates(record_type text, proposal jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.source_duplicate_candidates(record_type text, proposal jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.source_duplicate_candidates(record_type text, proposal jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.source_duplicate_candidates(record_type text, proposal jsonb) TO service_role;


--
-- Name: FUNCTION source_workbook_bundle(workbook_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.source_workbook_bundle(workbook_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.source_workbook_bundle(workbook_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.source_workbook_bundle(workbook_id uuid) TO service_role;


--
-- Name: FUNCTION source_workbook_original(workbook_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.source_workbook_original(workbook_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.source_workbook_original(workbook_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.source_workbook_original(workbook_id uuid) TO service_role;


--
-- Name: FUNCTION stage_expense_import(file_name text, file_base64 text, sheet_name text, columns jsonb, rows jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.stage_expense_import(file_name text, file_base64 text, sheet_name text, columns jsonb, rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.stage_expense_import(file_name text, file_base64 text, sheet_name text, columns jsonb, rows jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.stage_expense_import(file_name text, file_base64 text, sheet_name text, columns jsonb, rows jsonb) TO service_role;


--
-- Name: FUNCTION stage_source_workbook(payload jsonb, idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.stage_source_workbook(payload jsonb, idempotency_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.stage_source_workbook(payload jsonb, idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.stage_source_workbook(payload jsonb, idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION time_dist(time without time zone, time without time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.time_dist(time without time zone, time without time zone) TO postgres;
GRANT ALL ON FUNCTION public.time_dist(time without time zone, time without time zone) TO anon;
GRANT ALL ON FUNCTION public.time_dist(time without time zone, time without time zone) TO authenticated;
GRANT ALL ON FUNCTION public.time_dist(time without time zone, time without time zone) TO service_role;


--
-- Name: FUNCTION ts_dist(timestamp without time zone, timestamp without time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ts_dist(timestamp without time zone, timestamp without time zone) TO postgres;
GRANT ALL ON FUNCTION public.ts_dist(timestamp without time zone, timestamp without time zone) TO anon;
GRANT ALL ON FUNCTION public.ts_dist(timestamp without time zone, timestamp without time zone) TO authenticated;
GRANT ALL ON FUNCTION public.ts_dist(timestamp without time zone, timestamp without time zone) TO service_role;


--
-- Name: FUNCTION tstz_dist(timestamp with time zone, timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tstz_dist(timestamp with time zone, timestamp with time zone) TO postgres;
GRANT ALL ON FUNCTION public.tstz_dist(timestamp with time zone, timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.tstz_dist(timestamp with time zone, timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.tstz_dist(timestamp with time zone, timestamp with time zone) TO service_role;


--
-- Name: FUNCTION validate_expense_import(batch_id uuid, expected_version integer, mapping jsonb, source_system text, decisions jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_expense_import(batch_id uuid, expected_version integer, mapping jsonb, source_system text, decisions jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.validate_expense_import(batch_id uuid, expected_version integer, mapping jsonb, source_system text, decisions jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.validate_expense_import(batch_id uuid, expected_version integer, mapping jsonb, source_system text, decisions jsonb) TO service_role;


--
-- Name: FUNCTION vehicle_case_file(vehicle_id uuid, order_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.vehicle_case_file(vehicle_id uuid, order_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.vehicle_case_file(vehicle_id uuid, order_id text) TO authenticated;
GRANT ALL ON FUNCTION public.vehicle_case_file(vehicle_id uuid, order_id text) TO service_role;


--
-- Name: FUNCTION vehicle_contribution(vehicle_id uuid, from_date date, cutoff date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.vehicle_contribution(vehicle_id uuid, from_date date, cutoff date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.vehicle_contribution(vehicle_id uuid, from_date date, cutoff date) TO authenticated;
GRANT ALL ON FUNCTION public.vehicle_contribution(vehicle_id uuid, from_date date, cutoff date) TO service_role;


--
-- Name: FUNCTION vehicle_file_content(file_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.vehicle_file_content(file_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.vehicle_file_content(file_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.vehicle_file_content(file_id uuid) TO service_role;


--
-- Name: FUNCTION workshop_assignees(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.workshop_assignees() FROM PUBLIC;
GRANT ALL ON FUNCTION public.workshop_assignees() TO authenticated;
GRANT ALL ON FUNCTION public.workshop_assignees() TO service_role;


--
-- Name: FUNCTION workshop_delivery_checklist(order_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.workshop_delivery_checklist(order_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.workshop_delivery_checklist(order_id text) TO authenticated;
GRANT ALL ON FUNCTION public.workshop_delivery_checklist(order_id text) TO service_role;


--
-- Name: FUNCTION workshop_expense_inbox(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.workshop_expense_inbox() FROM PUBLIC;
GRANT ALL ON FUNCTION public.workshop_expense_inbox() TO authenticated;
GRANT ALL ON FUNCTION public.workshop_expense_inbox() TO service_role;


--
-- Name: TABLE agent_expense_proposals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_expense_proposals TO service_role;
GRANT SELECT ON TABLE public.agent_expense_proposals TO authenticated;


--
-- Name: TABLE audit_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.audit_events TO service_role;
GRANT SELECT ON TABLE public.audit_events TO authenticated;


--
-- Name: TABLE billing_application_lines; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.billing_application_lines TO service_role;
GRANT SELECT ON TABLE public.billing_application_lines TO authenticated;


--
-- Name: TABLE billing_credit_lines; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.billing_credit_lines TO service_role;
GRANT SELECT ON TABLE public.billing_credit_lines TO authenticated;


--
-- Name: TABLE billing_credits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.billing_credits TO service_role;
GRANT SELECT ON TABLE public.billing_credits TO authenticated;


--
-- Name: TABLE billing_document_lines; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.billing_document_lines TO service_role;
GRANT SELECT ON TABLE public.billing_document_lines TO authenticated;


--
-- Name: TABLE billing_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.billing_documents TO service_role;
GRANT SELECT ON TABLE public.billing_documents TO authenticated;


--
-- Name: SEQUENCE billing_documents_folio_number_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.billing_documents_folio_number_seq TO anon;
GRANT ALL ON SEQUENCE public.billing_documents_folio_number_seq TO authenticated;
GRANT ALL ON SEQUENCE public.billing_documents_folio_number_seq TO service_role;


--
-- Name: TABLE budget_expense_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.budget_expense_links TO service_role;
GRANT SELECT ON TABLE public.budget_expense_links TO authenticated;


--
-- Name: TABLE budget_purchase_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.budget_purchase_links TO service_role;
GRANT SELECT ON TABLE public.budget_purchase_links TO authenticated;


--
-- Name: TABLE cash_entries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cash_entries TO service_role;
GRANT SELECT ON TABLE public.cash_entries TO authenticated;


--
-- Name: TABLE commission_bindings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_bindings TO service_role;
GRANT SELECT ON TABLE public.commission_bindings TO authenticated;


--
-- Name: TABLE commission_eligibility; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_eligibility TO service_role;
GRANT SELECT ON TABLE public.commission_eligibility TO authenticated;


--
-- Name: TABLE commission_entries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_entries TO service_role;
GRANT SELECT ON TABLE public.commission_entries TO authenticated;


--
-- Name: TABLE commission_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_rules TO service_role;
GRANT SELECT ON TABLE public.commission_rules TO authenticated;


--
-- Name: TABLE contract_acceptances; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contract_acceptances TO service_role;
GRANT SELECT ON TABLE public.contract_acceptances TO authenticated;


--
-- Name: TABLE cost_allocations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cost_allocations TO service_role;
GRANT SELECT ON TABLE public.cost_allocations TO authenticated;


--
-- Name: TABLE cost_centers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cost_centers TO service_role;
GRANT SELECT ON TABLE public.cost_centers TO authenticated;


--
-- Name: TABLE customer_aliases; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_aliases TO service_role;
GRANT SELECT ON TABLE public.customer_aliases TO authenticated;


--
-- Name: TABLE customer_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_documents TO service_role;
GRANT SELECT ON TABLE public.customer_documents TO authenticated;


--
-- Name: TABLE customer_payments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_payments TO service_role;
GRANT SELECT ON TABLE public.customer_payments TO authenticated;


--
-- Name: SEQUENCE customer_payments_folio_number_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.customer_payments_folio_number_seq TO anon;
GRANT ALL ON SEQUENCE public.customer_payments_folio_number_seq TO authenticated;
GRANT ALL ON SEQUENCE public.customer_payments_folio_number_seq TO service_role;


--
-- Name: TABLE estimate_approvals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.estimate_approvals TO service_role;
GRANT SELECT ON TABLE public.estimate_approvals TO authenticated;


--
-- Name: TABLE estimate_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.estimate_documents TO service_role;
GRANT SELECT ON TABLE public.estimate_documents TO authenticated;


--
-- Name: TABLE estimate_versions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.estimate_versions TO service_role;
GRANT SELECT ON TABLE public.estimate_versions TO authenticated;


--
-- Name: SEQUENCE estimate_versions_folio_number_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.estimate_versions_folio_number_seq TO anon;
GRANT ALL ON SEQUENCE public.estimate_versions_folio_number_seq TO authenticated;
GRANT ALL ON SEQUENCE public.estimate_versions_folio_number_seq TO service_role;


--
-- Name: SEQUENCE expense_folio; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.expense_folio TO anon;
GRANT ALL ON SEQUENCE public.expense_folio TO authenticated;
GRANT ALL ON SEQUENCE public.expense_folio TO service_role;


--
-- Name: TABLE expense_import_origins; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expense_import_origins TO service_role;
GRANT SELECT ON TABLE public.expense_import_origins TO authenticated;


--
-- Name: TABLE expense_import_rows; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expense_import_rows TO service_role;
GRANT SELECT ON TABLE public.expense_import_rows TO authenticated;


--
-- Name: TABLE expenses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expenses TO service_role;
GRANT SELECT ON TABLE public.expenses TO authenticated;


--
-- Name: TABLE integration_inbox; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.integration_inbox TO service_role;
GRANT SELECT ON TABLE public.integration_inbox TO authenticated;


--
-- Name: TABLE operating_budgets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.operating_budgets TO service_role;
GRANT SELECT ON TABLE public.operating_budgets TO authenticated;


--
-- Name: TABLE payment_applications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_applications TO service_role;
GRANT SELECT ON TABLE public.payment_applications TO authenticated;


--
-- Name: TABLE payment_import_origins; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_import_origins TO service_role;
GRANT SELECT ON TABLE public.payment_import_origins TO authenticated;


--
-- Name: TABLE payment_refunds; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_refunds TO service_role;
GRANT SELECT ON TABLE public.payment_refunds TO authenticated;


--
-- Name: TABLE purchase_orders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.purchase_orders TO service_role;
GRANT SELECT ON TABLE public.purchase_orders TO authenticated;


--
-- Name: TABLE receipt_operation_contexts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.receipt_operation_contexts TO service_role;
GRANT SELECT ON TABLE public.receipt_operation_contexts TO authenticated;


--
-- Name: TABLE rental_extra_proposals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rental_extra_proposals TO service_role;
GRANT SELECT ON TABLE public.rental_extra_proposals TO authenticated;


--
-- Name: TABLE rental_inspections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rental_inspections TO service_role;
GRANT SELECT ON TABLE public.rental_inspections TO authenticated;


--
-- Name: TABLE rental_periods; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rental_periods TO service_role;
GRANT SELECT ON TABLE public.rental_periods TO authenticated;


--
-- Name: TABLE report_outbox; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.report_outbox TO service_role;
GRANT SELECT ON TABLE public.report_outbox TO authenticated;


--
-- Name: TABLE report_schedules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.report_schedules TO service_role;
GRANT SELECT ON TABLE public.report_schedules TO authenticated;


--
-- Name: TABLE reservation_evidence; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reservation_evidence TO service_role;
GRANT SELECT ON TABLE public.reservation_evidence TO authenticated;


--
-- Name: TABLE reservations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reservations TO service_role;
GRANT SELECT ON TABLE public.reservations TO authenticated;


--
-- Name: SEQUENCE reservations_folio_number_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.reservations_folio_number_seq TO anon;
GRANT ALL ON SEQUENCE public.reservations_folio_number_seq TO authenticated;
GRANT ALL ON SEQUENCE public.reservations_folio_number_seq TO service_role;


--
-- Name: TABLE source_workbook_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.source_workbook_items TO service_role;
GRANT SELECT ON TABLE public.source_workbook_items TO authenticated;


--
-- Name: TABLE source_workbooks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.source_workbooks TO service_role;
GRANT SELECT ON TABLE public.source_workbooks TO authenticated;


--
-- Name: TABLE stock_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.stock_items TO service_role;
GRANT SELECT ON TABLE public.stock_items TO authenticated;


--
-- Name: TABLE stock_movements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.stock_movements TO service_role;
GRANT SELECT ON TABLE public.stock_movements TO authenticated;


--
-- Name: TABLE supplier_obligations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.supplier_obligations TO service_role;
GRANT SELECT ON TABLE public.supplier_obligations TO authenticated;


--
-- Name: TABLE task_time_spans; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.task_time_spans TO service_role;
GRANT SELECT ON TABLE public.task_time_spans TO authenticated;


--
-- Name: TABLE task_timers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.task_timers TO service_role;
GRANT SELECT ON TABLE public.task_timers TO authenticated;


--
-- Name: TABLE user_roles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_roles TO service_role;
GRANT SELECT ON TABLE public.user_roles TO authenticated;


--
-- Name: TABLE vehicle_commitments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vehicle_commitments TO service_role;
GRANT SELECT ON TABLE public.vehicle_commitments TO authenticated;


--
-- Name: TABLE vehicle_files; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vehicle_files TO service_role;
GRANT SELECT ON TABLE public.vehicle_files TO authenticated;


--
-- Name: TABLE vehicles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vehicles TO service_role;
GRANT SELECT ON TABLE public.vehicles TO authenticated;


--
-- Name: SEQUENCE work_order_folio; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.work_order_folio TO anon;
GRANT ALL ON SEQUENCE public.work_order_folio TO authenticated;
GRANT ALL ON SEQUENCE public.work_order_folio TO service_role;


--
-- Name: TABLE work_orders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.work_orders TO service_role;
GRANT SELECT ON TABLE public.work_orders TO authenticated;


--
-- Name: TABLE workshop_costs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workshop_costs TO service_role;
GRANT SELECT ON TABLE public.workshop_costs TO authenticated;


--
-- Name: TABLE workshop_deliveries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workshop_deliveries TO service_role;
GRANT SELECT ON TABLE public.workshop_deliveries TO authenticated;


--
-- Name: TABLE workshop_inspections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workshop_inspections TO service_role;
GRANT SELECT ON TABLE public.workshop_inspections TO authenticated;


--
-- Name: TABLE workshop_tariffs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workshop_tariffs TO service_role;
GRANT SELECT ON TABLE public.workshop_tariffs TO authenticated;


--
-- Name: TABLE workshop_tasks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workshop_tasks TO service_role;
GRANT SELECT ON TABLE public.workshop_tasks TO authenticated;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
--
-- PostgreSQL database dump complete
--


