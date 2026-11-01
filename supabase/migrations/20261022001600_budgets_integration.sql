-- HU29/HU30: optional spending plans and a retryable, exactly-once business inbox.
create table public.operating_budgets (
  id uuid primary key default gen_random_uuid(),name text not null check(length(btrim(name))>0),
  area text not null,category text not null,starts_on date not null,ends_on date not null,
  authorized numeric(18,2) not null check(authorized>=0 and authorized::text not in ('NaN','Infinity')),
  created_by uuid not null references auth.users,created_at timestamptz not null default now(),check(ends_on>=starts_on)
);
create table public.budget_purchase_links (
  id uuid primary key default gen_random_uuid(),budget_id uuid not null references public.operating_budgets,
  purchase_id uuid not null unique references public.purchase_orders,created_by uuid not null references auth.users,created_at timestamptz not null default now()
);
create table public.budget_expense_links (
  id uuid primary key default gen_random_uuid(),budget_id uuid not null references public.operating_budgets,
  expense_id text not null unique references public.expenses,purchase_id uuid references public.purchase_orders,
  reason text not null check(length(btrim(reason))>0),created_by uuid not null references auth.users,created_at timestamptz not null default now()
);
create table public.integration_inbox (
  id uuid primary key default gen_random_uuid(),source text not null check(length(btrim(source))>0),external_id text not null check(length(btrim(external_id))>0),
  payload jsonb not null,payload_hash text not null,state text not null default 'Pendiente' check(state in ('Pendiente','Error','Procesado')),
  attempts integer not null default 0,last_error text,result jsonb,
  created_by uuid not null references auth.users,created_at timestamptz not null default now(),unique(source,external_id)
);
do $$ declare tbl text;begin
  foreach tbl in array array['operating_budgets','budget_purchase_links','budget_expense_links','integration_inbox'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from anon,authenticated',tbl);
    execute format('grant select on public.%I to authenticated',tbl);
    execute format('create policy optional_module_read on public.%I for select to authenticated using(exists(select 1 from public.user_roles where user_id=auth.uid() and role=''owner''))',tbl);
    execute format('create trigger optional_module_audit after insert or update on public.%I for each row execute function private.audit_change()',tbl);
  end loop;
end $$;
create trigger operating_budget_immutable before update or delete on public.operating_budgets for each row execute function private.immutable_quote_record();
create trigger budget_purchase_link_immutable before update or delete on public.budget_purchase_links for each row execute function private.immutable_quote_record();
create trigger budget_expense_link_immutable before update or delete on public.budget_expense_links for each row execute function private.immutable_quote_record();
create function public.budget_position(budget_id uuid,cutoff date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare plan public.operating_budgets;committed numeric;executed numeric;detail jsonb;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if cutoff is null or not isfinite(cutoff) then raise exception 'CUTOFF_REQUIRED';end if;
  select * into plan from public.operating_budgets where id=budget_id;
  if plan.id is null then raise exception 'BUDGET_NOT_FOUND';end if;
  select coalesce(sum(greatest(p.quantity-coalesce(receipts.quantity,0),0)*p.unit_cost),0) into committed
    from public.budget_purchase_links l join public.purchase_orders p on p.id=l.purchase_id
    left join lateral(select sum(m.quantity) quantity from public.stock_movements m where m.purchase_id=p.id
      and m.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador') receipts on true
    where l.budget_id=plan.id and p.status in ('Autorizada','Recibida') and p.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador';
  select coalesce(jsonb_agg(to_jsonb(rows)),'[]'),coalesce(sum(rows.amount),0) into detail,executed from (
    select o.id::text id,'Recepcion'::text kind,o.amount from public.supplier_obligations o join public.budget_purchase_links l on l.purchase_id=o.purchase_id
      where l.budget_id=plan.id and o.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'
    union all select e.id,'Gasto independiente',e.amount from public.budget_expense_links l join public.expenses e on e.id=l.expense_id
      where l.budget_id=plan.id and l.purchase_id is null and e.date between plan.starts_on and least(plan.ends_on,cutoff)
      and e.created_at<(cutoff+1)::timestamp at time zone 'America/El_Salvador'
  ) rows;
  return jsonb_build_object('budget',to_jsonb(plan),'cutoff',cutoff,'authorized',plan.authorized,'committed',round(committed,2),
    'executed',executed,'available',plan.authorized-round(committed,2)-executed,'sources',detail,'policy','received-obligation-plus-independent-expense-v1');
end;
$$;
create function public.execute_optional_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','optional.'||command,'payload',payload);
  event public.integration_inbox;result jsonb;business_result jsonb;hash text;plan uuid;purchase uuid;
begin
  if not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if command is null or command not in ('budget','link_purchase','link_expense','enqueue','process') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_OPTIONAL_COMMAND';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='budget' then
    insert into public.operating_budgets(name,area,category,starts_on,ends_on,authorized,created_by)
    values(btrim(payload->>'name'),payload->>'area',payload->>'category',(payload->>'startsOn')::date,(payload->>'endsOn')::date,(payload->>'authorized')::numeric,auth.uid())
      returning to_jsonb(operating_budgets.*) into result;
  elsif command='link_purchase' then
    insert into public.budget_purchase_links(budget_id,purchase_id,created_by) values((payload->>'budgetId')::uuid,(payload->>'purchaseId')::uuid,auth.uid())
      returning to_jsonb(budget_purchase_links.*) into result;
  elsif command='link_expense' then
    plan:=(payload->>'budgetId')::uuid;purchase:=(payload->>'purchaseId')::uuid;
    if purchase is not null and not exists(select 1 from public.budget_purchase_links where budget_id=plan and purchase_id=purchase) then raise exception 'PURCHASE_BUDGET_MISMATCH';end if;
    if purchase is not null and (select amount from public.expenses where id=payload->>'expenseId')+
      coalesce((select sum(e.amount) from public.budget_expense_links l join public.expenses e on e.id=l.expense_id where l.purchase_id=purchase),0)
      >coalesce((select sum(amount) from public.supplier_obligations where purchase_id=purchase),0) then raise exception 'LINKED_PAYMENT_EXCEEDS_RECEIVED_PURCHASE';end if;
    insert into public.budget_expense_links(budget_id,expense_id,purchase_id,reason,created_by)
    values(plan,payload->>'expenseId',purchase,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(budget_expense_links.*) into result;
  elsif command='enqueue' then
    hash:=encode(sha256(convert_to((payload->'event')::text,'UTF8')),'hex');
    select * into event from public.integration_inbox where source=btrim(execute_optional_command.payload->>'source') and external_id=btrim(execute_optional_command.payload->>'externalId');
    if event.id is not null then
      if event.payload_hash<>hash then raise exception 'EXTERNAL_EVENT_PAYLOAD_CONFLICT';end if;
    else
      if jsonb_typeof(payload->'event') is distinct from 'object' then raise exception 'EVENT_OBJECT_REQUIRED';end if;
      insert into public.integration_inbox(source,external_id,payload,payload_hash,created_by)
      values(btrim(payload->>'source'),btrim(payload->>'externalId'),payload->'event',hash,auth.uid()) returning * into event;
    end if;
    result:=to_jsonb(event);
  else
    select * into event from public.integration_inbox where id=(execute_optional_command.payload->>'eventId')::uuid for update;
    if event.id is null then raise exception 'EVENT_NOT_FOUND';end if;
    if event.state<>'Procesado' then
      begin
        business_result:=public.execute_command('record_expense',event.payload,event.id);
        update public.integration_inbox set state='Procesado',result=business_result,attempts=attempts+1,last_error=null where id=event.id returning * into event;
      exception when others then
        update public.integration_inbox set state='Error',attempts=attempts+1,last_error=SQLSTATE||':'||SQLERRM where id=event.id returning * into event;
      end;
    end if;
    result:=to_jsonb(event);
  end if;
  -- A failed process attempt must be retryable with a new request key; successful events always replay their result.
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end;
$$;
revoke all on function public.budget_position(uuid,date),public.execute_optional_command(text,jsonb,uuid) from public,anon;
grant execute on function public.budget_position(uuid,date),public.execute_optional_command(text,jsonb,uuid) to authenticated;
