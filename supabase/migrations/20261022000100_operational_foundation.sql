-- HU01-HU04. Business mutations are transactional RPCs, never browser CRUD.
create schema if not exists private;
revoke all on schema private from public;
alter default privileges revoke execute on functions from public;

create table public.user_roles (
  user_id uuid references auth.users on delete cascade,
  role text check (role in ('owner','admin','reception','technician','accountant')),
  primary key (user_id, role)
);
create function public.has_permission(permission text) returns boolean
language sql stable security definer set search_path = '' as $$
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
revoke all on function public.has_permission(text) from public, anon;
grant execute on function public.has_permission(text) to authenticated;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  phone text not null check (length(regexp_replace(phone, '[^0-9]', '', 'g')) between 7 and 15),
  document text not null default '',
  email text not null default '',
  type text not null check (type in ('Personal','Empresa')),
  phone_key text generated always as (regexp_replace(phone, '[^0-9]', '', 'g')) stored,
  document_key text generated always as (upper(regexp_replace(document, '[^a-zA-Z0-9]', '', 'g'))) stored,
  merged_into uuid references public.customers,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  check (merged_into is distinct from id)
);
create index customers_phone on public.customers(phone_key);
create index customers_document on public.customers(document_key) where document_key <> '';
create table public.customer_aliases (
  source_id uuid primary key references public.customers,
  customer_id uuid not null references public.customers,
  snapshot jsonb not null,
  phone_key text not null,
  document_key text not null,
  created_at timestamptz not null default now()
);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  plate text not null,
  plate_key text generated always as (upper(regexp_replace(plate, '[^a-zA-Z0-9]', '', 'g'))) stored unique,
  vin text,
  brand text not null check (length(btrim(brand)) > 0),
  model text not null check (length(btrim(model)) > 0),
  year integer not null check (year between 1900 and 2100),
  category text not null,
  color text not null,
  daily numeric(14,2) not null default 0 check (daily >= 0 and daily::text not in ('NaN','Infinity')),
  km integer not null default 0 check (km >= 0),
  ownership text not null check (ownership in ('Propio','Cliente')),
  owner_customer_id uuid references public.customers,
  status text not null default 'Disponible' check (status in ('Disponible','Alquilado','En taller')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  check ((ownership = 'Propio' and owner_customer_id is null)
    or (ownership = 'Cliente' and owner_customer_id is not null)),
  check (length(plate_key) > 0)
);
create sequence public.work_order_folio;
create table public.work_orders (
  id text primary key default ('OT-' || nextval('public.work_order_folio')::text),
  vehicle_id uuid not null references public.vehicles,
  customer_id uuid not null references public.customers,
  area text not null check (area in ('Mecánica','Pintura')),
  service text not null check (length(btrim(service)) between 1 and 2000),
  technician text not null default 'Sin asignar',
  status text not null default 'Diagnóstico',
  hours numeric(10,2) not null default 0,
  estimate numeric(14,2) not null default 0,
  paid numeric(14,2) not null default 0,
  due date not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users,
  pending_fields text[] not null default array['kilometraje','condición','accesorios','fotos'],
  version integer not null default 1
);
create unique index one_open_order_per_vehicle on public.work_orders(vehicle_id) where status <> 'Entregado';
create index work_orders_customer on public.work_orders(customer_id);
create index work_orders_vehicle on public.work_orders(vehicle_id, occurred_at);
create table public.cost_centers (
  id text primary key,
  name text not null
);
insert into public.cost_centers values ('administration','Administración'),('workshop','Taller'),('rental','Renta');
create sequence public.expense_folio;
create table public.expenses (
  id text primary key default ('EG-' || nextval('public.expense_folio')::text),
  date date not null,
  concept text not null check (length(btrim(concept)) between 1 and 2000),
  category text not null check (length(btrim(category)) > 0),
  amount numeric(14,2) not null check (amount > 0 and amount::text not in ('NaN','Infinity')),
  currency text not null default 'USD' check (currency = 'USD'),
  method text not null check (method in ('Efectivo','Transferencia','Tarjeta')),
  account text not null check (length(btrim(account)) > 0),
  operation_id text references public.work_orders,
  cost_center_id text references public.cost_centers,
  support text not null default '',
  disposition text not null default 'Pendiente',
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  check (num_nonnulls(operation_id, cost_center_id) = 1)
);
create index expenses_operation on public.expenses(operation_id);
create index expenses_date on public.expenses(date);
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor uuid references auth.users,
  entity text not null,
  entity_id text not null,
  action text not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create table private.command_results (
  actor uuid not null references auth.users,
  key uuid not null,
  request jsonb not null,
  result jsonb not null,
  primary key (actor,key)
);
create function private.audit_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_events(actor, entity, entity_id, action, before_data, after_data)
  values (auth.uid(), TG_TABLE_NAME, new.id::text, TG_OP,
    case when TG_OP = 'UPDATE' then to_jsonb(old) else null end, to_jsonb(new));
  return new;
