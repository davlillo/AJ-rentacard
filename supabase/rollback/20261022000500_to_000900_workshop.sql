-- Development-only rollback of migrations 0005-0009. Never run against used operational modules.
begin;
do $$ begin
  if exists(select 1 from public.workshop_deliveries) or exists(select 1 from public.task_timers)
    or exists(select 1 from public.workshop_costs) or exists(select 1 from public.estimate_versions)
    or exists(select 1 from public.workshop_tariffs) then
    raise exception 'Rollback refused: workshop data exists. Use a forward corrective migration.';
  end if;
end $$;
drop function public.execute_delivery_cost_adjustment(text,jsonb,uuid);
drop function public.deliver_workshop_order(jsonb,uuid);
drop function public.workshop_delivery_checklist(text);
drop function private.delivery_checklist(text);
drop table public.workshop_deliveries;
drop function public.execute_time_command(text,jsonb,uuid);
drop trigger task_timer_guard on public.workshop_tasks;
drop function private.task_timer_guard();
drop table public.task_time_spans;
drop table public.task_timers;
drop function public.execute_cost_command(text,jsonb,uuid);
drop trigger expense_cost on public.expenses;
drop trigger expense_update_audit on public.expenses;
drop function private.expense_to_workshop_cost();
drop table public.workshop_costs;
drop function public.estimate_pdf(uuid,text,text);
drop table private.estimate_document_files;
drop table public.estimate_documents;
drop function public.execute_estimate_command(text,jsonb,uuid);
drop function public.calculate_estimate(jsonb,text,numeric,numeric);
drop function private.calculate_estimate(jsonb,text,numeric,numeric);
drop table public.estimate_approvals;
alter table public.work_orders drop column active_estimate_id;
drop table public.estimate_versions;
drop table public.workshop_tariffs;
drop function private.immutable_quote_record();
commit;
