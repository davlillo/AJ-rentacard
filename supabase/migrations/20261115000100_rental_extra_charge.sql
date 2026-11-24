-- An approved inspection extra becomes a collectible document.
--
-- The approval of an extra only wrote status, amount, reason and version: no billing document
-- existed, so operationMoney never saw it (charged = sum of documents) and the amount was never
-- collectible. This migration adds the link and the command that creates the document.
--
-- The amount is never taken from the client: it is the amount the approval already decided on the
-- server (rental_extra_proposals.amount), protected by the version of the proposal.
--
-- No rental_periods row is created: a period is an occupancy fact with a GiST exclusion
-- constraint and drives rental_paid_through. An extra has no contractual date range.
alter table public.rental_extra_proposals
  add column document_id uuid unique references public.billing_documents,
  add column issued_on date,
  add column due_on date;

-- The command that issues the amount of an approved extra as a document of the reservation.
create function public.issue_rental_extra(payload jsonb, idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','rental.issue_extra','payload',payload);
  proposal public.rental_extra_proposals;
  booking public.reservations;
  customer public.customers;
  document public.billing_documents;
  value numeric;
  event_date date;
  due_date date;
  result jsonb;
begin
  -- Issuing an amount to collect is an expense decision on an order of a rental: both permissions.
  if not (public.has_permission('orders.write') and public.has_permission('expenses.write')) then
    raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  select * into proposal from public.rental_extra_proposals where id=(payload->>'proposalId')::uuid for update;
  if proposal.id is null then raise exception 'EXTRA_NOT_FOUND'; end if;
  if proposal.status<>'Aprobado' then raise exception 'EXTRA_NOT_APPROVED'; end if;
  -- The marker is written at insert time: an extra can be issued only once. This guard comes before
  -- the version, because an extra that was already issued says so whatever the version is.
  if proposal.document_id is not null or exists(
    select 1 from public.billing_documents d where d.source_key='rental-extra:'||proposal.id::text) then
    raise exception 'EXTRA_ALREADY_ISSUED'; end if;
  if (payload->>'expectedVersion')::integer is distinct from proposal.version then
    raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
  if proposal.amount is null then raise exception 'EXTRA_AMOUNT_REQUIRED'; end if;
  select * into booking from public.reservations where id=proposal.reservation_id for update;
  if booking.id is null then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if booking.status='Cancelada' then raise exception 'RENTAL_CANCELLED'; end if;
  if booking.status<>'Confirmada' then raise exception 'CONFIRMED_RESERVATION_REQUIRED'; end if;
  -- The amount is the one the approval decided, never one the client sends.
  value:=proposal.amount;
  if value is null or value<=0 or value<>round(value,2) or value::text in ('NaN','Infinity') then
    raise exception 'INVALID_BILLING_AMOUNT_DATE'; end if;
  begin
    event_date:=(payload->>'date')::date;
  exception when others then
    raise exception 'INVALID_BILLING_AMOUNT_DATE';
  end;
  begin
    due_date:=(payload->>'dueOn')::date;
  exception when others then
    raise exception 'INVALID_BILLING_AMOUNT_DATE';
  end;
  if event_date is null or not isfinite(event_date) or event_date>(now() at time zone 'America/El_Salvador')::date
    or due_date is null or not isfinite(due_date) or due_date<event_date then raise exception 'INVALID_BILLING_AMOUNT_DATE'; end if;
  if nullif(btrim(payload->>'reason'),'') is null then raise exception 'EXTRA_REASON_REQUIRED'; end if;
  select * into customer from public.customers where id=private.canonical_customer(booking.customer_id);
  if customer.id is null then raise exception 'INVALID_CUSTOMER'; end if;
  -- The document is inserted directly: the billing command cannot write the source_key and the
  -- billing documents are immutable.
  insert into public.billing_documents(customer_id,reservation_id,description,amount,issued_on,due_on,source_key,
    customer_snapshot,created_by)
  values(customer.id,booking.id,'Extra de inspección: '||btrim(proposal.description),value,event_date,due_date,
    'rental-extra:'||proposal.id::text,to_jsonb(customer)-'phone_key'-'document_key',auth.uid()) returning * into document;
  update public.rental_extra_proposals set document_id=document.id,issued_on=event_date,due_on=due_date,version=version+1
    where id=proposal.id returning * into proposal;
  result:=jsonb_build_object('proposal',to_jsonb(proposal),'document',to_jsonb(document));
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;
revoke all on function public.issue_rental_extra(jsonb,uuid) from public,anon;
grant execute on function public.issue_rental_extra(jsonb,uuid) to authenticated;
