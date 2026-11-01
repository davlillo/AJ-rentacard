-- Only recover on an unused development expansion. Used originals/cases need a forward repair.
begin;
do $$ begin
  if exists(select 1 from public.source_workbooks) or exists(select 1 from public.billing_documents where grouped)
    or exists(select 1 from public.vehicle_files) or exists(select 1 from public.cash_entries)
    or exists(select 1 from public.work_orders where internal_job)
    or exists(select 1 from public.expenses where vehicle_id is not null or reservation_id is not null) then
    raise exception 'Rollback refused: case integration is in use';end if;
end $$;
do $$ declare f record;begin for f in select * from private.case_integration_functions loop execute f.definition;end loop;end $$;
drop function private.reservation_payment_sources(uuid);
drop table private.case_integration_functions;
commit;
