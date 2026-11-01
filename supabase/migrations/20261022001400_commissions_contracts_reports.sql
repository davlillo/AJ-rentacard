-- HU22-HU24: explicit versioned rules, frozen contract terms, drillable billed direct contribution.
alter table public.billing_documents add column commission_eligible boolean not null default false;
create table public.commission_rules (
  id uuid primary key default gen_random_uuid(),code text not null,revision integer not null,
  rate numeric(9,6) not null check(rate between 0 and 1 and rate::text not in ('NaN','Infinity')),
  valid_from date not null,valid_until date not null,
  policy text not null default 'net-applied-eligible-receipts-v1',
  created_by uuid not null references auth.users,created_at timestamptz not null default now(),
  unique(code,revision),check(valid_until>=valid_from)
);
create table public.commission_bindings (
  id uuid primary key default gen_random_uuid(),reservation_id uuid not null unique references public.reservations,
  rule_id uuid not null references public.commission_rules,created_by uuid not null references auth.users,created_at timestamptz not null default now()
);
create table public.commission_entries (
  id uuid primary key default gen_random_uuid(),reservation_id uuid not null references public.reservations,
  seller_id uuid not null references auth.users,rule_id uuid not null references public.commission_rules,
  cutoff date not null,eligible_base numeric(18,2) not null,amount numeric(18,2) not null,
  rule_snapshot jsonb not null,basis_hash text not null,
  created_by uuid not null references auth.users,created_at timestamptz not null default now(),unique(reservation_id,basis_hash)
);
create table public.commission_eligibility (
  id uuid primary key default gen_random_uuid(),document_id uuid not null references public.billing_documents,
  eligible boolean not null,reason text not null check(length(btrim(reason))>0),
  created_by uuid not null references auth.users,created_at timestamptz not null default now()
);
create table public.rental_contracts (
  id uuid primary key default gen_random_uuid(),reservation_id uuid not null references public.reservations,
  revision integer not null,parent_id uuid references public.rental_contracts,
  booking_snapshot jsonb not null,conditions text not null check(length(btrim(conditions))>0),
  reason text not null check(length(btrim(reason))>0),created_by uuid not null references auth.users,created_at timestamptz not null default now(),
  unique(reservation_id,revision)
);
create table public.contract_acceptances (
  id uuid primary key default gen_random_uuid(),contract_id uuid not null unique references public.rental_contracts,
  accepted_by text not null check(length(btrim(accepted_by))>0),evidence text not null check(length(btrim(evidence))>0),
  created_by uuid not null references auth.users,created_at timestamptz not null default now()
);
create table private.contract_files(contract_id uuid primary key references public.rental_contracts,content bytea not null,file_hash text not null);
do $$ declare tbl text; begin
  foreach tbl in array array['commission_rules','commission_bindings','commission_entries','commission_eligibility','rental_contracts','contract_acceptances'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from anon,authenticated',tbl);
    execute format('grant select on public.%I to authenticated',tbl);
    execute format('create policy management_read on public.%I for select to authenticated using(public.has_permission(%L))',tbl,
      case when tbl in ('rental_contracts','contract_acceptances') then 'orders.read' else 'expenses.read' end);
    execute format('create trigger management_audit after insert on public.%I for each row execute function private.audit_change()',tbl);
    execute format('create trigger management_immutable before update or delete on public.%I for each row execute function private.immutable_quote_record()',tbl);
  end loop;
end $$;
create function public.execute_contract_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
create function public.contract_pdf(contract_id uuid,pdf_base64 text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare file private.contract_files;content bytea;
begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into file from private.contract_files where contract_files.contract_id=contract_pdf.contract_id;
  if file.contract_id is not null then return jsonb_build_object('hash',file.file_hash,'base64',encode(file.content,'base64'));end if;
  if pdf_base64 is null then return null;end if;
  if not public.has_permission('orders.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if length(pdf_base64)>7000000 then raise exception 'DOCUMENT_TOO_LARGE';end if;
  content:=decode(pdf_base64,'base64');
  if octet_length(content) not between 8 and 5242880 or substring(content from 1 for 5)<>convert_to('%PDF-','UTF8') then raise exception 'INVALID_PDF';end if;
  insert into private.contract_files values(contract_id,content,encode(sha256(content),'hex')) returning * into file;
  return jsonb_build_object('hash',file.file_hash,'base64',encode(file.content,'base64'));
end;
$$;
create function public.execute_commission_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
      into basis,base from public.payment_applications a join public.billing_documents d on d.id=a.document_id
      where d.reservation_id=booking.id and coalesce((select e.eligible from public.commission_eligibility e
        where e.document_id=d.id and e.created_at<(cutoff_date+1)::timestamp at time zone 'America/El_Salvador'
        order by e.created_at desc,e.id desc limit 1),d.commission_eligible) and a.effective_on<=cutoff_date
      and a.created_at<(cutoff_date+1)::timestamp at time zone 'America/El_Salvador';
    v_basis_hash:=encode(sha256(convert_to(basis::text||rule.id::text||coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at,e.id)::text
      from public.commission_eligibility e join public.billing_documents d on d.id=e.document_id where d.reservation_id=booking.id
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
create function public.vehicle_contribution(vehicle_id uuid,from_date date,cutoff date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare income jsonb;costs jsonb;income_total numeric;cost_total numeric;car public.vehicles;
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if from_date is null or cutoff is null or not isfinite(from_date) or not isfinite(cutoff) or cutoff<from_date then raise exception 'INVALID_REPORT_RANGE';end if;
  select * into car from public.vehicles where id=vehicle_id;
  if car.id is null then raise exception 'VEHICLE_NOT_FOUND';end if;
  select coalesce(jsonb_agg(to_jsonb(rows)),'[]'),coalesce(sum(rows.amount),0) into income,income_total from (
    select d.id,'Cargo'::text kind,d.description,d.amount,d.issued_on date from public.billing_documents d
      left join public.reservations r on r.id=d.reservation_id left join public.work_orders o on o.id=d.order_id
      where coalesce(r.vehicle_id,o.vehicle_id)=car.id and d.issued_on between from_date and cutoff and d.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'
    union all select c.id,'Credito',c.reason,-c.amount,c.credited_on from public.billing_credits c join public.billing_documents d on d.id=c.document_id
      left join public.reservations r on r.id=d.reservation_id left join public.work_orders o on o.id=d.order_id
      where coalesce(r.vehicle_id,o.vehicle_id)=car.id and c.credited_on between from_date and cutoff and c.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'
  ) rows;
  select coalesce(jsonb_agg(to_jsonb(rows)),'[]'),coalesce(sum(rows.amount),0) into costs,cost_total from (
    select c.id,c.order_id,c.description,(history.data->>'amount')::numeric amount,c.occurred_at date from public.workshop_costs c
      join public.work_orders o on o.id=c.order_id cross join lateral(select a.after_data data from public.audit_events a
        where a.entity='workshop_costs' and a.entity_id=c.id::text and a.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'
        order by a.created_at desc,a.id desc limit 1) history
      where o.vehicle_id=car.id and c.occurred_at between from_date and cutoff
  ) rows;
  return jsonb_build_object('policy','billed-direct-contribution-v1','vehicleId',car.id,'plate',car.plate,'from',from_date,'cutoff',cutoff,
    'income',income,'costs',costs,'billedIncome',income_total,'actualDirectCost',cost_total,'contribution',income_total-cost_total,
    'limitations','Not net profit: labor valuation and allocated overhead require approved cost policies. Stock receipt and customer payment are not counted as income/cost again.');
end;
$$;
revoke all on function public.execute_contract_command(text,jsonb,uuid),public.contract_pdf(uuid,text),public.execute_commission_command(text,jsonb,uuid),public.vehicle_contribution(uuid,date,date) from public,anon;
grant execute on function public.execute_contract_command(text,jsonb,uuid),public.contract_pdf(uuid,text),public.execute_commission_command(text,jsonb,uuid),public.vehicle_contribution(uuid,date,date) to authenticated;
