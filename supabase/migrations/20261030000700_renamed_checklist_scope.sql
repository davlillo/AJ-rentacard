-- PostgreSQL reparses a renamed function in a new session. A qualified reference
-- to the old function name no longer resolves to its parameter in that session.
-- Positional parameters survive rename and are unambiguous in the nested query.
create table private.checklist_scope_backup(definition text not null);
insert into private.checklist_scope_backup select pg_get_functiondef('private.delivery_checklist_before_cases(text)'::regprocedure);
do $$ declare definition text;begin
  definition:=pg_get_functiondef('private.delivery_checklist_before_cases(text)'::regprocedure);
  if position('delivery_checklist.order_id' in definition)=0 then raise exception 'CHECKLIST_SCOPE_SOURCE_MISMATCH';end if;
  execute replace(definition,'delivery_checklist.order_id','$1');
end $$;
