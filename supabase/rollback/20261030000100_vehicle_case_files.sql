-- Development recovery ONLY, never run against a used case module.
begin;
do $$ begin
  if exists(select 1 from public.vehicle_files) or exists(select 1 from public.workshop_inspections)
    or exists(select 1 from public.cost_allocations) or exists(select 1 from public.work_orders where internal_job)
    or exists(select 1 from public.expenses where vehicle_id is not null or reservation_id is not null)
    or exists(select 1 from public.billing_documents where estimate_id is not null)
    or exists(select 1 from private.command_results where request->>'command' like 'case.%'
      or request->>'command'='vehicle.file') then raise exception 'Rollback refused: vehicle cases contain operational data';end if;
end $$;
drop function public.vehicle_case_file(uuid,text),public.save_vehicle_file(jsonb,uuid),public.vehicle_file_content(uuid);
drop function private.vehicle_application_sources(uuid,text),private.vehicle_credit_sources(uuid,text);
drop function private.vehicle_document_sources(uuid,text);
drop function public.execute_case_command(text,jsonb,uuid);
drop function public.execute_command(text,jsonb,uuid);
alter function private.business_command_before_cases(text,jsonb,uuid) rename to execute_command;
alter function private.execute_command(text,jsonb,uuid) set schema public;
grant execute on function public.execute_command(text,jsonb,uuid) to authenticated;
drop function private.delivery_checklist(text);
alter function private.delivery_checklist_before_cases(text) rename to delivery_checklist;
drop trigger allocated_cost_net on public.workshop_costs;
drop function private.check_cost_allocation_net();
drop table private.vehicle_file_bytes;
drop table public.cost_allocations,public.vehicle_files,public.workshop_inspections;
alter table public.billing_documents drop column estimate_id;
alter table public.expenses drop constraint expense_one_destination;
alter table public.expenses drop column vehicle_id,drop column reservation_id;
do $$ declare c record;begin
  for c in select * from private.oct30_constraints loop
    execute format('alter table public.%I add constraint %I %s',c.table_name,c.constraint_name,c.definition);
  end loop;
end $$;
alter table public.work_orders drop constraint case_customer_required;
alter table public.work_orders alter column customer_id set not null;
alter table public.work_orders drop column internal_job;
alter table public.vehicles drop column in_rental_fleet,drop column registered_holder,drop column commercial_line;
drop function private.capture_oct30_function(text);
drop table private.oct30_functions,private.oct30_constraints;
commit;
