-- HU25: snapshot outbox with an atomic claim; ambiguous SMTP outcomes are never blindly retried.
create table public.report_schedules (
  id uuid primary key default gen_random_uuid(),recipient_id uuid not null references auth.users,
  vehicle_id uuid not null references public.vehicles,from_date date not null,
  next_on date not null,every_days integer not null check(every_days between 1 and 366),
  active boolean not null default true,created_by uuid not null references auth.users,created_at timestamptz not null default now(),
  check(isfinite(from_date) and isfinite(next_on) and next_on>=from_date)
);
create table public.report_outbox (
  id uuid primary key default gen_random_uuid(),schedule_id uuid not null references public.report_schedules,
  cutoff date not null,recipient_id uuid not null references auth.users,recipient_email text not null,
  filters jsonb not null,snapshot jsonb not null,
  state text not null default 'Pendiente' check(state in ('Pendiente','Enviando','Enviado','Error','Incierto')),
  message_id text,delivery_detail text,created_by uuid not null references auth.users,created_at timestamptz not null default now(),
  unique(schedule_id,cutoff)
);
do $$ declare tbl text;begin
  foreach tbl in array array['report_schedules','report_outbox'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from anon,authenticated',tbl);execute format('grant select on public.%I to authenticated',tbl);
    execute format('create policy report_delivery_read on public.%I for select to authenticated using(exists(select 1 from public.user_roles where user_id=auth.uid() and role=''owner''))',tbl);
    execute format('create trigger report_delivery_audit after insert or update on public.%I for each row execute function private.audit_change()',tbl);
  end loop;
end $$;
create function public.execute_report_delivery_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','report-delivery.'||command,'payload',payload);
  schedule public.report_schedules;job public.report_outbox;run_date date;email text;result jsonb;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if command is null or command not in ('schedule','prepare','claim','sent','failed','uncertain') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REPORT_DELIVERY_COMMAND';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='schedule' then
    if not exists(select 1 from public.user_roles where user_id=(payload->>'recipientId')::uuid and role in ('owner','admin','accountant')) then raise exception 'UNAUTHORIZED_REPORT_RECIPIENT';end if;
    insert into public.report_schedules(recipient_id,vehicle_id,from_date,next_on,every_days,created_by)
    values((payload->>'recipientId')::uuid,(payload->>'vehicleId')::uuid,(payload->>'from')::date,(payload->>'nextOn')::date,(payload->>'everyDays')::integer,auth.uid()) returning * into schedule;
    result:=to_jsonb(schedule);
  elsif command='prepare' then
    run_date:=(payload->>'runDate')::date;
    if run_date is null or not isfinite(run_date) or run_date>(now() at time zone 'America/El_Salvador')::date then raise exception 'INVALID_REPORT_RUN_DATE';end if;
    result:='[]';
    for schedule in select * from public.report_schedules where active and next_on<=run_date order by next_on,id limit 50 for update loop
      select u.email into email from auth.users u where u.id=schedule.recipient_id and exists(
        select 1 from public.user_roles r where r.user_id=u.id and r.role in ('owner','admin','accountant'));
      if email is null or email !~ '^[^\r\n@]+@[^\r\n@]+$' then continue;end if;
      insert into public.report_outbox(schedule_id,cutoff,recipient_id,recipient_email,filters,snapshot,created_by)
      values(schedule.id,schedule.next_on,schedule.recipient_id,email,jsonb_build_object('vehicleId',schedule.vehicle_id,'from',schedule.from_date,'cutoff',schedule.next_on),
        public.vehicle_contribution(schedule.vehicle_id,schedule.from_date,schedule.next_on),auth.uid())
      on conflict(schedule_id,cutoff) do nothing returning * into job;
      if job.id is not null then result:=result||jsonb_build_array(to_jsonb(job));end if;
      update public.report_schedules set next_on=next_on+every_days where id=schedule.id;
    end loop;
  else
    select * into job from public.report_outbox where id=(payload->>'jobId')::uuid for update;
    if job.id is null then raise exception 'REPORT_JOB_NOT_FOUND';end if;
    if command='claim' then
      if job.state<>'Pendiente' then return null;end if;
      if not exists(select 1 from public.user_roles where user_id=job.recipient_id and role in ('owner','admin','accountant')) then raise exception 'UNAUTHORIZED_REPORT_RECIPIENT';end if;
      update public.report_outbox set state='Enviando',message_id=id::text||'@aj.local' where id=job.id returning * into job;
    else
      if job.state<>'Enviando' then raise exception 'REPORT_JOB_NOT_CLAIMED';end if;
      update public.report_outbox set state=case command when 'sent' then 'Enviado' when 'failed' then 'Error' else 'Incierto' end,
        delivery_detail=left(coalesce(payload->>'detail',''),1000) where id=job.id returning * into job;
    end if;
    result:=to_jsonb(job);
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;
revoke all on function public.execute_report_delivery_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_report_delivery_command(text,jsonb,uuid) to authenticated;
