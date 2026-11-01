-- A transport claim is a one-use capability, not a replayable business result.
-- Replaying the same idempotency key must not give a second sender permission to deliver.
alter function public.execute_report_delivery_command(text,jsonb,uuid) set schema private;
alter function private.execute_report_delivery_command(text,jsonb,uuid) rename to report_delivery_command_core;
revoke all on function private.report_delivery_command_core(text,jsonb,uuid) from public,anon,authenticated;
create function public.execute_report_delivery_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if command='claim' then
    perform pg_advisory_xact_lock(6192,1);
    select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
    if found then
      if prior.request<>jsonb_build_object('command','report-delivery.claim','payload',payload) then raise exception 'IDEMPOTENCY_CONFLICT';end if;
      return null;
    end if;
  end if;
  return private.report_delivery_command_core(command,payload,idempotency_key);
end;
$$;
revoke all on function public.execute_report_delivery_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_report_delivery_command(text,jsonb,uuid) to authenticated;
