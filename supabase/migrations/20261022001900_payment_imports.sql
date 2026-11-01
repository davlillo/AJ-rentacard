-- HU05/HU06: bounded XLSX/CSV payment staging with stable origins and explicit ambiguous decisions.
create table public.payment_imports (
  id uuid primary key default gen_random_uuid(),file_name text not null,file_hash text not null,sheet text not null,
  rows jsonb not null,mapping jsonb not null default '{}',source_system text not null default '',decisions jsonb not null default '{}',
  preview jsonb not null default '[]',new_total numeric(18,2) not null default 0,
  status text not null default 'Preparado' check(status in ('Preparado','Validado','Publicado')),
  version integer not null default 1,created_by uuid not null references auth.users,created_at timestamptz not null default now(),unique(file_hash,sheet)
);
create table private.payment_import_files(import_id uuid primary key references public.payment_imports,content bytea not null);
create table public.payment_import_origins (
  id uuid primary key default gen_random_uuid(),source_system text not null,source_key text not null,
  payment_id uuid not null references public.customer_payments,fingerprint jsonb not null,
  created_by uuid not null references auth.users,created_at timestamptz not null default now(),unique(source_system,source_key)
);
alter table public.payment_imports enable row level security;
alter table public.payment_import_origins enable row level security;
revoke all on public.payment_imports,public.payment_import_origins from anon,authenticated;
grant select on public.payment_imports,public.payment_import_origins to authenticated;
create policy payment_import_read on public.payment_imports for select to authenticated using(public.has_permission('expenses.write'));
create policy payment_origin_read on public.payment_import_origins for select to authenticated using(public.has_permission('expenses.write'));
create trigger payment_import_audit after insert or update on public.payment_imports for each row execute function private.audit_change();
create trigger payment_origin_audit after insert on public.payment_import_origins for each row execute function private.audit_change();
create function private.normalize_import_payment(raw jsonb,mapping jsonb) returns jsonb language plpgsql stable set search_path='' as $$
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
$$;
create function private.payment_import_preview(batch public.payment_imports) returns jsonb language plpgsql stable set search_path='' as $$
declare raw jsonb;p jsonb;origin public.payment_import_origins;decision jsonb;status text;payment_id uuid;candidates jsonb;rows jsonb:='[]';error text;
begin
  for raw in select value from jsonb_array_elements(batch.rows) loop
    status:='Valida';p:=null;payment_id:=null;candidates:='[]';error:=null;
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
          if jsonb_array_length(candidates)>0 then
            status:='Ambigua';
            if decision->>'action'='link' and nullif(btrim(decision->>'reason'),'') is not null and candidates ? (decision->>'paymentId') then
              status:='Duplicada';payment_id:=(decision->>'paymentId')::uuid;
            elsif decision->>'action'='create' and nullif(btrim(decision->>'reason'),'') is not null then status:='Valida';end if;
          end if;
          if exists(select 1 from jsonb_array_elements(rows) previous where previous->'payload'=p
            or (p->>'sourceKey' is not null and previous->'payload'->>'sourceKey'=p->>'sourceKey')) then status:='Conflicto';error:='Origen o fila repetidos dentro del lote';end if;
        end if;
      exception when others then status:='Rechazada';error:=SQLERRM;
      end;
    end if;
    rows:=rows||jsonb_build_array(jsonb_build_object('rowNumber',raw->>'rowNumber','status',status,'payload',p,'paymentId',payment_id,'candidates',candidates,'error',error));
  end loop;
  return rows;
end;
$$;
create function public.execute_payment_import(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
create function public.payment_import_original(batch_id uuid) returns text language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return(select encode(content,'base64') from private.payment_import_files where import_id=batch_id);
end;
$$;
revoke all on function public.execute_payment_import(text,jsonb,uuid),public.payment_import_original(uuid) from public,anon;
grant execute on function public.execute_payment_import(text,jsonb,uuid),public.payment_import_original(uuid) to authenticated;
