begin;
do $$ begin
  if exists(select 1 from public.billing_documents where grouped) or exists(select 1 from public.billing_document_lines)
    or exists(select 1 from public.billing_application_lines) or exists(select 1 from public.billing_credit_lines)
    then raise exception 'Rollback refused: grouped billing contains operational data';end if;
end $$;
drop trigger allocate_application on public.payment_applications;
drop trigger allocate_credit on public.billing_credits;
drop function private.allocate_document_event();
drop function public.issue_grouped_document(jsonb,uuid),public.billing_line_positions(uuid),public.execute_billing_command(text,jsonb,uuid);
alter function private.billing_command_before_grouped(text,jsonb,uuid) rename to execute_billing_command;
alter function private.execute_billing_command(text,jsonb,uuid) set schema public;
do $$ declare f record;begin
  for f in select * from private.grouped_billing_functions loop execute f.definition;end loop;
end $$;
grant execute on function public.execute_billing_command(text,jsonb,uuid) to authenticated;
drop function private.document_line_balance(uuid);
drop index public.legacy_period_document;
alter table public.rental_periods drop column document_line_id;
drop table public.billing_application_lines,public.billing_credit_lines,public.billing_document_lines;
alter table public.billing_documents drop constraint document_scope_fit;
drop index public.billing_external_reference;
alter table public.billing_documents drop column grouped,drop column external_reference;
do $$ declare c record;begin
  for c in select * from private.grouped_billing_constraints loop execute format('alter table public.%I add constraint %I %s',c.table_name,c.name,c.definition);end loop;
end $$;
drop table private.grouped_billing_functions,private.grouped_billing_constraints;
commit;
