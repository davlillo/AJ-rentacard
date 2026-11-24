-- Refuse to discard any linkage or intended advance created by this workflow.
do $$begin
  if exists(select 1 from public.workshop_costs where linked_expense_id is not null)
    or exists(select 1 from public.receipt_operation_contexts)
    or exists(select 1 from private.command_results where request->>'command' in ('money.link_expense','money.expense','money.receipt','money.quote'))
    then raise exception 'Rollback refused: connected money records are in use';end if;
end $$;
do $$declare item record;begin
  for item in select * from private.connected_money_functions loop execute item.definition;end loop;
end $$;
drop function public.link_workshop_expense(jsonb,uuid),public.record_linked_expense(jsonb,uuid),
  public.workshop_expense_inbox(),public.record_linked_receipt(jsonb,uuid),public.record_connected_quote(jsonb,uuid);
drop function private.link_workshop_expense(text,jsonb,text),private.cash_operation_links();
drop function private.vehicle_case_file_before_connected_money(uuid,text),private.rental_case_file_before_connected_money(uuid),
  private.cash_diary_before_connected_money(date,date,text),private.receipt_available(uuid);
drop table public.receipt_operation_contexts;
alter table public.workshop_costs drop constraint cost_kind,drop constraint linked_cash_cost_source;
alter table public.workshop_costs drop column linked_expense_id;
alter table public.workshop_costs add constraint cost_kind check(kind in ('Gasto','Compra directa','Consumo'));
drop table private.connected_money_functions;
