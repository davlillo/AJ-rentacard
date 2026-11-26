-- S3: open tasks are optional follow-up, not a delivery gate.
-- Money still blocks: an unclassified cost and an undecided budget revision keep their check.
-- Open timers still block because they are a running time fact, not a checklist item.
-- The body is patched in place so idempotency, version, exception, credit, reception,
-- insert and status updates stay byte-identical to the previous definition.
do $$declare definition text;anchor text;begin
  definition:=pg_get_functiondef('public.deliver_workshop_order(jsonb,uuid)'::regprocedure);
  if position('jsonb_array_length(checklist->''openTasks'')' in definition)=0 then return;end if;
  anchor:='or jsonb_array_length(checklist->''openTasks'')>0';
  if position(anchor in definition)=0 then raise exception 'DELIVERY_TASK_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,'');
end $$;
revoke all on function public.deliver_workshop_order(jsonb,uuid) from public,anon;
grant execute on function public.deliver_workshop_order(jsonb,uuid) to authenticated;
