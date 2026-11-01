-- HU26-HU28: a bounded, source-grounded assistant; confirmation never trusts a mutable client draft.
create table public.agent_expense_proposals (
  id uuid primary key default gen_random_uuid(),actor uuid not null references auth.users,
  payload jsonb not null,payload_hash text not null,expires_at timestamptz not null,
  result jsonb,created_at timestamptz not null default now()
);
alter table public.agent_expense_proposals enable row level security;
revoke all on public.agent_expense_proposals from anon,authenticated;
grant select on public.agent_expense_proposals to authenticated;
create policy agent_proposal_read on public.agent_expense_proposals for select to authenticated using(actor=auth.uid() and public.has_permission('expenses.write'));
create trigger agent_proposal_audit after insert or update on public.agent_expense_proposals for each row execute function private.audit_change();
create function public.agent_vehicle_cost(vehicle_ref text,order_ref text,cutoff date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare car public.vehicles;orders jsonb;sources jsonb;total numeric;selected_order_id text;
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if cutoff is null or not isfinite(cutoff) then raise exception 'CUTOFF_REQUIRED';end if;
  select * into car from public.vehicles where id::text=vehicle_ref or plate_key=upper(regexp_replace(vehicle_ref,'[^a-zA-Z0-9]','','g'));
  if car.id is null then raise exception 'VEHICLE_NOT_FOUND';end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'service',o.service)),'[]') into orders from public.work_orders o where o.vehicle_id=car.id;
  if nullif(order_ref,'') is null and jsonb_array_length(orders)>1 then
    return jsonb_build_object('requiresSelection',true,'vehicleId',car.id,'plate',car.plate,'operations',orders,'cutoff',cutoff);
  end if;
  selected_order_id:=coalesce(nullif(order_ref,''),orders->0->>'id');
  if selected_order_id is not null and not exists(select 1 from public.work_orders o where o.id=selected_order_id and o.vehicle_id=car.id) then raise exception 'OPERATION_VEHICLE_MISMATCH';end if;
  select coalesce(jsonb_agg(to_jsonb(rows)),'[]'),coalesce(sum(rows.amount),0) into sources,total from (
    select c.id,c.order_id,c.expense_id,c.description,(history.data->>'amount')::numeric amount,c.occurred_at
    from public.workshop_costs c cross join lateral(select a.after_data data from public.audit_events a
      where a.entity='workshop_costs' and a.entity_id=c.id::text and a.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'
      order by a.created_at desc,a.id desc limit 1) history where c.order_id=selected_order_id and c.occurred_at<=cutoff
  ) rows;
  return jsonb_build_object('policy','actual-direct-cost-sources-v1','requiresSelection',false,'vehicleId',car.id,'plate',car.plate,
    'operationId',selected_order_id,'cutoff',cutoff,'total',total,'sources',sources,'limitation','Excludes unvalued labor and unallocated overhead; not total lifetime ownership cost.');
end;
$$;
create function public.propose_agent_expense(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','agent.propose-expense','payload',payload);
  normalized jsonb;mapping jsonb;proposal public.agent_expense_proposals;result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  select jsonb_object_agg(key,key) into mapping from jsonb_object_keys(payload) key;
  normalized:=private.normalize_import_expense(jsonb_build_object('cells',payload),mapping);
  insert into public.agent_expense_proposals(actor,payload,payload_hash,expires_at)
  values(auth.uid(),normalized,encode(sha256(convert_to(normalized::text,'UTF8')),'hex'),clock_timestamp()+interval '15 minutes') returning * into proposal;
  result:=to_jsonb(proposal);insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;
create function public.confirm_agent_expense(proposal_id uuid,expected_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare proposal public.agent_expense_proposals;confirmed_result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into proposal from public.agent_expense_proposals where id=proposal_id and actor=auth.uid() for update;
  if proposal.id is null or expected_hash is distinct from proposal.payload_hash then raise exception 'PROPOSAL_CONFIRMATION_MISMATCH';end if;
  if proposal.result is not null then return proposal.result;end if;
  if proposal.expires_at<clock_timestamp() then raise exception 'PROPOSAL_EXPIRED';end if;
  confirmed_result:=public.execute_command('record_expense',proposal.payload,proposal.id);
  update public.agent_expense_proposals set result=confirmed_result where id=proposal.id;
  return confirmed_result;
end;
$$;
create function public.administration_users() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'email',u.email,'roles',
    coalesce((select jsonb_agg(r.role) from public.user_roles r where r.user_id=u.id),'[]'))) from auth.users u),'[]');
end;
$$;
create function public.execute_administration_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','administration.'||command,'payload',payload);result jsonb;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if command is null or command not in ('grant_role','revoke_role','cost_center') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_ADMINISTRATION_COMMAND';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='cost_center' then
    insert into public.cost_centers(id,name) values(btrim(payload->>'id'),btrim(payload->>'name'))
      on conflict(id) do update set name=excluded.name returning to_jsonb(cost_centers.*) into result;
  else
    if payload->>'role' not in ('owner','admin','reception','technician','accountant') then raise exception 'INVALID_ROLE';end if;
    if command='grant_role' then
      insert into public.user_roles values((payload->>'userId')::uuid,payload->>'role') on conflict do nothing;
    else
      if payload->>'role'='owner' and (select count(*) from public.user_roles where role='owner')<=1 then raise exception 'LAST_OWNER_CANNOT_BE_REMOVED';end if;
      delete from public.user_roles where user_id=(payload->>'userId')::uuid and role=payload->>'role';
    end if;
    result:=payload;
  end if;
  insert into public.audit_events(actor,entity,entity_id,action,after_data)
  values(auth.uid(),'administration',coalesce(payload->>'userId',payload->>'id'),command,payload);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;
revoke all on function public.agent_vehicle_cost(text,text,date),public.propose_agent_expense(jsonb,uuid),public.confirm_agent_expense(uuid,text),public.administration_users(),public.execute_administration_command(text,jsonb,uuid) from public,anon;
grant execute on function public.agent_vehicle_cost(text,text,date),public.propose_agent_expense(jsonb,uuid),public.confirm_agent_expense(uuid,text),public.administration_users(),public.execute_administration_command(text,jsonb,uuid) to authenticated;
