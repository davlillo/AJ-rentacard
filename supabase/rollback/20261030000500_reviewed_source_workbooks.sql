begin;
do $$ begin
  if exists(select 1 from public.source_workbooks) then raise exception 'Rollback refused: source workbooks contain client evidence';end if;
end $$;
drop function public.review_source_item(jsonb,uuid),public.source_duplicate_candidates(text,jsonb),public.source_workbook_bundle(uuid),public.source_workbook_original(uuid),public.stage_source_workbook(jsonb,uuid);
drop table private.source_workbook_bytes,public.source_workbook_items,public.source_workbooks;
commit;
