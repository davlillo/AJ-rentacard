begin;
do $$begin
  if exists(select 1 from public.customers where phone='' or source_reference<>'')
    or exists(select 1 from public.vehicles where plate='' or ownership='Por confirmar' or status='Por confirmar' or cardinality(unverified_fields)>0 or source_workbook_id is not null)
    or exists(select 1 from public.work_orders where status='Presupuesto')
    then raise exception 'Rollback refused: source-backed or pre-intake records are in use';end if;
end $$;
drop trigger estimate_intake on public.workshop_inspections;
drop function private.receive_estimated_work();
drop function public.save_workshop_quote(jsonb,uuid);
do $$declare r record;begin for r in select definition from private.usability_function_backups loop execute r.definition;end loop;end $$;
alter table public.estimate_versions drop column source_totals,drop column source_reference,drop column folio_number;
alter table public.reservations drop column folio_number;
alter table public.billing_documents drop column folio_number;
alter table public.customer_payments drop column folio_number;
alter table public.customers drop column source_reference;
drop index public.vehicles_source_reference;
alter table public.vehicles drop column source_ref,drop column source_workbook_id,drop column unverified_fields;
drop index public.vehicles_known_plate_key;
alter table public.vehicles add constraint vehicles_plate_key_key unique(plate_key);
alter table public.vehicles add constraint vehicles_plate_key_check check(length(plate_key)>0);
alter table public.vehicles drop constraint vehicles_status_check;
alter table public.vehicles add constraint vehicles_status_check check(status in ('Disponible','Alquilado','En taller'));
alter table public.vehicles drop constraint vehicles_ownership_check;
alter table public.vehicles drop constraint vehicles_check;
alter table public.vehicles add constraint vehicles_ownership_check check(ownership in ('Propio','Cliente'));
alter table public.vehicles add constraint vehicles_check check((ownership='Propio' and owner_customer_id is null) or (ownership='Cliente' and owner_customer_id is not null));
alter table public.customers drop constraint customers_phone_check;
alter table public.customers add constraint customers_phone_check check(length(regexp_replace(phone,'[^0-9]','','g')) between 7 and 15);
drop table private.usability_function_backups;
commit;
