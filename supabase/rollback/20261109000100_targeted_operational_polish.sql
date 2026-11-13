-- Unused-only rollback: never discard a free-text inspection or a received customer car.
do $$declare saved record;begin
  if exists(select 1 from public.workshop_inspections where km is null or fuel is null)
    or exists(select 1 from public.rental_inspections where km is null or fuel is null)
    or exists(select 1 from private.command_results where request->>'command'='workshop.receive')
    then raise exception 'POLISH_ALREADY_USED_FORWARD_FIX_REQUIRED';end if;
  for saved in select definition from private.polish_function_backups loop execute saved.definition;end loop;
end $$;
drop function public.receive_workshop_vehicle(jsonb,uuid);
drop function private.rental_actual_dates(jsonb);
alter table public.workshop_inspections alter column km set not null,alter column fuel set not null;
alter table public.rental_inspections alter column km set not null,alter column fuel set not null;
drop table private.polish_function_backups;
