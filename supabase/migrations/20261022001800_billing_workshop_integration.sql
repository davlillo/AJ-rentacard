-- Once documents exist, operational delivery must use the ledger, never a stale paid field.
alter function private.delivery_checklist(text) rename to delivery_checklist_before_billing;
create function private.delivery_checklist(order_id text) returns jsonb language plpgsql stable set search_path='' as $$
declare checklist jsonb;balance numeric;document_count integer;unbilled boolean;
begin
  checklist:=private.delivery_checklist_before_billing(order_id);
  select count(*),coalesce(sum(private.document_balance(d.id,'infinity'::date)),0) into document_count,balance
    from public.billing_documents d where d.order_id=delivery_checklist.order_id;
  select o.estimate>0 and v.ownership='Cliente' and document_count=0 into unbilled from public.work_orders o
    join public.vehicles v on v.id=o.vehicle_id where o.id=order_id;
  return checklist||jsonb_build_object('estimatedUnpaid',balance,'balancePolicy','immutable-document-ledger-v1','unbilledEstimate',unbilled,
    'pendingEstimate',case when unbilled then coalesce(checklist->>'pendingEstimate','Cargo del alcance aprobado pendiente de emitir') else checklist->>'pendingEstimate' end);
end;
$$;
