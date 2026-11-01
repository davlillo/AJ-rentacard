-- Development-only rollback; preserve staged source files and published provenance.
begin;
do $$ begin
  if exists(select 1 from public.expense_imports) then
    raise exception 'Rollback refused: staged or published imports exist. Use a forward migration.';
  end if;
end $$;
drop function public.stage_expense_import(text,text,text,jsonb,jsonb);
drop function public.validate_expense_import(uuid,integer,jsonb,text,jsonb);
drop function public.commit_expense_import(uuid,integer,numeric);
drop function public.expense_import_original(uuid);
drop function private.validate_expense_import_rows(public.expense_imports);
drop function private.expense_import_summary(uuid);
drop function private.normalize_import_expense(jsonb,jsonb);
drop function private.import_fingerprint(jsonb);
drop function private.require_import_permission();
drop table public.expense_import_origins;
drop table public.expense_import_rows;
drop table private.expense_import_files;
drop table public.expense_imports;
commit;
