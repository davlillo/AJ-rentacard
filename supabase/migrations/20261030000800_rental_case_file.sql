-- A rental has its own case, not every charge ever recorded on the same car.
create table private.rental_case_functions(signature text primary key,definition text not null);
insert into private.rental_case_functions select 'private.render_contract_pdf(public.rental_contracts)',
  pg_get_functiondef('private.render_contract_pdf(public.rental_contracts)'::regprocedure);
create function private.reservation_document_sources(reservation_id uuid)
returns table(document_id uuid,scope_amount numeric) language sql stable set search_path='' as $$
  select d.id,d.amount from public.billing_documents d where d.reservation_id=reservation_document_sources.reservation_id
  union all select l.document_id,sum(l.amount) from public.billing_document_lines l
    where l.reservation_id=reservation_document_sources.reservation_id group by l.document_id;
$$;
create function private.reservation_credit_sources(reservation_id uuid)
returns table(credit_id uuid,document_id uuid,scope_amount numeric) language sql stable set search_path='' as $$
  select c.id,c.document_id,c.amount from public.billing_credits c join public.billing_documents d on d.id=c.document_id
    where d.reservation_id=reservation_credit_sources.reservation_id
  union all select c.id,c.document_id,sum(s.amount) from public.billing_credit_lines s
    join public.billing_credits c on c.id=s.credit_id join public.billing_document_lines l on l.id=s.line_id
    where l.reservation_id=reservation_credit_sources.reservation_id group by c.id;
$$;
create function public.rental_case_file(reservation_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare booking public.reservations;result jsonb;begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  select * into booking from public.reservations r where r.id=rental_case_file.reservation_id;
  if booking.id is null then raise exception 'RESERVATION_NOT_FOUND';end if;
  result:=public.vehicle_case_file(booking.vehicle_id,null)||jsonb_build_object('orders','[]'::jsonb,'inspections','[]'::jsonb,
    'reservations',jsonb_build_array(to_jsonb(booking)),
    'files',coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at desc) from public.vehicle_files f
      where f.reservation_id=booking.id and (not f.financial or public.has_permission('expenses.read'))),'[]'),
    'commitments',coalesce((select jsonb_agg(to_jsonb(c)) from public.vehicle_commitments c where c.reservation_id=booking.id),'[]'));
  if public.has_permission('expenses.read') then result:=result||jsonb_build_object('quotes','[]'::jsonb,'costs','[]'::jsonb,'allocations','[]'::jsonb,
    'expenses',coalesce((select jsonb_agg(to_jsonb(e)) from public.expenses e where e.reservation_id=booking.id),'[]'),
    'documents',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('scope_amount',s.scope_amount,'scope_balance',s.scope_amount
      -coalesce((select sum(case a.kind when 'Aplicacion' then a.amount else -a.amount end) from private.reservation_payment_sources(booking.id) a where a.document_id=d.id),0)
      -coalesce((select sum(c.scope_amount) from private.reservation_credit_sources(booking.id) c where c.document_id=d.id),0)))
      from private.reservation_document_sources(booking.id) s join public.billing_documents d on d.id=s.document_id),'[]'),
    'applications',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('scope_amount',s.amount)) from private.reservation_payment_sources(booking.id) s
      join public.payment_applications a on a.id=s.id),'[]'),
    'payments',coalesce((select jsonb_agg(to_jsonb(p)) from public.customer_payments p where exists(select 1 from private.reservation_payment_sources(booking.id) a where a.payment_id=p.id)),'[]'));
  end if;
  return result;
end $$;
create function public.collect_document(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','billing.collect_document','payload',payload);
  document public.billing_documents;receipt jsonb;application jsonb;result jsonb;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  select * into document from public.billing_documents where id=(payload->>'documentId')::uuid for update;
  if document.id is null then raise exception 'DOCUMENT_NOT_FOUND';end if;
  if payload->>'paymentId' is null then
    receipt:=public.execute_billing_command('pay',payload||jsonb_build_object('customerId',document.customer_id),gen_random_uuid());
  else receipt:=jsonb_build_object('id',payload->>'paymentId');end if;
  application:=public.execute_billing_command('apply',payload||jsonb_build_object('paymentId',receipt->>'id'),gen_random_uuid());
  result:=jsonb_build_object('receipt',receipt,'application',application);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;
revoke all on function public.rental_case_file(uuid),public.collect_document(jsonb,uuid) from public,anon;
grant execute on function public.rental_case_file(uuid),public.collect_document(jsonb,uuid) to authenticated;
do $$ declare definition text;anchor text;begin
  definition:=pg_get_functiondef('private.render_contract_pdf(public.rental_contracts)'::regprocedure);
  anchor:='||(contract.booking_snapshot->>''ends_at'')';
  if position(anchor in definition)=0 then raise exception 'RENTAL_CONTRACT_SOURCE_MISMATCH';end if;
  definition:=replace(definition,anchor,'||(case when coalesce((contract.booking_snapshot->>''open_ended'')::boolean,false) then ''Sin fecha final acordada'' else contract.booking_snapshot->>''ends_at'' end)');
  anchor:='||E''\nPrecio previsto USD: ''||(contract.booking_snapshot->>''total'')';
  if position(anchor in definition)=0 then raise exception 'RENTAL_CONTRACT_SOURCE_MISMATCH';end if;
  definition:=replace(definition,anchor,'||E''\n''||(case when coalesce((contract.booking_snapshot->>''open_ended'')::boolean,false) then ''Precio final no definido. Tarifa diaria USD: ''||(contract.booking_snapshot->>''daily_rate'') else ''Precio previsto USD: ''||(contract.booking_snapshot->>''total'') end)');
  execute definition;
end $$;
