begin;
do $$ begin
  if exists(select 1 from private.command_results where request->>'command'='billing.collect_document') then
    raise exception 'Rollback refused: rental collection has operational data';end if;
  execute (select definition from private.rental_case_functions);
end $$;
drop function public.rental_case_file(uuid),public.collect_document(jsonb,uuid),private.reservation_credit_sources(uuid),private.reservation_document_sources(uuid);
drop table private.rental_case_functions;
commit;
