-- Restore the previous delivery gate: an open task blocks an ordinary delivery again.
do $$declare definition text;anchor text;begin
  definition:=pg_get_functiondef('public.deliver_workshop_order(jsonb,uuid)'::regprocedure);
  if position('jsonb_array_length(checklist->''openTasks'')' in definition)>0 then return;end if;
  anchor:='(checklist->>''pendingCosts'')::integer>0';
  if position(anchor in definition)=0 then raise exception 'DELIVERY_TASK_ROLLBACK_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,anchor||' or jsonb_array_length(checklist->''openTasks'')>0');
end $$;
revoke all on function public.deliver_workshop_order(jsonb,uuid) from public,anon;
grant execute on function public.deliver_workshop_order(jsonb,uuid) to authenticated;
