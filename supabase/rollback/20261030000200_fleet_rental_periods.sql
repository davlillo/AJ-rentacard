begin;
do $$ begin
  if exists(select 1 from public.rental_periods) or exists(select 1 from public.reservations where open_ended)
    or exists(select 1 from public.vehicle_commitments where kind in ('Uso interno','Préstamo'))
    or exists(select 1 from private.command_results where request->>'command' in ('reservation.set_end','reservation.period')
      or (request->>'command'='reservation.create' and request->'payload'->>'openEnded'='true'))
    then raise exception 'Rollback refused: rental-fit module contains data';end if;
end $$;
drop function public.rental_paid_through(uuid),public.execute_reservation_command(text,jsonb,uuid);
alter function private.reservation_command_before_fit(text,jsonb,uuid) rename to execute_reservation_command;
alter function private.execute_reservation_command(text,jsonb,uuid) set schema public;
do $$ declare f record;begin
  for f in select * from private.rental_fit_functions loop execute f.definition;end loop;
end $$;
grant execute on function public.execute_reservation_command(text,jsonb,uuid) to authenticated;
drop table public.rental_periods;
alter table public.reservations drop constraint rental_interval_fit,drop column open_ended;
alter table public.vehicle_commitments drop constraint fleet_block_kind,drop constraint fleet_block_end;
do $$ declare c record;begin
  for c in select * from private.rental_fit_constraints loop execute format('alter table public.%I add constraint %I %s',c.table_name,c.name,c.definition);end loop;
end $$;
drop table private.rental_fit_constraints,private.rental_fit_functions;
commit;
