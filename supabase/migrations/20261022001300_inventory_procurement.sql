-- HU20/HU21: inventory receipt is not consumption, cash payment or a duplicate order cost.
create table public.stock_items (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique check(length(btrim(sku))>0),
  name text not null check(length(btrim(name))>0),
  unit text not null check(length(btrim(unit))>0),
  quantity numeric(18,4) not null default 0 check(quantity>=0),
  stock_value numeric(18,2) not null default 0 check(stock_value>=0),
  valuation_policy text not null default 'moving-weighted-average-v1',
  version integer not null default 1,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.stock_items,
  supplier text not null check(length(btrim(supplier))>0),
  quantity numeric(18,4) not null check(quantity>0),
  unit_cost numeric(18,4) not null check(unit_cost>0),
  status text not null default 'Solicitada' check(status in ('Solicitada','Autorizada','Recibida')),
  reason text not null check(length(btrim(reason))>0),
  authorized_by uuid references auth.users,
  version integer not null default 1,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.stock_items,
  order_id text references public.work_orders,
  purchase_id uuid references public.purchase_orders,
  reverses_id uuid references public.stock_movements,
  kind text not null check(kind in ('Entrada','Consumo','Devolucion')),
  quantity numeric(18,4) not null check(quantity>0),
  unit_cost numeric(18,4) not null check(unit_cost>=0),
  amount numeric(18,2) not null check(amount>=0),
  reason text not null check(length(btrim(reason))>0),
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  check((kind='Consumo' and order_id is not null) or kind<>'Consumo'),
  check((kind='Devolucion')=(reverses_id is not null))
);
create table public.supplier_obligations (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchase_orders,
  receipt_id uuid not null unique references public.stock_movements,
  supplier text not null,
  amount numeric(18,2) not null check(amount>=0),
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
do $$ declare tbl text; begin
  foreach tbl in array array['stock_items','purchase_orders','stock_movements','supplier_obligations'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from anon,authenticated',tbl);
    execute format('grant select on public.%I to authenticated',tbl);
    execute format('create policy inventory_read on public.%I for select to authenticated using(public.has_permission(''expenses.read''))',tbl);
    execute format('create trigger inventory_audit after insert or update on public.%I for each row execute function private.audit_change()',tbl);
  end loop;
end $$;
create trigger stock_movement_immutable before update or delete on public.stock_movements for each row execute function private.immutable_quote_record();
create trigger obligation_immutable before update or delete on public.supplier_obligations for each row execute function private.immutable_quote_record();
alter table public.workshop_costs add column stock_dispatch_id uuid unique references public.stock_movements;
do $$ declare constraint_name text; begin
  for constraint_name in select conname from pg_constraint where conrelid='public.workshop_costs'::regclass and contype='c'
    and (pg_get_constraintdef(oid) like '%kind%' or pg_get_constraintdef(oid) like '%amount%' or pg_get_constraintdef(oid) like '%quantity%') loop
    execute format('alter table public.workshop_costs drop constraint %I',constraint_name);
  end loop;
end $$;
alter table public.workshop_costs add constraint cost_kind check(kind in ('Gasto','Compra directa','Consumo')),
  add constraint cost_source check((kind='Gasto' and expense_id is not null) or (kind<>'Gasto' and expense_id is null)),
  add constraint direct_purchase_source check(kind<>'Compra directa' or (length(btrim(supplier))>0 and length(btrim(source_reference))>0)),
  add constraint cost_amount check(amount>=0 and amount::text not in ('NaN','Infinity') and (kind='Consumo' or amount>0)),
  add constraint cost_quantity check(quantity>=0 and quantity::text not in ('NaN','Infinity') and (kind='Consumo' or quantity>0)),
  add constraint stock_cost_source check((kind='Consumo')=(stock_dispatch_id is not null));

create function public.execute_inventory_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
revoke all on function public.execute_inventory_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_inventory_command(text,jsonb,uuid) to authenticated;
