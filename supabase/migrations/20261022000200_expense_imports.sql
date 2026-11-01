-- HU05/HU06: private staging, explicit reconciliation and atomic publication.
create table public.expense_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_hash text not null,
  sheet_name text not null,
  source_system text not null default 'daily-ledger',
  columns jsonb not null,
  mapping jsonb not null default '{}',
  decisions jsonb not null default '{}',
  status text not null default 'staged' check (status in ('staged','validated','committed')),
  summary jsonb not null default '{}',
  version integer not null default 1,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  unique(file_hash,sheet_name)
);
create table private.expense_import_files (
  import_id uuid primary key references public.expense_imports,
  content bytea not null
);
create table public.expense_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.expense_imports,
  row_number integer not null check (row_number > 0),
  raw_data jsonb not null,
  payload jsonb,
  fingerprint jsonb,
  source_key text,
  status text not null default 'pending'
    check (status in ('pending','valid','rejected','duplicate','ambiguous','excluded','published')),
  issue text not null default '',
  candidates text[] not null default '{}',
  expense_id text references public.expenses,
  command_key uuid not null default gen_random_uuid(),
  unique(import_id,row_number)
);
create index expense_import_rows_batch on public.expense_import_rows(import_id,row_number);
create table public.expense_import_origins (
  source_system text not null,
  source_key text not null,
  fingerprint jsonb not null,
  expense_id text not null references public.expenses,
  import_id uuid not null references public.expense_imports,
  primary key(source_system,source_key)
);
alter table public.expense_imports enable row level security;
alter table public.expense_import_rows enable row level security;
alter table public.expense_import_origins enable row level security;
revoke all on public.expense_imports, public.expense_import_rows, public.expense_import_origins from anon, authenticated;
grant select on public.expense_imports, public.expense_import_rows, public.expense_import_origins to authenticated;
create policy import_read on public.expense_imports for select to authenticated
using (public.has_permission('expenses.write') and public.has_permission('expenses.read'));
create policy import_rows_read on public.expense_import_rows for select to authenticated
using (public.has_permission('expenses.write') and public.has_permission('expenses.read'));
create policy import_origins_read on public.expense_import_origins for select to authenticated
using (public.has_permission('expenses.write') and public.has_permission('expenses.read'));
create trigger import_audit after insert or update on public.expense_imports
for each row execute function private.audit_change();

create function private.require_import_permission() returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (public.has_permission('expenses.write') and public.has_permission('expenses.read')) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
end;
$$;

create function private.import_fingerprint(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('date',p->>'date','concept',p->>'concept','category',p->>'category',
    'amount',(p->>'amount')::numeric,'method',p->>'method','account',p->>'account',
    'operationId',p->>'operationId','costCenterId',p->>'costCenterId');
$$;

create function private.normalize_import_expense(raw jsonb, mapping jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
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
$$;

create function private.validate_expense_import_rows(batch public.expense_imports) returns void
language plpgsql security invoker set search_path = '' as $$
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

create function private.expense_import_summary(batch_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('valid',count(*) filter(where status = 'valid'),
    'rejected',count(*) filter(where status = 'rejected'),'duplicate',count(*) filter(where status = 'duplicate'),
    'ambiguous',count(*) filter(where status = 'ambiguous'),'excluded',count(*) filter(where status = 'excluded'),
    'newTotal',coalesce(sum((payload->>'amount')::numeric) filter(where status = 'valid'),0),
    'duplicateTotal',coalesce(sum((payload->>'amount')::numeric) filter(where status = 'duplicate'),0))
  from public.expense_import_rows where import_id = batch_id;
$$;

create function public.stage_expense_import(file_name text, file_base64 text, sheet_name text, columns jsonb, rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
$$;

create function public.validate_expense_import(batch_id uuid, expected_version integer, mapping jsonb,
  source_system text, decisions jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
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

create function public.commit_expense_import(batch_id uuid, expected_version integer, expected_new_total numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
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

create function public.expense_import_original(batch_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_import_permission();
  return (select encode(content,'base64') from private.expense_import_files where import_id = batch_id);
end;
$$;
revoke all on function public.stage_expense_import(text,text,text,jsonb,jsonb),
  public.validate_expense_import(uuid,integer,jsonb,text,jsonb), public.commit_expense_import(uuid,integer,numeric),
  public.expense_import_original(uuid) from public, anon;
grant execute on function public.stage_expense_import(text,text,text,jsonb,jsonb),
  public.validate_expense_import(uuid,integer,jsonb,text,jsonb), public.commit_expense_import(uuid,integer,numeric),
  public.expense_import_original(uuid) to authenticated;
