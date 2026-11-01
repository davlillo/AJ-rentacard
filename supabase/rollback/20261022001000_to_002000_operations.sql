-- Empty-module recovery for 0010-0020 only. Never run against the used AJ local workspace.
begin;
do $$ begin
  if exists(select 1 from public.reservations) or exists(select 1 from public.vehicle_commitments)
    or exists(select 1 from public.billing_documents) or exists(select 1 from public.customer_payments)
    or exists(select 1 from public.stock_items) or exists(select 1 from public.commission_rules)
    or exists(select 1 from public.rental_contracts) or exists(select 1 from public.agent_expense_proposals)
    or exists(select 1 from public.operating_budgets) or exists(select 1 from public.integration_inbox)
    or exists(select 1 from public.report_schedules) or exists(select 1 from public.payment_imports) then
    raise exception 'Rollback refused: operational module data exists. Use a forward corrective migration.';
  end if;
end $$;
-- Undo the forward replay guard before dropping its underlying module.
drop function public.execute_report_delivery_command(text,jsonb,uuid);
alter function private.report_delivery_command_core(text,jsonb,uuid) rename to execute_report_delivery_command;
alter function private.execute_report_delivery_command(text,jsonb,uuid) set schema public;
drop function public.execute_payment_import(text,jsonb,uuid);
drop function public.payment_import_original(uuid);
drop function private.payment_import_preview(public.payment_imports);
drop function private.normalize_import_payment(jsonb,jsonb);
drop table private.payment_import_files;
drop table public.payment_import_origins;
drop table public.payment_imports;
drop function private.delivery_checklist(text);
alter function private.delivery_checklist_before_billing(text) rename to delivery_checklist;
drop function public.execute_report_delivery_command(text,jsonb,uuid);
drop table public.report_outbox;
drop table public.report_schedules;
drop function public.execute_optional_command(text,jsonb,uuid);
drop function public.budget_position(uuid,date);
drop table public.integration_inbox;
drop table public.budget_expense_links;
drop table public.budget_purchase_links;
drop table public.operating_budgets;
drop function public.agent_vehicle_cost(text,text,date);
drop function public.propose_agent_expense(jsonb,uuid);
drop function public.confirm_agent_expense(uuid,text);
drop function public.administration_users();
drop function public.execute_administration_command(text,jsonb,uuid);
drop table public.agent_expense_proposals;
drop function public.execute_contract_command(text,jsonb,uuid);
drop function public.contract_pdf(uuid,text);
drop function public.execute_commission_command(text,jsonb,uuid);
drop function public.vehicle_contribution(uuid,date,date);
drop table private.contract_files;
drop table public.contract_acceptances;
drop table public.rental_contracts;
drop table public.commission_entries;
drop table public.commission_bindings;
drop table public.commission_eligibility;
drop table public.commission_rules;
alter table public.billing_documents drop column commission_eligible;
drop function public.execute_inventory_command(text,jsonb,uuid);
alter table public.workshop_costs drop constraint stock_cost_source,drop column stock_dispatch_id,
  drop constraint cost_kind,drop constraint cost_source,drop constraint direct_purchase_source,drop constraint cost_amount,drop constraint cost_quantity;
alter table public.workshop_costs add constraint cost_kind check(kind in ('Gasto','Compra directa')),
  add constraint cost_source check((kind='Gasto' and expense_id is not null) or (kind='Compra directa' and expense_id is null)),
  add constraint direct_purchase_source check(kind<>'Compra directa' or (length(btrim(supplier))>0 and length(btrim(source_reference))>0)),
  add constraint cost_amount check(amount>0 and amount::text not in ('NaN','Infinity')),
  add constraint cost_quantity check(quantity>0 and quantity::text not in ('NaN','Infinity'));
drop table public.supplier_obligations;
drop table public.stock_movements;
drop table public.purchase_orders;
drop table public.stock_items;
drop function public.execute_billing_command(text,jsonb,uuid);
drop function public.receivables_at(date);
drop function public.reservation_payment_status(uuid);
drop function public.reservation_payment_summary();
drop function private.document_balance(uuid,date);
drop function private.canonical_customer(uuid);
drop table public.billing_credits;
drop table public.payment_refunds;
drop table public.payment_applications;
drop table public.customer_payments;
drop table public.billing_documents;
drop function public.execute_rental_command(text,jsonb,uuid);
drop table public.rental_extra_proposals;
drop table public.rental_inspections;
drop function public.execute_reservation_command(text,jsonb,uuid);
drop function public.rental_alternatives(timestamptz,timestamptz,uuid);
drop trigger workshop_commitment on public.work_orders;
drop trigger reservation_identity on public.customers;
drop function private.workshop_commitment();
drop function private.merge_reservation_identity();
drop table public.reservation_evidence;
drop table public.vehicle_commitments;
drop table public.reservations;
alter table public.vehicles drop column readiness_hold;
commit;
