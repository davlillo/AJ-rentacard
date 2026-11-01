-- HU12: delivery is an authorized decision over a frozen, server-computed checklist.
create table public.workshop_deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique references public.work_orders,
  recipient text not null check(length(btrim(recipient))>0),
  evidence text not null check(length(btrim(evidence))>0),
  exception boolean not null,
  reason text not null,
  credit_reason text not null default '',
  checklist jsonb not null,
  responsible_id uuid not null references auth.users,
  created_at timestamptz not null default now(),
  check(not exception or length(btrim(reason))>0)
);
alter table public.workshop_deliveries enable row level security;
revoke all on public.workshop_deliveries from anon,authenticated;
grant select on public.workshop_deliveries to authenticated;
create policy delivery_read on public.workshop_deliveries for select to authenticated using(public.has_permission('expenses.read'));
create trigger delivery_audit after insert on public.workshop_deliveries for each row execute function private.audit_change();
create trigger delivery_immutable before update or delete on public.workshop_deliveries for each row execute function private.immutable_quote_record();

create function private.delivery_checklist(order_id text) returns jsonb language plpgsql stable set search_path='' as $$
declare
  service_order public.work_orders;
  quote public.estimate_versions;
  costs jsonb;
  tasks jsonb;
  timers jsonb;
  unpaid numeric;
begin
  select * into service_order from public.work_orders o where o.id=order_id;
  if service_order.id is null then raise exception 'ORDER_NOT_FOUND'; end if;
  select * into quote from public.estimate_versions where estimate_versions.order_id=service_order.id order by revision desc limit 1;
  select coalesce(jsonb_agg(to_jsonb(c)),'[]') into costs from public.workshop_costs c where c.order_id=service_order.id;
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into tasks from public.workshop_tasks t where t.order_id=service_order.id and status<>'Finalizada';
  select coalesce(jsonb_agg(to_jsonb(timer)),'[]') into timers from public.task_timers timer
    join public.workshop_tasks t on t.id=timer.task_id where t.order_id=service_order.id and timer.state<>'Finalizado';
  unpaid:=case when exists(select 1 from public.vehicles where id=service_order.vehicle_id and ownership='Propio')
    then 0 else greatest(service_order.estimate-service_order.paid,0) end;
  return jsonb_build_object('orderId',service_order.id,'version',service_order.version,'status',service_order.status,
    'pendingFields',service_order.pending_fields,'costs',costs,'pendingCosts',
    (select count(*) from public.workshop_costs where workshop_costs.order_id=service_order.id and disposition='Pendiente'),
    'openTasks',tasks,'openTimers',timers,'pendingEstimate',case when quote.status='Borrador' then quote.id else null end,
    'approvedEstimateId',service_order.active_estimate_id,'estimatedUnpaid',unpaid,
    'balancePolicy','quote-minus-recorded-paid-v1; replace with document ledger under RF15');
end;
$$;
create function public.workshop_delivery_checklist(order_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  return private.delivery_checklist(order_id);
end;
$$;
create function public.deliver_workshop_order(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','workshop.deliver','payload',payload);
  service_order public.work_orders;
  checklist jsonb;
  is_exception boolean;
  delivery public.workshop_deliveries;
  result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_DELIVERY_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  select * into service_order from public.work_orders where id=payload->>'orderId' for update;
  if service_order.id is null or service_order.status='Entregado' then raise exception 'ORDER_NOT_OPEN'; end if;
  if (payload->>'expectedVersion')::integer is distinct from service_order.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
  checklist:=private.delivery_checklist(service_order.id);
  is_exception:=coalesce((payload->>'exception')::boolean,false);
  if jsonb_array_length(checklist->'openTimers')>0 then raise exception 'DELIVERY_HAS_OPEN_TIMERS'; end if;
  if is_exception then
    if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then
      raise exception using errcode='42501',message='DELIVERY_EXCEPTION_REQUIRES_MANAGEMENT'; end if;
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'DELIVERY_EXCEPTION_REASON_REQUIRED'; end if;
  elsif (checklist->>'pendingCosts')::integer>0 or jsonb_array_length(checklist->'openTasks')>0
    or checklist->>'pendingEstimate' is not null then raise exception 'DELIVERY_HAS_PENDING_ITEMS';
  end if;
  if (checklist->>'estimatedUnpaid')::numeric>0 and (
    nullif(btrim(payload->>'creditReason'),'') is null or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner')
  ) then raise exception 'DELIVERY_REQUIRES_CREDIT_AUTHORIZATION'; end if;
  -- Partial reception fields remain visible in the act, never silently marked as completed.
  if jsonb_array_length(checklist->'pendingFields')>0 and coalesce((payload->>'acknowledgePendingReception')::boolean,false) is not true
    then raise exception 'ACKNOWLEDGE_PENDING_RECEPTION'; end if;
  insert into public.workshop_deliveries(order_id,recipient,evidence,exception,reason,credit_reason,checklist,responsible_id)
  values(service_order.id,btrim(payload->>'recipient'),btrim(payload->>'evidence'),is_exception,
    coalesce(btrim(payload->>'reason'),''),coalesce(btrim(payload->>'creditReason'),''),checklist,auth.uid()) returning * into delivery;
  update public.work_orders set status='Entregado',version=version+1 where id=service_order.id;
  -- A fleet vehicle still requires scheduling/cleaning release; delivery is not rental availability.
  update public.vehicles set status=case when ownership='Cliente' then 'Disponible' else 'En taller' end,
    version=version+1 where id=service_order.vehicle_id;
  result:=to_jsonb(delivery);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;
revoke all on function public.workshop_delivery_checklist(text),public.deliver_workshop_order(jsonb,uuid) from public,anon;
grant execute on function public.workshop_delivery_checklist(text),public.deliver_workshop_order(jsonb,uuid) to authenticated;
