begin;
do $$ begin
  if exists(select 1 from private.command_results) then raise exception 'Rollback refused: command permission repair is in use';end if;
  execute (select definition from private.command_permission_backup);
end $$;
drop table private.command_permission_backup;
commit;
