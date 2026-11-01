-- HU11: active intervals use server time; pauses never produce active seconds.
create table public.task_timers (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.workshop_tasks,
  worker_id uuid not null references auth.users,
  state text not null check(state in ('Activo','Pausado','Finalizado')),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  version integer not null default 1,
  created_by uuid not null references auth.users,
  check((state='Finalizado')=(finished_at is not null))
);
create unique index one_live_timer_per_task_worker on public.task_timers(task_id,worker_id) where state<>'Finalizado';
create unique index one_active_timer_per_worker on public.task_timers(worker_id) where state='Activo';
create table public.task_time_spans (
  id uuid primary key default gen_random_uuid(),
  timer_id uuid not null references public.task_timers,
  started_at timestamptz not null,
  ended_at timestamptz,
  active_seconds numeric generated always as (extract(epoch from (ended_at-started_at))) stored,
  version integer not null default 1,
  reason text not null,
  created_by uuid not null references auth.users,
  updated_by uuid not null references auth.users,
  check(ended_at is null or ended_at>=started_at)
);
create unique index one_open_span_per_timer on public.task_time_spans(timer_id) where ended_at is null;
alter table public.task_timers enable row level security;
alter table public.task_time_spans enable row level security;
revoke all on public.task_timers,public.task_time_spans from anon,authenticated;
grant select on public.task_timers,public.task_time_spans to authenticated;
create policy timer_read on public.task_timers for select to authenticated using(
  public.has_permission('orders.read') or (worker_id=auth.uid() and public.has_task_access()));
create policy time_span_read on public.task_time_spans for select to authenticated using(
  exists(select 1 from public.task_timers timer where timer.id=timer_id));
create trigger timer_audit after insert or update on public.task_timers for each row execute function private.audit_change();
create trigger time_span_audit after insert or update on public.task_time_spans for each row execute function private.audit_change();

create function private.task_timer_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (new.assigned_to<>old.assigned_to or new.status='Finalizada') and exists(
    select 1 from public.task_timers where task_id=new.id and state<>'Finalizado'
  ) then raise exception 'TASK_HAS_OPEN_TIMER'; end if;
  return new;
end;
$$;
create trigger task_timer_guard before update on public.workshop_tasks for each row execute function private.task_timer_guard();

create function public.execute_time_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','time.'||command,'payload',payload);
  task public.workshop_tasks;
  timer public.task_timers;
  span public.task_time_spans;
  server_time timestamptz;
  corrected_start timestamptz;
  corrected_end timestamptz;
  result jsonb;
begin
  if command is null or command not in ('start','pause','resume','finish','correct') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_TIME_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  server_time:=clock_timestamp();
  if command='start' then
    select * into task from public.workshop_tasks where id=(payload->>'taskId')::uuid;
  else
    if command='correct' then
      select * into span from public.task_time_spans where id=(payload->>'spanId')::uuid;
      select * into timer from public.task_timers where id=span.timer_id;
    else
      select * into timer from public.task_timers where id=(payload->>'timerId')::uuid;
    end if;
    select * into task from public.workshop_tasks where id=timer.task_id;
  end if;
  if task.id is null or not(public.has_permission('orders.write') or
    (public.has_task_access() and coalesce(timer.worker_id,task.assigned_to)=auth.uid())) then
    raise exception using errcode='42501',message='PERMISSION_DENIED';
  end if;
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if not exists(select 1 from public.work_orders where id=task.order_id and status<>'Entregado') then raise exception 'ORDER_NOT_OPEN'; end if;
  if command='start' then
    if task.assigned_to<>auth.uid() or task.status<>'En proceso' then raise exception 'TIME_REQUIRES_ASSIGNED_ACTIVE_TASK'; end if;
    if exists(select 1 from public.task_timers where (task_id=task.id and worker_id=auth.uid() and state<>'Finalizado')
      or (worker_id=auth.uid() and state='Activo')) then raise exception 'WORKER_HAS_OPEN_TIMER'; end if;
    insert into public.task_timers(task_id,worker_id,state,started_at,created_by)
    values(task.id,auth.uid(),'Activo',server_time,auth.uid()) returning * into timer;
    insert into public.task_time_spans(timer_id,started_at,reason,created_by,updated_by)
    values(timer.id,server_time,'Inicio de trabajo',auth.uid(),auth.uid());
  elsif command='correct' then
    if span.ended_at is null or timer.state<>'Finalizado' then raise exception 'ONLY_FINISHED_TIME_CAN_BE_CORRECTED'; end if;
    if (payload->>'expectedVersion')::integer is distinct from span.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'TIME_REASON_REQUIRED'; end if;
    corrected_start:=(payload->>'startedAt')::timestamptz;corrected_end:=(payload->>'endedAt')::timestamptz;
    if corrected_start is null or corrected_end is null or not isfinite(corrected_start) or not isfinite(corrected_end)
      or corrected_end<corrected_start or corrected_start<timer.started_at or corrected_end>timer.finished_at
      or corrected_end>server_time then raise exception 'INVALID_TIME_RANGE'; end if;
    if exists(select 1 from public.task_time_spans s join public.task_timers other_timer on other_timer.id=s.timer_id
      where other_timer.worker_id=timer.worker_id and s.id<>span.id
      and s.started_at<corrected_end and coalesce(s.ended_at,server_time)>corrected_start) then raise exception 'TIME_OVERLAP'; end if;
    update public.task_time_spans set started_at=corrected_start,ended_at=corrected_end,version=version+1,
      reason=btrim(payload->>'reason'),updated_by=auth.uid() where id=span.id returning * into span;
  else
    if (payload->>'expectedVersion')::integer is distinct from timer.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    if not((command='pause' and timer.state='Activo') or (command='resume' and timer.state='Pausado')
      or (command='finish' and timer.state in ('Activo','Pausado'))) then raise exception 'INVALID_TIMER_TRANSITION'; end if;
    if command='resume' then
      if task.status<>'En proceso' then raise exception 'TIME_REQUIRES_ASSIGNED_ACTIVE_TASK'; end if;
      if exists(select 1 from public.task_timers where worker_id=timer.worker_id and state='Activo') then raise exception 'WORKER_HAS_OPEN_TIMER'; end if;
      insert into public.task_time_spans(timer_id,started_at,reason,created_by,updated_by)
      values(timer.id,server_time,'Reanudación de trabajo',auth.uid(),auth.uid());
    else
      update public.task_time_spans set ended_at=server_time,updated_by=auth.uid(),version=version+1
      where timer_id=timer.id and ended_at is null;
    end if;
    update public.task_timers set state=case command when 'pause' then 'Pausado' when 'resume' then 'Activo' else 'Finalizado' end,
      finished_at=case when command='finish' then server_time else null end,version=version+1 where id=timer.id returning * into timer;
  end if;
  result:=jsonb_build_object('timer',to_jsonb(timer),'span',to_jsonb(span));
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;
revoke all on function public.execute_time_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_time_command(text,jsonb,uuid) to authenticated;
