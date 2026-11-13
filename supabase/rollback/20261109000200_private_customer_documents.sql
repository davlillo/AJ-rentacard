-- Never remove an uploaded identity document to roll back a release.
do $$begin
  if exists(select 1 from public.customer_documents) then raise exception 'CUSTOMER_DOCUMENTS_ALREADY_USED_FORWARD_FIX_REQUIRED';end if;
end $$;
drop function public.save_customer_document(jsonb,uuid),public.customer_document_list(uuid),public.customer_document_content(uuid);
drop table private.customer_document_bytes;
drop table public.customer_documents;
