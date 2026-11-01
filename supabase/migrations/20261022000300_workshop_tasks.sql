-- HU07: assignments and per-task states, independent from operational order closure.
create table public.workshop_tasks (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.work_orders,
  description text not null check (length(btrim(description)) between 1 and 2000),
  assigned_to uuid not null references auth.users,
  assignee_label text not null,
  status text not null default 'Pendiente' check (status in ('Pendiente','En proceso','Finalizada')),
  version integer not null default 1,
  last_reason text not null default 'Created',
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
create index workshop_tasks_order on public.workshop_tasks(order_id,created_at);
create index workshop_tasks_assignee on public.workshop_tasks(assigned_to,status);
alter table public.workshop_tasks enable row level security;
revoke all on public.workshop_tasks from anon, authenticated;
grant select on public.workshop_tasks to authenticated;

create function public.has_task_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_permission('orders.write') or exists (
    select 1 from public.user_roles where user_id = auth.uid() and role = 'technician'
  );
$$;
revoke all on function public.has_task_access() from public, anon;
grant execute on function public.has_task_access() to authenticated;
create policy task_read on public.workshop_tasks for select to authenticated using (
  public.has_permission('orders.read') or (assigned_to = auth.uid() and public.has_task_access())
);
create trigger task_audit after insert or update on public.workshop_tasks
for each row execute function private.audit_change();

create function public.workshop_assignees() returns table(id uuid, label text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission('orders.write') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  return query select u.id,coalesce(u.email,u.id::text) from auth.users u where exists (
    select 1 from public.user_roles r where r.user_id = u.id and r.role in ('owner','admin','reception','technician')
  ) order by u.email;
end;
$$;
revoke all on function public.workshop_assignees() from public, anon;
grant execute on function public.workshop_assignees() to authenticated;

create function public.execute_task_command(command text, payload jsonb, idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  task public.workshop_tasks;
  prior private.command_results;
  request jsonb := jsonb_build_object('command','task.' || command,'payload',payload);
  result jsonb;
  assignee uuid;
  new_assignee_label text;
begin
  if command not in ('create','assign','transition') or command is null or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_TASK_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  if command <> 'create' then
    select * into task from public.workshop_tasks where id = (payload->>'taskId')::uuid for update;
  end if;
  if not public.has_permission('orders.write') and not coalesce((
    command = 'transition' and public.has_task_access() and task.assigned_to = auth.uid()
  ),false) then raise exception using errcode = '42501', message = 'PERMISSION_DENIED'; end if;
  select * into prior from private.command_results where actor = auth.uid() and key = idempotency_key;
  if found then
    if prior.request <> request then raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if command <> 'create' and task.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  if not exists (select 1 from public.work_orders where id = coalesce(task.order_id,payload->>'orderId') and status <> 'Entregado') then
    raise exception 'ORDER_NOT_OPEN';
  end if;
  if command <> 'create' and (payload->>'expectedVersion')::integer is distinct from task.version then
    raise exception using errcode = '23505', message = 'VERSION_CONFLICT';
  end if;
  if command in ('create','assign') then
    assignee := (payload->>'assignedTo')::uuid;
    select coalesce(u.email,u.id::text) into new_assignee_label from auth.users u where u.id = assignee and exists (
      select 1 from public.user_roles r where r.user_id = u.id and r.role in ('owner','admin','reception','technician')
    );
    if new_assignee_label is null then raise exception 'INVALID_ASSIGNEE'; end if;
  end if;
  if command = 'create' then
    insert into public.workshop_tasks(order_id,description,assigned_to,assignee_label,created_by)
    values (payload->>'orderId',btrim(payload->>'description'),assignee,new_assignee_label,auth.uid()) returning * into task;
  elsif command = 'assign' then
    if task.status = 'Finalizada' then raise exception 'TASK_ALREADY_COMPLETED'; end if;
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'ASSIGNMENT_REASON_REQUIRED'; end if;
    update public.workshop_tasks set assigned_to = assignee,assignee_label = new_assignee_label,
      last_reason = btrim(payload->>'reason'),version = version + 1 where id = task.id returning * into task;
  else
    if not ((task.status = 'Pendiente' and payload->>'status' = 'En proceso')
      or (task.status = 'En proceso' and payload->>'status' = 'Finalizada')) then raise exception 'INVALID_TASK_TRANSITION'; end if;
    update public.workshop_tasks set status = payload->>'status',last_reason = 'State transition',version = version + 1
      where id = task.id returning * into task;
  end if;
  -- Do not change any sibling task, vehicle or work order status here.
  result := jsonb_build_object('id',task.id,'version',task.version,'status',task.status);
  insert into private.command_results values (auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;
revoke all on function public.execute_task_command(text,jsonb,uuid) from public, anon;
grant execute on function public.execute_task_command(text,jsonb,uuid) to authenticated;
