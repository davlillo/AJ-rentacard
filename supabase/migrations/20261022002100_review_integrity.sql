-- Forward-only repair of the five independently reproduced review defects.
-- No historical amounts, documents or linked identities are inferred or rewritten.
create table private.review_function_backups(signature text primary key,definition text not null);
insert into private.review_function_backups
select signature,pg_get_functiondef(signature::regprocedure) from unnest(array[
  'private.payment_import_preview(public.payment_imports)','private.expense_to_workshop_cost()',
  'public.execute_reservation_command(text,jsonb,uuid)','public.execute_rental_command(text,jsonb,uuid)',
  'public.budget_position(uuid,date)','public.contract_pdf(uuid,text)']) signature;

-- HU06: compare normalized receipt candidates inside the file as well as in the ledger.
create or replace function private.payment_import_preview(batch public.payment_imports) returns jsonb
language plpgsql stable set search_path='' as $$
declare raw jsonb;p jsonb;origin public.payment_import_origins;decision jsonb;status text;payment_id uuid;
  candidates jsonb;rows jsonb:='[]';error text;similar_rows jsonb;
begin
  for raw in select value from jsonb_array_elements(batch.rows) loop
    status:='Valida';p:=null;payment_id:=null;candidates:='[]';error:=null;similar_rows:='[]';
    decision:=batch.decisions->(raw->>'rowNumber');
    if decision->>'action'='exclude' and nullif(btrim(decision->>'reason'),'') is not null then status:='Excluida';
    else
      begin
        p:=private.normalize_import_payment(raw,batch.mapping);
        select * into origin from public.payment_import_origins where source_system=batch.source_system and source_key=p->>'sourceKey';
        if origin.id is not null then
          if (origin.fingerprint-'customerId')=(p-'customerId') and private.canonical_customer((origin.fingerprint->>'customerId')::uuid)=(p->>'customerId')::uuid then
            status:='Duplicada';payment_id:=origin.payment_id;
          else status:='Conflicto';error:='El origen ya existe con otros datos';end if;
        else
          select coalesce(jsonb_agg(existing.id),'[]') into candidates from public.customer_payments existing
            where private.canonical_customer(existing.customer_id)=(p->>'customerId')::uuid and existing.amount=(p->>'amount')::numeric
            and existing.paid_on=(p->>'date')::date and existing.method=p->>'method' and existing.account=p->>'account';
          select coalesce(jsonb_agg(previous->>'rowNumber'),'[]') into similar_rows from jsonb_array_elements(rows) previous
            where previous->>'status' not in ('Excluida','Rechazada','Conflicto')
            and previous->'payload'->>'customerId'=p->>'customerId' and previous->'payload'->>'amount'=p->>'amount'
            and previous->'payload'->>'date'=p->>'date' and previous->'payload'->>'method'=p->>'method'
            and previous->'payload'->>'account'=p->>'account';
          if jsonb_array_length(candidates)>0 or jsonb_array_length(similar_rows)>0 then
            status:='Ambigua';
            if decision->>'action'='link' and nullif(btrim(decision->>'reason'),'') is not null and candidates ? (decision->>'paymentId') then
              status:='Duplicada';payment_id:=(decision->>'paymentId')::uuid;
            elsif decision->>'action'='create' and nullif(btrim(decision->>'reason'),'') is not null then status:='Valida';end if;
          end if;
          if exists(select 1 from jsonb_array_elements(rows) previous where previous->>'status'<>'Excluida'
            and (previous->'payload'=p or (p->>'sourceKey' is not null and previous->'payload'->>'sourceKey'=p->>'sourceKey'))) then
            status:='Conflicto';error:='Origen o fila repetidos dentro del lote';end if;
        end if;
      exception when others then status:='Rechazada';error:=SQLERRM;
      end;
    end if;
    rows:=rows||jsonb_build_array(jsonb_build_object('rowNumber',raw->>'rowNumber','status',status,'payload',p,
      'paymentId',payment_id,'candidates',candidates,'similarRows',similar_rows,'error',error));
  end loop;
  return rows;
end;
$$;

