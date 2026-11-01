begin;
do $$ begin
  if exists(select 1 from public.cash_entries) or exists(select 1 from public.payment_refunds where refund_account<>'') then
    raise exception 'Rollback refused: diary module contains cash data';end if;
end $$;
do $$ declare f record;begin for f in select * from private.diary_functions loop execute f.definition;end loop;end $$;
drop function public.cash_diary(date,date,text),private.diary_sources(),public.record_cash_entry(jsonb,uuid);
drop trigger refund_account_capture on public.payment_refunds;
drop function private.capture_refund_account();
alter table public.payment_refunds drop column refund_account;
drop table public.cash_entries,private.diary_functions;
commit;
