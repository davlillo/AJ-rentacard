-- Identity photos are private customer records, never vehicle covers or public URLs.
create table public.customer_documents(
  id uuid primary key default gen_random_uuid(),customer_id uuid not null references public.customers,
  kind text not null check(kind in ('DUI','Licencia')),name text not null check(length(btrim(name)) between 1 and 200),
  mime text not null check(mime in ('image/png','image/jpeg','image/webp')),
  size integer not null check(size between 1 and 2097152),file_hash text not null,
  created_by uuid not null references auth.users,created_at timestamptz not null default clock_timestamp()
);
create index customer_documents_customer on public.customer_documents(customer_id,created_at desc);
create table private.customer_document_bytes(file_id uuid primary key references public.customer_documents,content bytea not null);
revoke all on private.customer_document_bytes from public,anon,authenticated;
alter table public.customer_documents enable row level security;
revoke all on public.customer_documents from public,anon,authenticated;
grant select on public.customer_documents to authenticated;
create policy customer_document_read on public.customer_documents for select to authenticated using(public.has_permission('customers.write'));
create trigger customer_document_immutable before update or delete on public.customer_documents for each row execute function private.immutable_quote_record();
create trigger customer_document_audit after insert on public.customer_documents for each row execute function private.audit_change();

create function public.save_customer_document(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
create function public.customer_document_list(customer_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('customers.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at desc,f.id) from public.customer_documents f
    where f.customer_id=customer_document_list.customer_id or exists(select 1 from public.customer_aliases a
      where a.source_id=f.customer_id and a.customer_id=customer_document_list.customer_id)),'[]');
end $$;
create function public.customer_document_content(file_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare file public.customer_documents;begin
  if not public.has_permission('customers.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  select * into file from public.customer_documents where id=file_id;
  if file.id is null then raise exception 'CUSTOMER_DOCUMENT_NOT_FOUND';end if;
  return jsonb_build_object('mime',file.mime,'name',file.name,'base64',
    (select encode(content,'base64') from private.customer_document_bytes where customer_document_bytes.file_id=file.id));
end $$;
revoke all on function public.save_customer_document(jsonb,uuid),public.customer_document_list(uuid),public.customer_document_content(uuid) from public,anon;
grant execute on function public.save_customer_document(jsonb,uuid),public.customer_document_list(uuid),public.customer_document_content(uuid) to authenticated;