-- HU10/HU24: a cash settlement refers to the acquisition, never acquires it again.
alter table public.expenses add column direct_purchase_cost_id uuid references public.workshop_costs;
create index expense_direct_purchase on public.expenses(direct_purchase_cost_id) where direct_purchase_cost_id is not null;
create or replace function private.expense_to_workshop_cost() returns trigger
language plpgsql security definer set search_path='' as $$
declare cost public.workshop_costs;paid numeric;
begin
  if new.direct_purchase_cost_id is not null then
    perform pg_advisory_xact_lock(6192,1);
    select * into cost from public.workshop_costs where id=new.direct_purchase_cost_id for update;
    if cost.id is null or cost.kind<>'Compra directa' or new.operation_id is distinct from cost.order_id
      or new.cost_center_id is not null then raise exception 'DIRECT_PURCHASE_DESTINATION_MISMATCH';end if;
    select coalesce(sum(amount),0) into paid from public.expenses where direct_purchase_cost_id=cost.id;
    if paid>cost.amount then raise exception 'DIRECT_PURCHASE_OVERPAYMENT';end if;
  elsif new.operation_id is not null then
    if exists(select 1 from public.workshop_costs where order_id=new.operation_id and kind='Compra directa'
      and lower(btrim(source_reference))=lower(btrim(new.support))) then
      raise exception 'DIRECT_PURCHASE_PAYMENT_REQUIRED';
    end if;
    insert into public.workshop_costs(order_id,kind,description,quantity,unit_cost,amount,expense_id,occurred_at,created_by)
    values(new.operation_id,'Gasto',new.concept,1,new.amount,new.amount,new.id,new.date,new.created_by);
  end if;
  return new;
