-- Compatibility rollback: the command and the link of the extra can be removed only while no
-- extra was issued. An issued charge is a real document of the customer: it is never orphaned.
do $$ begin
  if exists(select 1 from public.rental_extra_proposals where document_id is not null)
    or exists(select 1 from public.billing_documents where source_key like 'rental-extra:%') then
    raise exception 'RENTAL_EXTRA_ALREADY_ISSUED';
  end if;
end $$;
drop function if exists public.issue_rental_extra(jsonb,uuid);
alter table public.rental_extra_proposals drop column if exists document_id;
alter table public.rental_extra_proposals drop column if exists issued_on;
alter table public.rental_extra_proposals drop column if exists due_on;
