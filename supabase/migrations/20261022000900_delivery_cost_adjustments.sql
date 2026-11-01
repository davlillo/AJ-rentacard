-- Closed acts stay immutable; late costs/disposition corrections are separate, audited owner decisions.
create function public.execute_delivery_cost_adjustment(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
      if exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership='Propio') then raise exception 'INTERNAL_VEHICLE_NOT_A_SALE'; end if;
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
revoke all on function public.execute_delivery_cost_adjustment(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_delivery_cost_adjustment(text,jsonb,uuid) to authenticated;
