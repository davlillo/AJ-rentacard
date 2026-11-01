-- HU08/HU09: immutable tariff revisions and deterministic, approved quote snapshots.
create table public.workshop_tariffs (
  id uuid primary key default gen_random_uuid(),
  code text not null check (length(btrim(code)) between 1 and 100),
  revision integer not null,
  description text not null check (length(btrim(description)) between 1 and 500),
  kind text not null check (kind in ('Material','Trabajo','Tercero','Indirecto')),
  unit_cost numeric(14,4) not null check (unit_cost >= 0 and unit_cost::text not in ('NaN','Infinity')),
  unit_price numeric(14,4) not null check (unit_price >= 0 and unit_price::text not in ('NaN','Infinity')),
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  unique(code,revision)
);
create table public.estimate_versions (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.work_orders,
  revision integer not null,
  parent_id uuid references public.estimate_versions,
  status text not null default 'Borrador' check (status in ('Borrador','Aprobado','Rechazado')),
  snapshot jsonb not null,
  customer_snapshot jsonb not null,
  vehicle_snapshot jsonb not null,
  reason text not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  unique(order_id,revision)
);
create table public.estimate_approvals (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null unique references public.estimate_versions,
  decision text not null check (decision in ('Aprobado','Rechazado')),
  approver_name text not null check (length(btrim(approver_name)) > 0),
  evidence text not null check (length(btrim(evidence)) > 0),
  occurred_at timestamptz not null,
  recorded_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
alter table public.work_orders add column active_estimate_id uuid references public.estimate_versions;
alter table public.workshop_tariffs enable row level security;
alter table public.estimate_versions enable row level security;
alter table public.estimate_approvals enable row level security;
revoke all on public.workshop_tariffs,public.estimate_versions,public.estimate_approvals from anon,authenticated;
grant select on public.workshop_tariffs,public.estimate_versions,public.estimate_approvals to authenticated;
create policy tariff_read on public.workshop_tariffs for select to authenticated using (public.has_permission('expenses.write'));
create policy estimate_read on public.estimate_versions for select to authenticated using (public.has_permission('expenses.write'));
create policy approval_read on public.estimate_approvals for select to authenticated using (public.has_permission('expenses.write'));
create trigger tariff_audit after insert on public.workshop_tariffs for each row execute function private.audit_change();
create trigger estimate_audit after insert or update on public.estimate_versions for each row execute function private.audit_change();
create trigger approval_audit after insert on public.estimate_approvals for each row execute function private.audit_change();

create function private.immutable_quote_record() returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_TABLE_NAME <> 'estimate_versions' or TG_OP = 'DELETE' then raise exception 'IMMUTABLE_RECORD'; end if;
  if old.status <> 'Borrador' or new.status not in ('Aprobado','Rechazado')
    or (to_jsonb(old)-'status') <> (to_jsonb(new)-'status') then raise exception 'IMMUTABLE_ESTIMATE_VERSION'; end if;
  return new;
end;
$$;
create trigger tariff_immutable before update or delete on public.workshop_tariffs for each row execute function private.immutable_quote_record();
create trigger estimate_immutable before update or delete on public.estimate_versions for each row execute function private.immutable_quote_record();
create trigger approval_immutable before update or delete on public.estimate_approvals for each row execute function private.immutable_quote_record();

create function private.calculate_estimate(lines jsonb, method text, ratio numeric, discount numeric) returns jsonb
language plpgsql stable set search_path = '' as $$
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

create function public.calculate_estimate(lines jsonb, method text default 'commercial', ratio numeric default null,
  discount numeric default 0) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  return private.calculate_estimate(lines,method,ratio,discount);
end;
$$;

create function public.execute_estimate_command(command text, payload jsonb, idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.calculate_estimate(jsonb,text,numeric,numeric),public.execute_estimate_command(text,jsonb,uuid) from public,anon;
grant execute on function public.calculate_estimate(jsonb,text,numeric,numeric),public.execute_estimate_command(text,jsonb,uuid) to authenticated;

create table public.estimate_documents (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null references public.estimate_versions,
  status text not null,
  file_hash text not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  unique(estimate_id,status)
);
create table private.estimate_document_files (
  document_id uuid primary key references public.estimate_documents,
  content bytea not null
);
alter table public.estimate_documents enable row level security;
revoke all on public.estimate_documents from anon,authenticated;
grant select on public.estimate_documents to authenticated;
create policy estimate_document_read on public.estimate_documents for select to authenticated using(public.has_permission('orders.read'));
create trigger estimate_document_audit after insert on public.estimate_documents for each row execute function private.audit_change();
create trigger estimate_document_immutable before update or delete on public.estimate_documents for each row execute function private.immutable_quote_record();

create function public.estimate_pdf(estimate_id uuid,expected_status text,pdf_base64 text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
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
revoke all on function public.estimate_pdf(uuid,text,text) from public,anon;
grant execute on function public.estimate_pdf(uuid,text,text) to authenticated;
