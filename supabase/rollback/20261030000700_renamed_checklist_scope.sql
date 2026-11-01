begin;
do $$ begin
  if exists(select 1 from public.work_orders) or exists(select 1 from public.source_workbooks) then
    raise exception 'Rollback refused: delivery scope repair is in use';end if;
  execute (select definition from private.checklist_scope_backup);
end $$;
drop table private.checklist_scope_backup;
commit;
