-- Development-only rollback. Refuse to destroy operational data; use forward fixes once used.
begin;
do $$ begin
  if exists(select 1 from public.customers) or exists(select 1 from public.vehicles)
    or exists(select 1 from public.work_orders) or exists(select 1 from public.expenses) then
    raise exception 'Rollback refused: operational data exists. Restore into a separate environment or use a forward migration.';
  end if;
end $$;
drop function public.execute_command(text,jsonb,uuid);
drop function public.customer_matches(text,text);
drop table private.command_results;
drop table public.customer_aliases;
drop table public.expenses;
drop table public.cost_centers;
drop table public.work_orders;
drop table public.vehicles;
drop table public.customers;
drop table public.audit_events;
drop function private.audit_change();
drop table public.user_roles;
drop function public.has_permission(text);
drop sequence public.work_order_folio;
drop sequence public.expense_folio;
drop schema private;
commit;