end;
$$;
create trigger customer_audit after insert or update on public.customers
for each row execute function private.audit_change();
create trigger vehicle_audit after insert or update on public.vehicles
for each row execute function private.audit_change();
create trigger order_audit after insert or update on public.work_orders
for each row execute function private.audit_change();
create trigger expense_audit after insert on public.expenses
for each row execute function private.audit_change();

-- Browser roles can only read permitted rows. Writes go through authorized RPCs.
alter table public.user_roles enable row level security;
alter table public.customers enable row level security;
alter table public.customer_aliases enable row level security;
alter table public.vehicles enable row level security;
alter table public.work_orders enable row level security;
alter table public.cost_centers enable row level security;
alter table public.expenses enable row level security;
alter table public.audit_events enable row level security;
create policy own_roles on public.user_roles for select to authenticated using (user_id = auth.uid());
create policy customers_read on public.customers for select to authenticated using (public.has_permission('customers.read'));
create policy aliases_read on public.customer_aliases for select to authenticated using (public.has_permission('customers.read'));
create policy vehicles_read on public.vehicles for select to authenticated using (public.has_permission('vehicles.read'));
create policy orders_read on public.work_orders for select to authenticated using (public.has_permission('orders.read'));
create policy centers_read on public.cost_centers for select to authenticated using (public.has_permission('expenses.write'));
create policy expenses_read on public.expenses for select to authenticated using (public.has_permission('expenses.read'));
create policy audit_read on public.audit_events for select to authenticated using (
  exists(select 1 from public.user_roles where user_id = auth.uid() and role = 'owner')
);
revoke all on public.user_roles, public.customers, public.customer_aliases, public.vehicles,
  public.work_orders, public.cost_centers, public.expenses, public.audit_events from anon, authenticated;
grant select on public.user_roles, public.customers, public.customer_aliases, public.vehicles,
  public.work_orders, public.cost_centers, public.expenses, public.audit_events to authenticated;
grant all on public.user_roles to service_role;

create function public.customer_matches(phone text default '', document text default '')
returns setof public.customers language sql stable security invoker set search_path = '' as $$
  select distinct c.* from public.customers c left join public.customer_aliases a on a.customer_id = c.id
  where c.merged_into is null and (
    (regexp_replace(customer_matches.phone, '[^0-9]', '', 'g') <> '' and
      regexp_replace(customer_matches.phone, '[^0-9]', '', 'g') in (c.phone_key,a.phone_key))
    or (upper(regexp_replace(customer_matches.document, '[^a-zA-Z0-9]', '', 'g')) <> '' and
      upper(regexp_replace(customer_matches.document, '[^a-zA-Z0-9]', '', 'g')) in (c.document_key,a.document_key))
  );
$$;
revoke all on function public.customer_matches(text,text) from public, anon;
grant execute on function public.customer_matches(text,text) to authenticated;

create function public.execute_command(command text, payload jsonb, idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.execute_command(text,jsonb,uuid) from public, anon;
grant execute on function public.execute_command(text,jsonb,uuid) to authenticated;
