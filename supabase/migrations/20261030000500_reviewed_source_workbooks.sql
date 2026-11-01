-- Original files and structured observations are private evidence, not money.
create table public.source_workbooks(
  id uuid primary key default gen_random_uuid(),file_name text not null check(length(btrim(file_name)) between 1 and 200),
  file_hash text not null unique,format text not null check(format in ('diary','budget','fleet','receivables','unknown')),
  parser_version text not null,preview jsonb not null,created_by uuid not null references auth.users,created_at timestamptz not null default now()
);
create table private.source_workbook_bytes(workbook_id uuid primary key references public.source_workbooks,content bytea not null);
create table public.source_workbook_items(
  id uuid primary key default gen_random_uuid(),workbook_id uuid not null references public.source_workbooks,
  source_ref text not null,metadata jsonb not null,status text not null default 'Pendiente' check(status in ('Pendiente','Excluido','Vinculado','Publicado')),
  record_type text,record_id text,proposal jsonb,reason text not null default '',version integer not null default 1,
  reviewed_by uuid references auth.users,reviewed_at timestamptz,unique(workbook_id,source_ref)
);
do $$ declare tbl text;begin
  foreach tbl in array array['source_workbooks','source_workbook_items'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from anon,authenticated',tbl);
    execute format('grant select on public.%I to authenticated',tbl);
    execute format('create policy source_read on public.%I for select to authenticated using(public.has_permission(''expenses.read''))',tbl);
    execute format('create trigger source_audit after insert or update on public.%I for each row execute function private.audit_change()',tbl);
  end loop;
end $$;
create trigger source_book_immutable before update or delete on public.source_workbooks for each row execute function private.immutable_quote_record();
create function public.stage_source_workbook(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
create function public.source_workbook_bundle(workbook_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return jsonb_build_object('book',(select to_jsonb(b) from public.source_workbooks b where b.id=workbook_id),
    'items',coalesce((select jsonb_agg(to_jsonb(i) order by (i.metadata->>'row')::integer,i.source_ref) from public.source_workbook_items i where i.workbook_id=source_workbook_bundle.workbook_id),'[]'));
end $$;
create function public.source_workbook_original(workbook_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return (select jsonb_build_object('fileName',b.file_name,'hash',b.file_hash,'base64',encode(f.content,'base64')) from public.source_workbooks b
    join private.source_workbook_bytes f on f.workbook_id=b.id where b.id=source_workbook_original.workbook_id);
end $$;
create function public.source_duplicate_candidates(record_type text,proposal jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if record_type='expense' then return coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'concept',e.concept,'amount',e.amount,'date',e.date)) from public.expenses e
    where e.date=(proposal->>'date')::date and e.amount=(proposal->>'amount')::numeric),'[]');
  elsif record_type='receipt' then return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'concept',p.reference,'amount',p.amount,'date',p.paid_on)) from public.customer_payments p
    where p.paid_on=(proposal->>'date')::date and p.amount=(proposal->>'amount')::numeric),'[]');
  else return '[]';end if;
end $$;
create function public.review_source_item(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
end $$;
revoke all on function public.stage_source_workbook(jsonb,uuid),public.source_workbook_bundle(uuid),public.source_workbook_original(uuid),
  public.source_duplicate_candidates(text,jsonb),public.review_source_item(jsonb,uuid) from public,anon;
grant execute on function public.stage_source_workbook(jsonb,uuid),public.source_workbook_bundle(uuid),public.source_workbook_original(uuid),
  public.source_duplicate_candidates(text,jsonb),public.review_source_item(jsonb,uuid) to authenticated;
