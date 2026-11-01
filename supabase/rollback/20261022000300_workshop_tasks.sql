begin;
do $$ begin
  if exists(select 1 from public.workshop_tasks) then raise exception 'Rollback refused: workshop tasks exist.'; end if;
end $$;
drop function public.execute_task_command(text,jsonb,uuid);
drop function public.workshop_assignees();
drop table public.workshop_tasks;
drop function public.has_task_access();
commit;
