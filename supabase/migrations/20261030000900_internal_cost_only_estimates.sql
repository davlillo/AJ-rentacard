-- Internal maintenance can estimate costs without inventing a sale price.
create table private.internal_estimate_backup(definition text not null);
insert into private.internal_estimate_backup select pg_get_functiondef('public.execute_case_command(text,jsonb,uuid)'::regprocedure);
do $$ declare definition text;anchor text;begin
  definition:=pg_get_functiondef('public.execute_case_command(text,jsonb,uuid)'::regprocedure);
  anchor:='or amount>=total or total-amount>';
  if position(anchor in definition)=0 then raise exception 'INTERNAL_ESTIMATE_SOURCE_MISMATCH';end if;
  definition:=replace(definition,anchor,'or amount>total or (amount=total and not job.internal_job) or total-amount>');
  definition:=replace(definition,'case when complete then total-amount-known_cost else null end',
    'case when complete and not job.internal_job then total-amount-known_cost else null end');
  definition:=replace(definition,'case when complete then round((total-amount-known_cost)/(total-amount)*100,2) else null end',
    'case when complete and not job.internal_job and total>amount then round((total-amount-known_cost)/(total-amount)*100,2) else null end');
  execute definition;
end $$;
