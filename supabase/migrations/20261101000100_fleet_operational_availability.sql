-- Fleet availability is an operational decision; it does not invent an odometer reading.
-- Departure/intake inspections and active-commitment guards remain authoritative.
create table private.fleet_availability_backups(signature text primary key,definition text not null);
insert into private.fleet_availability_backups select signature,pg_get_functiondef(signature::regprocedure)
  from unnest(array['public.execute_command(text,jsonb,uuid)','public.save_registry_details(text,jsonb,uuid)']) signature;
do $$declare definition text;anchor text;begin
  select b.definition into definition from private.fleet_availability_backups b where signature='public.execute_command(text,jsonb,uuid)';
  anchor:=$before$if payload->>'initialStatus'='Disponible' and (payload->'unverifiedFields') ? 'km'$before$;
  if position(anchor in definition)=0 then raise exception 'AVAILABILITY_REGISTRATION_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,anchor||' and not coalesce((payload->>''inRentalFleet'')::boolean,false)');
  select b.definition into definition from private.fleet_availability_backups b where signature='public.save_registry_details(text,jsonb,uuid)';
  anchor:=$before$if state='Disponible' and nullif(payload->>'km','') is null and 'km'=any(car.unverified_fields)$before$;
  if position(anchor in definition)=0 then raise exception 'AVAILABILITY_REGISTRY_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,anchor||' and not car.in_rental_fleet');
end $$;
