-- Development-only: run before the 0010-0020 rollback on an UNUSED database only.
begin;
do $$ declare saved record;begin
  if exists(select 1 from public.reservations) or exists(select 1 from public.payment_imports)
    or exists(select 1 from public.rental_contracts) or exists(select 1 from public.operating_budgets)
    or exists(select 1 from public.expenses where direct_purchase_cost_id is not null) then
    raise exception 'Rollback refused: review-corrected workflows have data. Use a forward migration.';
  end if;
  for saved in select definition from private.review_function_backups order by signature loop
    execute saved.definition;
  end loop;
end $$;
drop function private.reservation_command_before_review(text,jsonb,uuid);
drop function public.pay_direct_purchase(uuid,jsonb,uuid);
drop function private.render_contract_pdf(public.rental_contracts);
drop function private.contract_winansi_hex(text);
alter table public.expenses drop column direct_purchase_cost_id;
drop table private.review_function_backups;
commit;
