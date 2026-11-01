-- HU10: destination-bound actual costs are not automatically cash payments or customer charges.
create table public.workshop_costs (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.work_orders,
  kind text not null check(kind in ('Compra directa','Gasto')),
  description text not null check(length(btrim(description)) between 1 and 2000),
  quantity numeric(14,4) not null check(quantity>0 and quantity::text not in ('NaN','Infinity')),
  unit_cost numeric(18,4) not null check(unit_cost>=0 and unit_cost::text not in ('NaN','Infinity')),
  amount numeric(14,2) not null check(amount>0 and amount::text not in ('NaN','Infinity')),
  expense_id text unique references public.expenses,
  supplier text not null default '',
  source_reference text not null default '',
  disposition text not null default 'Pendiente' check(disposition in ('Pendiente','Incluido','Adicional autorizado','Interno','Absorbido')),
  estimate_id uuid references public.estimate_versions,
  version integer not null default 1,
  reason text not null default 'Registro inicial',
  occurred_at date not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  check((kind='Gasto' and expense_id is not null) or (kind='Compra directa' and expense_id is null)),
  check(kind<>'Compra directa' or (length(btrim(supplier))>0 and length(btrim(source_reference))>0))
);
create unique index direct_purchase_reference on public.workshop_costs(lower(btrim(supplier)),lower(btrim(source_reference)))
  where kind='Compra directa';
create index workshop_cost_order on public.workshop_costs(order_id);
alter table public.workshop_costs enable row level security;
revoke all on public.workshop_costs from anon,authenticated;
grant select on public.workshop_costs to authenticated;
create policy workshop_cost_read on public.workshop_costs for select to authenticated using(public.has_permission('expenses.read'));
create trigger workshop_cost_audit after insert or update on public.workshop_costs for each row execute function private.audit_change();

-- Preserve the identity of existing/imported cash expenses: one cost, never another ledger payment.
insert into public.workshop_costs(order_id,kind,description,quantity,unit_cost,amount,expense_id,occurred_at,created_by,created_at)
select operation_id,'Gasto',concept,1,amount,amount,id,date,created_by,created_at from public.expenses where operation_id is not null;
create function private.expense_to_workshop_cost() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.operation_id is not null then
    insert into public.workshop_costs(order_id,kind,description,quantity,unit_cost,amount,expense_id,occurred_at,created_by)
    values(new.operation_id,'Gasto',new.concept,1,new.amount,new.amount,new.id,new.date,new.created_by);
  end if;
  return new;
end;
$$;
create trigger expense_cost after insert on public.expenses for each row execute function private.expense_to_workshop_cost();

create function public.execute_cost_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
      if exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership='Propio') then raise exception 'INTERNAL_VEHICLE_NOT_A_SALE'; end if;
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
create trigger expense_update_audit after update on public.expenses for each row execute function private.audit_change();
revoke all on function public.execute_cost_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_cost_command(text,jsonb,uuid) to authenticated;
