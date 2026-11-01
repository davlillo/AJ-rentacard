begin;
do $$ begin
  if exists(select 1 from public.estimate_versions q join public.work_orders o on o.id=q.order_id
    where o.internal_job and (q.snapshot->>'total')::numeric=0) then raise exception 'Rollback refused: internal cost-only estimates are in use';end if;
  execute (select definition from private.internal_estimate_backup);
end $$;
drop table private.internal_estimate_backup;
commit;
