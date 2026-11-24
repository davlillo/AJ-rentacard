-- Optional work identity, never an authenticated assignment or permission.
-- No backfill: legacy tasks keep NULL. Rollback retains this column and its data.
alter table public.workshop_tasks add column if not exists responsible_name text;

-- Narrow replacement of 20261022000300: keep original locking, authorization,
-- original-payload replay identity, versions, assignment eligibility and single mutation.
create or replace function public.execute_task_command(command text, payload jsonb, idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  task public.workshop_tasks;
  prior private.command_results;
  request jsonb := jsonb_build_object('command','task.' || command,'payload',payload);
  result jsonb;
  assignee uuid;
  new_assignee_label text;
  new_responsible_name text;
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
  -- Transition authority must never become metadata-edit authority.
  if payload ? 'responsibleName' then
    if command = 'transition' then raise exception 'UNSUPPORTED_TASK_METADATA'; end if;
    if jsonb_typeof(payload->'responsibleName') not in ('string','null') then
      raise exception 'INVALID_RESPONSIBLE_NAME';
    end if;
    new_responsible_name := nullif(btrim(payload->>'responsibleName', E' \t\n\r\013\014'),'');
    if length(new_responsible_name) > 120 then raise exception 'INVALID_RESPONSIBLE_NAME'; end if;
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
    insert into public.workshop_tasks(order_id,description,assigned_to,assignee_label,created_by,responsible_name)
    values (payload->>'orderId',btrim(payload->>'description'),assignee,new_assignee_label,auth.uid(),new_responsible_name)
      returning * into task;
  elsif command = 'assign' then
    if task.status = 'Finalizada' then raise exception 'TASK_ALREADY_COMPLETED'; end if;
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'ASSIGNMENT_REASON_REQUIRED'; end if;
    update public.workshop_tasks set assigned_to = assignee,assignee_label = new_assignee_label,
      responsible_name = case when payload ? 'responsibleName' then new_responsible_name else task.responsible_name end,
      last_reason = btrim(payload->>'reason'),version = version + 1 where id = task.id returning * into task;
  else
    if not ((task.status = 'Pendiente' and payload->>'status' = 'En proceso')
      or (task.status = 'En proceso' and payload->>'status' = 'Finalizada')) then raise exception 'INVALID_TASK_TRANSITION'; end if;
    update public.workshop_tasks set status = payload->>'status',last_reason = 'State transition',version = version + 1
      where id = task.id returning * into task;
  end if;
  -- Do not change any sibling task, vehicle or work order status here.
  result := jsonb_build_object('id',task.id,'version',task.version,'status',task.status);
  -- Only new metadata requests need an acknowledgement; legacy result shape stays identical.
  if payload ? 'responsibleName' then result := result || '{"responsibleNameSupported":true}'::jsonb; end if;
  insert into private.command_results values (auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;
revoke all on function public.execute_task_command(text,jsonb,uuid) from public, anon;
grant execute on function public.execute_task_command(text,jsonb,uuid) to authenticated;
