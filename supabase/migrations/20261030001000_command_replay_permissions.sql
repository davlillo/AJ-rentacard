-- Every business command must authorize before returning a cached result,
-- including customer commands delegated to the original implementation.
create table private.command_permission_backup(definition text not null);
insert into private.command_permission_backup select pg_get_functiondef('public.execute_command(text,jsonb,uuid)'::regprocedure);
do $$ declare definition text;anchor text;replacement text;begin
  definition:=pg_get_functiondef('public.execute_command(text,jsonb,uuid)'::regprocedure);
  anchor:=$old$if not public.has_permission(case when command='record_expense' then 'expenses.write' when command='receive_vehicle' then 'orders.write' else 'vehicles.write' end)
    and command in ('create_vehicle','receive_vehicle','record_expense') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;$old$;
  replacement:=$new$if command is null or command not in ('create_customer','merge_customer','create_vehicle','receive_vehicle','record_expense') then raise exception 'UNKNOWN_COMMAND';end if;
  if not public.has_permission(case command when 'create_customer' then 'customers.write' when 'merge_customer' then 'customers.merge'
    when 'record_expense' then 'expenses.write' when 'receive_vehicle' then 'orders.write' else 'vehicles.write' end)
    then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;$new$;
  if position(anchor in definition)=0 then raise exception 'COMMAND_PERMISSION_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,replacement);
end $$;
