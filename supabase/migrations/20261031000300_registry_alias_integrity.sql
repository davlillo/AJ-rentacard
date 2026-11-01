create table private.registry_validation_backup(definition text not null);
insert into private.registry_validation_backup select pg_get_functiondef('public.save_registry_details(text,jsonb,uuid)'::regprocedure);
do $$declare definition text;anchor text;begin
  definition:=pg_get_functiondef('public.save_registry_details(text,jsonb,uuid)'::regprocedure);
  anchor:=$before$if exists(select 1 from public.customers c where c.id<>customer.id and c.merged_into is null and (
      (nullif(regexp_replace(payload->>'phone','[^0-9]','','g'),'') is not null and c.phone_key=regexp_replace(payload->>'phone','[^0-9]','','g')) or
      (nullif(upper(regexp_replace(payload->>'document','[^a-zA-Z0-9]','','g')),'') is not null and c.document_key=upper(regexp_replace(payload->>'document','[^a-zA-Z0-9]','','g')))))$before$;
  if position(anchor in definition)=0 then raise exception 'REGISTRY_VALIDATION_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,$after$if exists(select 1 from public.customer_matches(coalesce(payload->>'phone',''),coalesce(payload->>'document','')) candidate
      where candidate.id<>customer.id)$after$);
end $$;