end;
$$;
create function public.pay_direct_purchase(cost_id uuid,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare cost public.workshop_costs;prior private.command_results;result jsonb;paid_on date;value numeric;
  request jsonb:=jsonb_build_object('command','cost.pay','costId',cost_id,'payload',payload);
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  select * into cost from public.workshop_costs where id=cost_id for update;
  if cost.id is null or cost.kind<>'Compra directa' then raise exception 'DIRECT_PURCHASE_REQUIRED';end if;
  paid_on:=(payload->>'date')::date;value:=(payload->>'amount')::numeric;
  if paid_on is null or not isfinite(paid_on) or paid_on<cost.occurred_at
    or paid_on>(now() at time zone 'America/El_Salvador')::date then raise exception 'INVALID_DATE';end if;
  if value is null or value<=0 or value<>round(value,2) or value::text in ('NaN','Infinity','-Infinity') then raise exception 'INVALID_AMOUNT';end if;
  insert into public.expenses(date,concept,category,amount,method,account,operation_id,support,disposition,direct_purchase_cost_id,created_by)
  values(paid_on,left('Pago de compra: '||cost.description,2000),'Pago a proveedor',value,payload->>'method',btrim(payload->>'account'),
    cost.order_id,cost.source_reference,cost.disposition,cost.id,auth.uid()) returning to_jsonb(expenses.*) into result;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;
revoke all on function public.pay_direct_purchase(uuid,jsonb,uuid) from public,anon;
grant execute on function public.pay_direct_purchase(uuid,jsonb,uuid) to authenticated;

-- HU13/HU17: retain the original implementation privately, validate releases before dispatch.
alter function public.execute_reservation_command(text,jsonb,uuid) set schema private;
alter function private.execute_reservation_command(text,jsonb,uuid) rename to reservation_command_before_review;
revoke all on function private.reservation_command_before_review(text,jsonb,uuid) from public,anon,authenticated;
do $$ declare definition text;anchor text;begin
  definition:=pg_get_functiondef('private.reservation_command_before_review(text,jsonb,uuid)'::regprocedure);
  anchor:='set ends_at=clock_timestamp(),reason=btrim(payload->>''reason'') where id=';
  if position(anchor in definition)=0 then raise exception 'REVIEW_MIGRATION_SOURCE_MISMATCH';end if;
  -- now() precedes clock_timestamp() inside a transaction: deactivate the completed block
  -- so its own just-recorded ending cannot keep the vehicle held during the readiness check.
  execute replace(definition,anchor,'set ends_at=clock_timestamp(),active=false,reason=btrim(payload->>''reason'') where id=');
end $$;
create function public.execute_reservation_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare block public.vehicle_commitments;car public.vehicles;prior private.command_results;returned_id uuid;
begin
  if not public.has_permission('orders.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  -- Let the original implementation check request equality and replay completed commands.
  if not found and command='finish_block' then
    select * into block from public.vehicle_commitments where id=(payload->>'blockId')::uuid for update;
    if block.id is null or not block.active then raise exception 'BLOCK_CANNOT_BE_FINISHED';end if;
    select * into car from public.vehicles where id=block.vehicle_id for update;
    if car.readiness_hold then
      select i.reservation_id into returned_id from public.rental_inspections i join public.reservations r on r.id=i.reservation_id
        where r.vehicle_id=car.id and r.rental_state='Devuelto' and i.kind='Retorno' order by i.occurred_at desc,i.id desc limit 1;
      if block.kind<>'Limpieza' or returned_id is null or block.reservation_id is distinct from returned_id then
        raise exception 'RETURN_CLEANING_REQUIRED';end if;
    end if;
  end if;
  return private.reservation_command_before_review(command,payload,idempotency_key);
end;
$$;
revoke all on function public.execute_reservation_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_reservation_command(text,jsonb,uuid) to authenticated;

-- A physical early return ends occupancy, not the contractual price/interval snapshot.
do $$ declare definition text;anchor text;replacement text;begin
  definition:=pg_get_functiondef('public.execute_rental_command(text,jsonb,uuid)'::regprocedure);
  anchor:='clean_start:=greatest(clock_timestamp(),booking.ends_at);clean_end:=';
  replacement:='update public.vehicle_commitments set active=false where reservation_id=booking.id and kind=''Limpieza'';
    update public.vehicle_commitments set ends_at=least(ends_at,greatest(clock_timestamp(),starts_at+interval ''1 microsecond''))
    where reservation_id=booking.id and kind=''Reserva'';
    clean_start:=clock_timestamp();clean_end:=';
  if position(anchor in definition)=0 then raise exception 'REVIEW_MIGRATION_SOURCE_MISMATCH';end if;
  execute replace(definition,anchor,replacement);
end $$;

-- HU29: reconstruct authorization from audited state at cutoff, and date every allocation.
create or replace function public.budget_position(budget_id uuid,cutoff date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare plan public.operating_budgets;committed numeric;executed numeric;detail jsonb;boundary timestamptz;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if cutoff is null or not isfinite(cutoff) then raise exception 'CUTOFF_REQUIRED';end if;
  boundary:=(cutoff+1)::timestamp at time zone 'America/El_Salvador';
  select * into plan from public.operating_budgets where id=budget_id;
  if plan.id is null then raise exception 'BUDGET_NOT_FOUND';end if;
  select coalesce(sum(greatest((history.data->>'quantity')::numeric-coalesce(receipts.quantity,0),0)
    *(history.data->>'unit_cost')::numeric),0) into committed
    from public.budget_purchase_links l join public.purchase_orders p on p.id=l.purchase_id
    cross join lateral(select a.after_data data from public.audit_events a where a.entity='purchase_orders'
      and a.entity_id=p.id::text and a.created_at<boundary order by a.created_at desc,a.id desc limit 1) history
    left join lateral(select sum(m.quantity) quantity from public.stock_movements m where m.purchase_id=p.id
      and m.kind='Entrada' and m.created_at<boundary) receipts on true
    where l.budget_id=plan.id and l.created_at<boundary and plan.created_at<boundary
      and history.data->>'status' in ('Autorizada','Recibida');
  select coalesce(jsonb_agg(to_jsonb(rows)),'[]'),coalesce(sum(rows.amount),0) into detail,executed from (
    select o.id::text id,'Recepcion'::text kind,o.amount from public.supplier_obligations o join public.budget_purchase_links l on l.purchase_id=o.purchase_id
      where l.budget_id=plan.id and o.created_at<boundary and l.created_at<boundary and plan.created_at<boundary
        and (o.created_at at time zone 'America/El_Salvador')::date between plan.starts_on and plan.ends_on
    union all select e.id,'Gasto independiente',e.amount from public.budget_expense_links l join public.expenses e on e.id=l.expense_id
      where l.budget_id=plan.id and l.purchase_id is null and e.date between plan.starts_on and least(plan.ends_on,cutoff)
      and e.created_at<boundary and l.created_at<boundary and plan.created_at<boundary
  ) rows;
  return jsonb_build_object('budget',to_jsonb(plan),'cutoff',cutoff,'authorized',case when plan.created_at<boundary then plan.authorized else 0 end,
    'committed',round(committed,2),'executed',executed,
    'available',case when plan.created_at<boundary then plan.authorized else 0 end-round(committed,2)-executed,
    'sources',detail,'policy','received-obligation-plus-independent-expense-v1');
end;
$$;

-- HU23: generate a bounded, plain PDF from the immutable version on the trusted side.
-- No upload/parser boundary or browser-supplied content is persisted as a contract.
create function private.contract_winansi_hex(value text) returns text
language plpgsql immutable set search_path='' as $$
declare result text:='';idx integer;code integer;character text;extended integer;
begin
  for idx in 1..length(value) loop
    character:=substring(value from idx for 1);code:=ascii(character);
    if not(code between 32 and 126 or code between 160 and 255) then
      extended:=strpos('€?‚ƒ„…†‡ˆ‰Š‹Œ?Ž??‘’“”•–—˜™š›œ?žŸ',character);
      if extended=0 then raise exception 'CONTRACT_TEXT_ENCODING_UNSUPPORTED';end if;
      code:=127+extended;
    end if;
    result:=result||lpad(to_hex(code),2,'0');
  end loop;
  return result;
end;
$$;
create function private.render_contract_pdf(contract public.rental_contracts) returns bytea
language plpgsql stable set search_path='' as $$
declare lines text[]:='{}';line text;part text;body text;objects text[];offsets integer[]:='{}';
  document text:=E'%PDF-1.4\n';kids text:='';pages integer;page integer;idx integer;xref integer;result bytea;
begin
  body:='AJ Rentacar - Contrato de alquiler / V'||contract.revision||E'\n'||contract.id||E'\n'
    ||'Version UTC: '||(contract.created_at at time zone 'UTC')::text||E'Z\n\n'
    ||'Cliente: '||coalesce(contract.booking_snapshot->'customer_snapshot'->>'name','')||E'\n'
    ||'Documento: '||coalesce(contract.booking_snapshot->'customer_snapshot'->>'document','')||E'\n'
    ||'Telefono: '||coalesce(contract.booking_snapshot->'customer_snapshot'->>'phone','')||E'\n'
    ||'Vehiculo: '||coalesce(contract.booking_snapshot->'vehicle_snapshot'->>'plate','')||' / '
    ||coalesce(contract.booking_snapshot->'vehicle_snapshot'->>'brand','')||' '
    ||coalesce(contract.booking_snapshot->'vehicle_snapshot'->>'model','')||E'\n'
    ||'Desde: '||(contract.booking_snapshot->>'starts_at')||E'\nHasta: '||(contract.booking_snapshot->>'ends_at')
    ||E'\nPrecio previsto USD: '||(contract.booking_snapshot->>'total')||E'\n\nCondiciones de esta version:\n'||contract.conditions;
  if length(body)>200000 then raise exception 'DOCUMENT_TOO_LARGE';end if;
  foreach line in array string_to_array(replace(replace(body,E'\r\n',E'\n'),E'\r',E'\n'),E'\n') loop
    line:=replace(line,E'\t','    ');
    if line='' then lines:=array_append(lines,'');end if;
    while length(line)>0 loop
      lines:=array_append(lines,left(line,88));line:=substring(line from 89);
    end loop;
  end loop;
  pages:=greatest(1,ceil(cardinality(lines)/48.0)::integer);
  for page in 1..pages loop kids:=kids||(4+(page-1)*2)||' 0 R ';end loop;
  objects:=array['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count '||pages||' /Kids ['||kids||'] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'];
  for page in 1..pages loop
    body:=E'BT /F1 9 Tf 14 TL 48 790 Td\n';
    for idx in ((page-1)*48+1)..least(page*48,cardinality(lines)) loop
      -- Hex strings prevent text from becoming PDF operators; WinAnsi preserves Spanish accents.
      part:=private.contract_winansi_hex(lines[idx]);
      body:=body||'<'||part||E'> Tj T*\n';
    end loop;
    body:=body||E'ET\n';
    objects:=array_append(objects,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents '
      ||(5+(page-1)*2)||' 0 R >>');
    objects:=array_append(objects,'<< /Length '||octet_length(body)||E' >>\nstream\n'||body||'endstream');
  end loop;
  for idx in 1..cardinality(objects) loop
    offsets:=array_append(offsets,octet_length(document));
    document:=document||idx||E' 0 obj\n'||objects[idx]||E'\nendobj\n';
  end loop;
  xref:=octet_length(document);document:=document||E'xref\n0 '||(cardinality(objects)+1)||E'\n0000000000 65535 f \n';
  foreach idx in array offsets loop document:=document||lpad(idx::text,10,'0')||E' 00000 n \n';end loop;
  document:=document||E'trailer\n<< /Size '||(cardinality(objects)+1)||E' /Root 1 0 R >>\nstartxref\n'||xref||E'\n%%EOF\n';
  result:=convert_to(document,'UTF8');return result;
end;
$$;
create or replace function public.contract_pdf(contract_id uuid,pdf_base64 text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare file private.contract_files;contract public.rental_contracts;content bytea;
begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if pdf_base64 is not null then raise exception 'INVALID_PDF_UPLOAD';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into contract from public.rental_contracts where id=contract_id;
  if contract.id is null then raise exception 'CONTRACT_NOT_FOUND';end if;
  select * into file from private.contract_files where contract_files.contract_id=contract_pdf.contract_id;
  if file.contract_id is null then
    if not public.has_permission('orders.write') then return null;end if;
    content:=private.render_contract_pdf(contract);
    insert into private.contract_files values(contract.id,content,encode(sha256(content),'hex')) returning * into file;
  end if;
  return jsonb_build_object('hash',file.file_hash,'base64',encode(file.content,'base64'));
end;
$$;
revoke all on function private.render_contract_pdf(public.rental_contracts) from public,anon,authenticated;
revoke all on function private.contract_winansi_hex(text) from public,anon,authenticated;
