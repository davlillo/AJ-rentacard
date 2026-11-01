-- A vehicle can be identified for a quote before its odometer, color or rental rate is known.
create table private.vehicle_registration_backup(definition text not null);
insert into private.vehicle_registration_backup select pg_get_functiondef('public.execute_command(text,jsonb,uuid)'::regprocedure);
do $$declare definition text;anchor text;replacement text;begin
  definition:=pg_get_functiondef('public.execute_command(text,jsonb,uuid)'::regprocedure);
  anchor:=$before$if command='create_vehicle' then
      update public.vehicles set in_rental_fleet=coalesce((payload->>'inRentalFleet')::boolean,ownership='Propio'),
        registered_holder=coalesce(btrim(payload->>'registeredHolder'),''),commercial_line=coalesce(btrim(payload->>'commercialLine'),'')
        where id=(result->>'id')::uuid;$before$;
  replacement:=$after$if command='create_vehicle' then
      if payload ? 'unverifiedFields' and jsonb_typeof(payload->'unverifiedFields') is distinct from 'array'
        then raise exception 'INVALID_UNVERIFIED_FIELDS';end if;
      if exists(select 1 from jsonb_array_elements_text(coalesce(payload->'unverifiedFields','[]')) f
        where f not in ('plate','color','daily','km','ownership','status'))
        or (payload->>'initialStatus' is not null and payload->>'initialStatus' not in ('Disponible','Por confirmar'))
        then raise exception 'INVALID_UNVERIFIED_FIELDS';end if;
      if payload->>'initialStatus'='Disponible' and (payload->'unverifiedFields') ? 'km'
        then raise exception 'CONFIRMED_ODOMETER_REQUIRED';end if;
      update public.vehicles set in_rental_fleet=coalesce((payload->>'inRentalFleet')::boolean,ownership='Propio'),
        registered_holder=coalesce(btrim(payload->>'registeredHolder'),''),commercial_line=coalesce(btrim(payload->>'commercialLine'),''),
        status=coalesce(payload->>'initialStatus',status),
        unverified_fields=array(select distinct field from jsonb_array_elements_text(coalesce(payload->'unverifiedFields','[]')) field)
        where id=(result->>'id')::uuid;$after$;
  if position(anchor in definition)=0 then raise exception 'VEHICLE_REGISTRATION_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,replacement);
end $$;
